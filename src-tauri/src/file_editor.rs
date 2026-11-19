//! The file editor chosen in Options (`layout.fileEditor`): a command checked
//! for a safe alphabet, refused when it would run the file instead of opening
//! it, found on disk and started without a shell, with the file and line in
//! the form its family of editors understands.

use std::ffi::OsString;
use std::path::{Path, PathBuf};

/// Programs that would run (shells, interpreters, launchers, privilege tools)
/// or destroy the file they get, never open it: refused as the editor.
const DENIED: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "csh", "tcsh", "php", "python", "node", "nodejs", "deno",
    "bun", "ruby", "perl", "lua", "tclsh", "env", "exec", "xargs", "nohup", "nice", "timeout", "sudo", "doas",
    "pkexec", "su", "rm", "unlink", "shred", "truncate", "dd", "cmd", "powershell", "pwsh", "wscript", "cscript",
    "osascript",
];

/// Non-empty, only `[A-Za-z0-9/._~-]`, not starting with `-`.
pub fn valid_command(cmd: &str) -> bool {
    !cmd.is_empty()
        && !cmd.starts_with('-')
        && cmd.chars().all(|c| c.is_ascii_alphanumeric() || "/._~-".contains(c))
}

/// The program's name without what varies between installs: lowercase, no
/// launcher extension (`.sh`, `.cmd`, `.exe`, `.bat`) and no trailing version
/// or `64` (`php8.2` and `phpstorm64.exe` are `php` and `phpstorm`).
pub fn family(program: &Path) -> String {
    let name = program
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = [".sh", ".cmd", ".exe", ".bat"]
        .iter()
        .find_map(|e| name.strip_suffix(e))
        .unwrap_or(&name);
    // Digits and dots at the end: a version, and the `64` of a 64-bit launcher.
    name.trim_end_matches(|c: char| c.is_ascii_digit() || c == '.')
        .to_string()
}

/// The program to run for `cmd`, as both saving it in Options and opening a
/// file check it: a safe alphabet, a path only from `/` or `~/` (never one
/// relative to desk's own folder), never a program that would run or delete
/// the file, and an executable found on disk or on PATH.
pub fn program(cmd: &str, home: &Path) -> Result<PathBuf, String> {
    if cmd.is_empty() {
        return Err(tr!("nie wybrano edytora plików", "no file editor chosen").to_string());
    }
    if !valid_command(cmd) || (cmd.contains('/') && !cmd.starts_with('/') && !cmd.starts_with("~/")) {
        return Err(tr!(format!("zła komenda edytora {cmd}"), format!("bad editor command {cmd}")));
    }
    if DENIED.contains(&family(Path::new(cmd)).as_str()) {
        return Err(tr!(
            format!("ten program uruchomiłby plik, a nie go otworzył: {cmd}"),
            format!("this program would run the file, not open it: {cmd}")
        ));
    }
    resolve(cmd, home)
}

/// The executable for `cmd`: `~/` expanded; a path must be an executable
/// file, a bare name is looked up on PATH.
fn resolve(cmd: &str, home: &Path) -> Result<PathBuf, String> {
    let expanded = match cmd.strip_prefix("~/") {
        Some(rest) => home.join(rest),
        None => PathBuf::from(cmd),
    };
    expanded
        .to_str()
        .and_then(crate::agents::which)
        .ok_or_else(|| tr!(format!("nie ma programu {cmd}"), format!("no program {cmd}")))
}

/// Arguments that open `file` at `line`, by the program's family.
pub fn args(program: &Path, file: &Path, line: u32) -> Vec<OsString> {
    let at = || {
        let mut s = file.as_os_str().to_owned();
        s.push(format!(":{line}"));
        s
    };
    match family(program).as_str() {
        "subl" | "zed" => vec![at()],
        "code" | "cursor" | "codium" => vec!["--goto".into(), at()],
        "phpstorm" | "idea" | "webstorm" | "pycharm" | "goland" | "rider" | "clion" => {
            vec!["--line".into(), line.to_string().into(), file.as_os_str().to_owned()]
        }
        _ => vec![file.as_os_str().to_owned()],
    }
}

/// Start the configured editor on `file` (already inside the project) at `line`.
pub fn open(cmd: &str, home: &Path, file: &Path, line: u32) -> Result<(), String> {
    use std::process::Stdio;
    let program = program(cmd, home)?;
    let mut child = std::process::Command::new(&program)
        .args(args(&program, file, line))
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    // Launchers (subl, code, JetBrains) exit at once: reap them, no zombies.
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn valid_commands() {
        for ok in ["subl", "code", "/usr/bin/subl", "~/bin/phpstorm", "idea.sh"] {
            assert!(valid_command(ok), "{ok}");
        }
        for bad in ["subl; rm", "sub l", "-x", "", "$(x)"] {
            assert!(!valid_command(bad), "{bad}");
        }
    }

    #[test]
    fn args_by_family() {
        let f = Path::new("/p/a.php");
        let a = |p: &str| args(Path::new(p), f, 7);
        let jetbrains = vec![OsString::from("--line"), "7".into(), "/p/a.php".into()];
        assert_eq!(a("/usr/bin/subl"), vec![OsString::from("/p/a.php:7")]);
        assert_eq!(a("code"), vec![OsString::from("--goto"), "/p/a.php:7".into()]);
        assert_eq!(a("~/bin/phpstorm"), jetbrains);
        assert_eq!(a("vim"), vec![OsString::from("/p/a.php")]);
        // Launchers and their Windows forms are the same family.
        assert_eq!(a("/opt/idea/bin/idea.sh"), jetbrains);
        assert_eq!(a("phpstorm64.exe"), jetbrains);
        assert_eq!(a("code.cmd"), vec![OsString::from("--goto"), "/p/a.php:7".into()]);
    }

    /// An executable file `name` in `dir`.
    fn executable(dir: &Path, name: &str) -> PathBuf {
        let p = dir.join(name);
        std::fs::write(&p, "").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        p
    }

    #[test]
    fn program_expands_home_and_needs_an_executable() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("bin")).unwrap();
        let ed = executable(&home.path().join("bin"), "ed");
        assert_eq!(program("~/bin/ed", home.path()).unwrap(), ed);
        assert_eq!(program(ed.to_str().unwrap(), home.path()).unwrap(), ed);
        assert!(program("~/bin/none", home.path()).is_err());
        #[cfg(unix)]
        {
            std::fs::write(home.path().join("bin/plain"), "").unwrap();
            assert!(program("~/bin/plain", home.path()).is_err());
        }
        // A bare name is looked up on PATH.
        assert!(program("no-such-editor-for-desk", home.path()).is_err());
        assert!(resolve("no-such-editor-for-desk", home.path()).is_err());
    }

    #[test]
    fn program_refuses_bad_commands() {
        let home = tempfile::tempdir().unwrap();
        std::fs::create_dir(home.path().join("bin")).unwrap();
        executable(&home.path().join("bin"), "subl");
        for bad in ["", "subl; rm", "sub l", "-x", "$(x)", "bin/subl", "./subl", "../subl"] {
            assert!(program(bad, home.path()).is_err(), "{bad}");
        }
    }

    #[test]
    fn program_refuses_what_would_run_or_delete_the_file() {
        let home = tempfile::tempdir().unwrap();
        for bad in ["php", "php8.2", "PHP", "python3", "python3.12", "/bin/sh", "rm", "node.exe", "env", "~/bin/bash"] {
            let e = program(bad, home.path()).unwrap_err();
            assert!(e.contains("uruchomiłby plik"), "{bad}: {e}");
        }
    }

    #[test]
    fn open_refuses_empty_bad_and_running_commands() {
        let home = tempfile::tempdir().unwrap();
        let f = Path::new("/p/a.php");
        assert!(open("", home.path(), f, 1).is_err());
        assert!(open("subl; rm -rf ~", home.path(), f, 1).is_err());
        assert!(open("php", home.path(), f, 1).unwrap_err().contains("uruchomiłby plik"));
    }
}
