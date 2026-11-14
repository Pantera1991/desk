//! desk-fans: run as root through the sudoers rule desk installs
//! (/etc/sudoers.d/desk-fans), which allows exactly `level 40` … `level 100`
//! (fan_control::LEVELS) and `auto`. `level N` puts every fan at N% of its
//! maximum, `auto` gives them back to macOS,
//! `version` prints the protocol desk checks and `probe` what this Mac's fans
//! read (both without root; they write nothing). Nothing else is accepted, so
//! the rule cannot be used to write any other SMC key.

// The shared files carry more than the helper uses (desk reads with them too).
#![allow(dead_code)]

#[path = "../src/fan_control.rs"]
mod fan_control;
#[cfg(target_os = "macos")]
#[path = "../src/smc.rs"]
mod smc;

#[derive(Debug, PartialEq)]
enum Cmd {
    Version,
    Probe,
    Auto,
    Level(u8),
}

/// The arguments after the program's name. A level is only one of LEVELS
/// spelled exactly so ("70", not "070" or "+70").
fn parse(args: &[&str]) -> Option<Cmd> {
    match args {
        ["version"] => Some(Cmd::Version),
        ["probe"] => Some(Cmd::Probe),
        ["auto"] => Some(Cmd::Auto),
        ["level", n] => fan_control::LEVELS.into_iter().find(|l| l.to_string() == *n).map(Cmd::Level),
        _ => None,
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let args: Vec<&str> = args.iter().map(String::as_str).collect();
    let code = match parse(&args) {
        Some(Cmd::Version) => {
            println!("{}", fan_control::PROTOCOL);
            0
        }
        Some(Cmd::Probe) => probe(),
        Some(cmd) => run(cmd),
        None => {
            eprintln!("usage: desk-fans level 40..100|auto|version|probe");
            2
        }
    };
    std::process::exit(code);
}

#[cfg(target_os = "macos")]
fn run(cmd: Cmd) -> i32 {
    let mut pause = || std::thread::sleep(std::time::Duration::from_millis(100));
    let result = smc::IoSmc::open().and_then(|mut smc| match cmd {
        Cmd::Level(percent) => fan_control::force_level(&mut smc, percent, &mut pause),
        _ => fan_control::restore_auto(&mut smc, &mut pause),
    });
    match result {
        Ok(()) => 0,
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

/// The keys and fans as desk sees them, to send in when a Mac misbehaves.
#[cfg(target_os = "macos")]
fn probe() -> i32 {
    let fans = smc::IoSmc::open().and_then(|mut smc| {
        let keys = fan_control::Keys::probe(&mut smc);
        println!("mode key {}, Ftst {}", keys.mode(0), if keys.unlock { "yes" } else { "no" });
        fan_control::read(&mut smc)
    });
    match fans {
        Ok(fans) => {
            println!("{} fans", fans.len());
            for (i, f) in fans.iter().enumerate() {
                println!("fan {i}: mode {}, {:.0} rpm, max {:.0}", f.mode, f.rpm, f.max_rpm);
            }
            0
        }
        Err(e) => {
            eprintln!("{e}");
            1
        }
    }
}

#[cfg(not(target_os = "macos"))]
fn probe() -> i32 {
    eprintln!("unsupported");
    2
}

#[cfg(not(target_os = "macos"))]
fn run(_cmd: Cmd) -> i32 {
    eprintln!("unsupported");
    2
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_accepts_only_the_listed_commands() {
        assert_eq!(parse(&["level", "70"]), Some(Cmd::Level(70)));
        assert_eq!(parse(&["level", "100"]), Some(Cmd::Level(100)));
        assert_eq!(parse(&["auto"]), Some(Cmd::Auto));
        assert_eq!(parse(&["version"]), Some(Cmd::Version));
        assert_eq!(parse(&["probe"]), Some(Cmd::Probe));
        let bad: [&[&str]; 9] = [
            &[],
            &["max"],
            &["level"],
            &["level", "45"],
            &["level", "070"],
            &["level", "+70"],
            &["level", "70", "x"],
            &["auto", "x"],
            &["level", "1000"],
        ];
        for args in bad {
            assert_eq!(parse(args), None, "{args:?}");
        }
    }
}
