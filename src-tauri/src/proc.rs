//! Running a child process with a time limit.

use std::path::Path;
use std::time::Duration;

/// Run a program without a terminal and collect its stdout; killed after
/// `timeout`. A non-zero exit gives its trimmed stderr.
pub fn run(program: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let (status, stdout, stderr) = exec(program, args, timeout)?;
    if status.success() {
        Ok(String::from_utf8_lossy(&stdout).into_owned())
    } else {
        let text = String::from_utf8_lossy(&stderr).trim().to_string();
        if !text.is_empty() {
            return Err(text);
        }
        let name = program.file_name().map_or_else(|| program.to_string_lossy(), |n| n.to_string_lossy());
        Err(match status.code() {
            Some(n) => tr!(format!("{name} zakończył się kodem {n}"), format!("{name} exited with code {n}")),
            None => tr!(format!("{name} został przerwany"), format!("{name} was terminated")),
        })
    }
}

/// Like [`run`], but any exit is an answer: `(code, stdout, stderr)`, the
/// code -1 when a signal ended it. Err only when it could not start or ran
/// past `timeout`.
pub fn run_status(program: &Path, args: &[&str], timeout: Duration) -> Result<(i32, String, String), String> {
    let (status, stdout, stderr) = exec(program, args, timeout)?;
    Ok((
        status.code().unwrap_or(-1),
        String::from_utf8_lossy(&stdout).into_owned(),
        String::from_utf8_lossy(&stderr).into_owned(),
    ))
}

fn exec(
    program: &Path,
    args: &[&str],
    timeout: Duration,
) -> Result<(std::process::ExitStatus, Vec<u8>, Vec<u8>), String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(program)
        .args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Drain the pipes on threads so a chatty child cannot block on a full pipe.
    let mut out = child.stdout.take().unwrap();
    let mut err = child.stderr.take().unwrap();
    let out_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = out.read_to_end(&mut b);
        b
    });
    let err_t = std::thread::spawn(move || {
        let mut b = Vec::new();
        let _ = err.read_to_end(&mut b);
        b
    });
    let deadline = std::time::Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(s)) => break Ok(s),
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                // Threads end with the pipes; nothing more to read.
                return Err(timeout_message(timeout));
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(20)),
            Err(e) => break Err(e.to_string()),
        }
    };
    let status = status?;
    let stdout = out_t.join().unwrap_or_default();
    let stderr = err_t.join().unwrap_or_default();
    Ok((status, stdout, stderr))
}

/// "Did not answer" with the wait that really ran out (whole seconds, rounded up).
pub fn timeout_message(timeout: Duration) -> String {
    let s = timeout.as_secs() + u64::from(timeout.subsec_nanos() > 0);
    tr!(format!("serwer nie odpowiada ({s} s)"), format!("server did not answer ({s} s)"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn run_times_out_and_kills() {
        let t = std::time::Instant::now();
        let r = run(Path::new("sleep"), &["5"], Duration::from_secs(1));
        assert!(t.elapsed() < Duration::from_secs(3));
        let e = r.unwrap_err();
        assert!(e.contains("1 s"), "{e}");
    }

    #[test]
    fn timeout_message_names_the_real_wait() {
        assert!(timeout_message(Duration::from_secs(3)).contains("(3 s)"));
        assert!(timeout_message(Duration::from_secs(30)).contains("(30 s)"));
    }

    #[cfg(unix)]
    #[test]
    fn run_failure_without_stderr_names_the_exit_code() {
        let e = run(Path::new("sh"), &["-c", "exit 3"], Duration::from_secs(2)).unwrap_err();
        assert!(e.contains('3'), "{e}");
        assert!(e.contains("sh"), "{e}");
        assert!(!e.contains("docker"), "{e}");
    }

    #[cfg(unix)]
    #[test]
    fn run_returns_stdout_and_stderr_on_failure() {
        assert_eq!(run(Path::new("sh"), &["-c", "echo hi"], Duration::from_secs(2)).unwrap(), "hi\n");
        let e = run(Path::new("sh"), &["-c", "echo boom >&2; exit 3"], Duration::from_secs(2)).unwrap_err();
        assert_eq!(e, "boom");
    }

    #[cfg(unix)]
    #[test]
    fn run_status_returns_any_exit() {
        let r = run_status(Path::new("sh"), &["-c", "echo out; echo err >&2; exit 1"], Duration::from_secs(2));
        assert_eq!(r.unwrap(), (1, "out\n".to_string(), "err\n".to_string()));
        let e = run_status(Path::new("sleep"), &["5"], Duration::from_secs(1)).unwrap_err();
        assert!(e.contains("1 s"), "{e}");
    }
}
