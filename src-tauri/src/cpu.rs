//! The temperature chip's panel (src/cpu-view.ts): how busy the CPU is (user
//! and system time, of all cores), the load average, a 10-minute history read
//! every 5 s, and the processes using the most CPU right now, each with the
//! desk session it runs in.
//!
//! - macOS: `host_statistics` for the whole CPU; `ps` (setuid, so it sees
//!   every process, the system's too) for each process's CPU time.
//! - Linux: `/proc/stat` and `/proc/<pid>/stat`.
//! - Windows: `GetSystemTimes` and `GetProcessTimes`; Windows keeps no load
//!   average.

use crate::busiest::{Busiest, busiest};
use crate::thermal::{Proc, descendants};
use crate::tmux::SessionInfo;
use serde::Serialize;
use std::collections::{HashMap, VecDeque};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Points of history kept: 10 minutes at one every 5 s.
pub const HISTORY: usize = 120;
/// Processes listed.
const TOP: usize = 8;
/// Process CPU times are compared over at least this long.
const MIN_WINDOW: Duration = Duration::from_millis(400);
/// A process reading older than this is not compared against (the panel was closed).
const STALE: Duration = Duration::from_secs(10);

/// The whole CPU's time so far, in any unit: in user code (niced too), in
/// the system, idle.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct Ticks {
    pub user: u64,
    pub system: u64,
    pub idle: u64,
}

/// The share of all cores busy in user and in system code between two
/// readings, %. None when nothing passed or a counter went back (wrapped).
pub fn usage(a: Ticks, b: Ticks) -> Option<(f32, f32)> {
    if b.user < a.user || b.system < a.system || b.idle < a.idle {
        return None;
    }
    let (u, s, i) = ((b.user - a.user) as f64, (b.system - a.system) as f64, (b.idle - a.idle) as f64);
    let total = u + s + i;
    (total > 0.0).then(|| ((u / total * 100.0) as f32, (s / total * 100.0) as f32))
}

/// One point of history: when (Unix seconds) and how busy, %.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub at: u64,
    pub user: f32,
    pub system: f32,
}

/// A desk session, as the frontend keys its tile.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRef {
    pub path: String,
    pub agent: String,
    pub instance: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TopProcess {
    pub pid: u32,
    pub name: String,
    /// % of one core (as top and Activity Monitor count).
    pub percent: f32,
    /// The desk session it runs in, if any.
    pub session: Option<SessionRef>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Details {
    pub cores: usize,
    /// 1, 5 and 15 minutes; None on Windows.
    pub load: Option<[f32; 3]>,
    /// Oldest first.
    pub history: Vec<Sample>,
    /// None: not looked at (the panel hides its top processes).
    pub top: Option<Vec<TopProcess>>,
    /// The desk session using the most CPU, all its processes together.
    pub busiest: Option<Busiest>,
}

/// Every process with its CPU time so far.
pub struct Reading {
    pub table: Vec<Proc>,
    pub times: HashMap<u32, Duration>,
    pub at: Instant,
}

/// The `n` processes that used the most CPU from `before` to `after`
/// (`window` apart), each with the session it belongs to. A process read only
/// once counts nothing; idle ones are left out.
pub fn top_processes(
    sessions: &[(SessionInfo, Vec<u32>)],
    table: &[Proc],
    before: &HashMap<u32, Duration>,
    after: &HashMap<u32, Duration>,
    window: Duration,
    n: usize,
) -> Vec<TopProcess> {
    let secs = window.as_secs_f64();
    if secs <= 0.0 {
        return Vec::new();
    }
    let mut used: Vec<(&Proc, f32)> = table
        .iter()
        .filter_map(|p| {
            let d = after.get(&p.pid)?.saturating_sub(*before.get(&p.pid)?);
            let percent = (d.as_secs_f64() / secs * 100.0) as f32;
            (percent >= 0.1).then_some((p, percent))
        })
        .collect();
    used.sort_by(|a, b| b.1.total_cmp(&a.1).then(a.0.pid.cmp(&b.0.pid)));
    used.truncate(n);
    let mut owner: HashMap<u32, &SessionInfo> = HashMap::new();
    for (info, roots) in sessions {
        for pid in descendants(roots, table) {
            owner.insert(pid, info);
        }
    }
    used.into_iter()
        .map(|(p, percent)| TopProcess {
            pid: p.pid,
            name: p.name.clone(),
            percent: (percent * 10.0).round() / 10.0,
            session: owner.get(&p.pid).map(|s| SessionRef {
                path: s.path.clone(),
                agent: s.agent.clone(),
                instance: s.instance,
            }),
        })
        .collect()
}

/// A program's name as people know it: "Google Chrome Helper", "node",
/// "zsh" (a login shell's "-zsh" too), "pwsh" for "pwsh.exe". Case kept.
pub fn display_name(comm: &str) -> String {
    let file = comm.rsplit(['/', '\\']).next().unwrap_or(comm);
    let file = file.strip_prefix('-').unwrap_or(file);
    let lower = file.to_ascii_lowercase();
    match lower.strip_suffix(".exe") {
        Some(_) => file[..file.len() - 4].to_string(),
        None => file.to_string(),
    }
}

/// `ps` CPU time: "0:01.23", "413:51.32" (macOS: minutes may pass 59),
/// "01:02:03", "2-01:02:03" (Linux: days first).
pub fn parse_cpu_time(s: &str) -> Option<Duration> {
    let (days, rest) = match s.split_once('-') {
        Some((d, r)) => (d.parse::<u64>().ok()?, r),
        None => (0, s),
    };
    let mut secs = 0.0;
    for part in rest.split(':') {
        secs = secs * 60.0 + part.parse::<f64>().ok()?;
    }
    (secs >= 0.0).then(|| Duration::from_secs_f64(secs + (days * 86_400) as f64))
}

/// `ps -A -o pid=,ppid=,time=,comm=` output: each process and its CPU time.
pub fn parse_ps_times(out: &str) -> Vec<(Proc, Duration)> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let parent = it.next()?.parse().ok()?;
            let time = parse_cpu_time(it.next()?)?;
            // The rest is the program, a path with spaces at times.
            let comm = it.collect::<Vec<_>>().join(" ");
            Some((proc(pid, parent, display_name(&comm)), time))
        })
        .collect()
}

/// Linux `/proc/stat`: the first ("cpu") line's user + nice, system + irq +
/// softirq + steal, idle + iowait.
pub fn parse_proc_stat(stat: &str) -> Option<Ticks> {
    let line = stat.lines().find(|l| l.starts_with("cpu "))?;
    let f: Vec<u64> = line.split_whitespace().skip(1).map(|x| x.parse().unwrap_or(0)).collect();
    let at = |i: usize| f.get(i).copied().unwrap_or(0);
    (f.len() >= 4).then(|| Ticks {
        user: at(0) + at(1),
        system: at(2) + at(5) + at(6) + at(7),
        idle: at(3) + at(4),
    })
}

/// Linux `/proc/<pid>/stat`: pid, parent, program and utime + stime in clock
/// ticks. The program is in parentheses and may hold spaces and parentheses.
pub fn parse_pid_stat(stat: &str) -> Option<(u32, u32, String, u64)> {
    let open = stat.find('(')?;
    let close = stat.rfind(')')?;
    let pid = stat[..open].trim().parse().ok()?;
    let name = stat.get(open + 1..close)?.to_string();
    // After the name: field 3 (state) onwards; ppid is field 4, utime and stime 14 and 15.
    let f: Vec<&str> = stat[close + 1..].split_whitespace().collect();
    let parent = f.get(1)?.parse().ok()?;
    let ticks = f.get(11)?.parse::<u64>().ok()? + f.get(12)?.parse::<u64>().ok()?;
    Some((pid, parent, name, ticks))
}

fn proc(pid: u32, parent: u32, name: String) -> Proc {
    Proc {
        pid,
        parent,
        name,
        tty: None,
        group: None,
        stopped: false,
    }
}

fn reading(rows: Vec<(Proc, Duration)>) -> Reading {
    let times = rows.iter().map(|(p, t)| (p.pid, *t)).collect();
    Reading {
        table: rows.into_iter().map(|(p, _)| p).collect(),
        times,
        at: Instant::now(),
    }
}

#[derive(Default)]
struct State {
    ticks: Option<Ticks>,
    history: VecDeque<Sample>,
    /// The panel's last process reading, compared against by the next.
    last: Option<Reading>,
}

/// The history, kept since desk started, and the panel's last reading.
#[derive(Default)]
pub struct Monitor {
    state: Mutex<State>,
}

impl Monitor {
    /// Every 5 s, from the temperature thread: one more point of history.
    pub fn tick(&self) {
        let Some(now) = os::cpu_ticks() else { return };
        let at = SystemTime::now().duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs());
        self.record(now, at);
    }

    fn record(&self, now: Ticks, at: u64) {
        let mut s = self.state.lock().unwrap();
        if let Some((user, system)) = s.ticks.and_then(|prev| usage(prev, now)) {
            if s.history.len() == HISTORY {
                s.history.pop_front();
            }
            s.history.push_back(Sample { at, user, system });
        }
        s.ticks = Some(now);
    }

    /// For the open panel (every 2 s). The first time, or after a pause,
    /// it measures the processes over MIN_WINDOW, so it may block that long.
    /// `sessions` None: the panel hides its top processes, so none are read.
    pub fn details(&self, sessions: Option<&[(SessionInfo, Vec<u32>)]>) -> Details {
        let (top, busy) = match sessions {
            Some(sessions) => {
                let (top, busy) = self.processes(sessions);
                (Some(top), busy)
            }
            None => (None, None),
        };
        Details {
            cores: std::thread::available_parallelism().map_or(1, |n| n.get()),
            load: os::load(),
            history: self.state.lock().unwrap().history.iter().cloned().collect(),
            top,
            busiest: busy,
        }
    }

    /// The top processes and the busiest session since the last reading.
    fn processes(&self, sessions: &[(SessionInfo, Vec<u32>)]) -> (Vec<TopProcess>, Option<Busiest>) {
        let last = self.state.lock().unwrap().last.take().filter(|r| r.at.elapsed() < STALE);
        let before = last.unwrap_or_else(|| reading(os::process_times()));
        std::thread::sleep(MIN_WINDOW.saturating_sub(before.at.elapsed()));
        let after = reading(os::process_times());
        let window = after.at.duration_since(before.at);
        let top = top_processes(sessions, &after.table, &before.times, &after.times, window, TOP);
        let busy = busiest(sessions, &after.table, &before.times, &after.times, window);
        self.state.lock().unwrap().last = Some(after);
        (top, busy)
    }
}

#[cfg(unix)]
fn load_average() -> Option<[f32; 3]> {
    let mut l = [0f64; 3];
    // SAFETY: getloadavg writes at most 3 doubles into `l`.
    let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    (n == 3).then(|| l.map(|x| x as f32))
}

#[cfg(target_os = "macos")]
mod os {
    use super::{Proc, Ticks};
    use std::sync::OnceLock;
    use std::time::Duration;

    /// host_cpu_load_info: user, system, idle, nice ticks.
    #[repr(C)]
    struct CpuLoad {
        ticks: [u32; 4],
    }

    const HOST_CPU_LOAD_INFO: i32 = 3;

    unsafe extern "C" {
        fn mach_host_self() -> u32;
        fn host_statistics(host: u32, flavor: i32, info: *mut i32, count: *mut u32) -> i32;
    }

    /// The host port, asked once (each call adds a reference to it).
    static HOST: OnceLock<u32> = OnceLock::new();

    pub fn cpu_ticks() -> Option<Ticks> {
        // SAFETY: mach_host_self takes nothing; host_statistics writes at most
        // `count` (4) integers into `load`.
        unsafe {
            let host = *HOST.get_or_init(|| mach_host_self());
            let mut load = CpuLoad { ticks: [0; 4] };
            let mut count = 4u32;
            if host_statistics(host, HOST_CPU_LOAD_INFO, (&raw mut load).cast(), &mut count) != 0 {
                return None;
            }
            let [user, system, idle, nice] = load.ticks.map(u64::from);
            Some(Ticks { user: user + nice, system, idle })
        }
    }

    pub fn load() -> Option<[f32; 3]> {
        super::load_average()
    }

    pub fn process_times() -> Vec<(Proc, Duration)> {
        std::process::Command::new("ps")
            .args(["-A", "-o", "pid=,ppid=,time=,comm="])
            .output()
            .map(|o| super::parse_ps_times(&String::from_utf8_lossy(&o.stdout)))
            .unwrap_or_default()
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::{Proc, Ticks};
    use std::time::Duration;

    pub fn cpu_ticks() -> Option<Ticks> {
        super::parse_proc_stat(&std::fs::read_to_string("/proc/stat").ok()?)
    }

    pub fn load() -> Option<[f32; 3]> {
        super::load_average()
    }

    pub fn process_times() -> Vec<(Proc, Duration)> {
        // SAFETY: sysconf only reads a constant.
        let hz = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
        if hz <= 0 {
            return Vec::new();
        }
        std::fs::read_dir("/proc")
            .into_iter()
            .flatten()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().bytes().all(|b| b.is_ascii_digit()))
            .filter_map(|e| {
                let stat = std::fs::read_to_string(e.path().join("stat")).ok()?;
                let (pid, parent, name, ticks) = super::parse_pid_stat(&stat)?;
                Some((super::proc(pid, parent, name), Duration::from_secs_f64(ticks as f64 / hz as f64)))
            })
            .collect()
    }
}

#[cfg(windows)]
mod os {
    use super::{Proc, Ticks};
    use std::time::Duration;
    use windows::Win32::Foundation::{CloseHandle, FILETIME};
    use windows::Win32::System::Threading::{
        GetProcessTimes, GetSystemTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };

    fn hundreds(f: FILETIME) -> u64 {
        (u64::from(f.dwHighDateTime) << 32) | u64::from(f.dwLowDateTime)
    }

    pub fn cpu_ticks() -> Option<Ticks> {
        let (mut idle, mut kernel, mut user) = (FILETIME::default(), FILETIME::default(), FILETIME::default());
        // SAFETY: the FILETIMEs are locals.
        unsafe { GetSystemTimes(Some(&mut idle), Some(&mut kernel), Some(&mut user)) }.ok()?;
        let idle = hundreds(idle);
        // Kernel time includes the idle time.
        Some(Ticks { user: hundreds(user), system: hundreds(kernel).saturating_sub(idle), idle })
    }

    pub fn load() -> Option<[f32; 3]> {
        None
    }

    /// Processes Windows lets desk ask (not the protected ones).
    pub fn process_times() -> Vec<(Proc, Duration)> {
        crate::thermal::processes()
            .into_iter()
            .filter_map(|p| {
                let t = cpu_time(p.pid)?;
                Some((p, t))
            })
            .collect()
    }

    fn cpu_time(pid: u32) -> Option<Duration> {
        // SAFETY: the handle is closed; the FILETIMEs are locals.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid).ok()?;
            let (mut created, mut exited, mut kernel, mut user) =
                (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
            let ok = GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user).is_ok();
            let _ = CloseHandle(h);
            ok.then(|| Duration::from_nanos((hundreds(kernel) + hundreds(user)) * 100))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info(slug: &str, path: &str, agent: &str) -> SessionInfo {
        SessionInfo {
            slug: slug.into(),
            path: path.into(),
            agent: agent.into(),
            instance: 0,
        }
    }

    fn p(pid: u32, parent: u32, name: &str) -> Proc {
        proc(pid, parent, name.into())
    }

    fn ms(pairs: &[(u32, u64)]) -> HashMap<u32, Duration> {
        pairs.iter().map(|&(p, m)| (p, Duration::from_millis(m))).collect()
    }

    #[test]
    fn usage_splits_user_and_system_and_skips_a_wrapped_counter() {
        let a = Ticks { user: 100, system: 50, idle: 850 };
        let b = Ticks { user: 160, system: 70, idle: 870 };
        assert_eq!(usage(a, b), Some((60.0, 20.0)));
        assert_eq!(usage(a, a), None);
        assert_eq!(usage(b, a), None);
    }

    #[test]
    fn the_history_keeps_ten_minutes() {
        let m = Monitor::default();
        m.record(Ticks { user: 0, system: 0, idle: 0 }, 0);
        for i in 1..=(HISTORY as u64 + 5) {
            m.record(Ticks { user: i * 3, system: i, idle: i * 6 }, i * 5);
        }
        let s = m.state.lock().unwrap();
        assert_eq!(s.history.len(), HISTORY);
        assert_eq!(s.history.front().unwrap().at, 6 * 5);
        assert_eq!(s.history.back().unwrap(), &Sample { at: (HISTORY as u64 + 5) * 5, user: 30.0, system: 10.0 });
    }

    #[test]
    fn the_top_processes_with_their_tiles() {
        let sessions = vec![(info("shop-1", "/p/shop", "claude"), vec![100])];
        let table = [p(100, 1, "zsh"), p(110, 100, "cargo"), p(111, 110, "rustc"), p(300, 1, "WindowServer"), p(400, 1, "idle")];
        let before = ms(&[(100, 0), (110, 0), (111, 0), (300, 0), (400, 0)]);
        let after = ms(&[(100, 0), (110, 50), (111, 900), (300, 300), (400, 0)]);
        let top = top_processes(&sessions, &table, &before, &after, Duration::from_secs(1), 2);
        assert_eq!(
            top.iter().map(|t| (t.name.as_str(), t.percent, t.session.as_ref().map(|s| s.path.as_str()))).collect::<Vec<_>>(),
            [("rustc", 90.0, Some("/p/shop")), ("WindowServer", 30.0, None)]
        );
        assert!(top_processes(&sessions, &table, &before, &after, Duration::ZERO, 5).is_empty());
        // Idle and once-read processes are not listed.
        let all = top_processes(&sessions, &table, &before, &after, Duration::from_secs(1), 10);
        assert_eq!(all.len(), 3);
    }

    #[test]
    fn reads_ps_cpu_times() {
        assert_eq!(parse_cpu_time("0:01.23"), Some(Duration::from_millis(1230)));
        assert_eq!(parse_cpu_time("413:51.32"), Some(Duration::from_millis(24_831_320)));
        assert_eq!(parse_cpu_time("01:02:03"), Some(Duration::from_secs(3723)));
        assert_eq!(parse_cpu_time("2-00:00:01"), Some(Duration::from_secs(172_801)));
        assert_eq!(parse_cpu_time("x"), None);
        let out = "    1     0  32:21.97 /sbin/launchd\n  412     1   0:00.50 /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Helper (Renderer)\nbad\n  900   412   1:00.00 -zsh\n";
        let rows = parse_ps_times(out);
        assert_eq!(
            rows.iter().map(|(p, t)| (p.pid, p.parent, p.name.as_str(), t.as_millis())).collect::<Vec<_>>(),
            [(1, 0, "launchd", 1_941_970), (412, 1, "Google Chrome Helper (Renderer)", 500), (900, 412, "zsh", 60_000)]
        );
        assert_eq!(display_name("C:\\Program Files\\PowerShell\\7\\pwsh.EXE"), "pwsh");
    }

    #[test]
    fn reads_linux_stat_files() {
        let stat = "cpu  100 5 50 800 20 3 2 1 0 0\ncpu0 1 2 3 4\n";
        assert_eq!(parse_proc_stat(stat), Some(Ticks { user: 105, system: 56, idle: 820 }));
        assert_eq!(parse_proc_stat("intr 1 2"), None);
        let pid = "4242 (my (odd) prog) S 17 4242 4242 0 -1 4194560 100 0 0 0 1234 56 0 0 20 0 1 0 100 0 0";
        assert_eq!(parse_pid_stat(pid), Some((4242, 17, "my (odd) prog".to_string(), 1290)));
        assert_eq!(parse_pid_stat("garbage"), None);
    }

    #[cfg(any(target_os = "macos", target_os = "linux", windows))]
    #[test]
    fn reads_this_computer_and_finds_the_busy_session() {
        let m = Monitor::default();
        m.tick();
        std::thread::sleep(Duration::from_millis(200));
        m.tick();
        assert_eq!(m.state.lock().unwrap().history.len(), 1, "the whole CPU reads");
        #[cfg(unix)]
        {
            use std::process::Command;
            let mut busy = Command::new("sh").args(["-c", "while :; do :; done"]).spawn().unwrap();
            let mut idle = Command::new("sleep").arg("30").spawn().unwrap();
            let sessions = vec![
                (info("idle-1", "/p/idle", "shell"), vec![idle.id()]),
                (info("busy-1", "/p/busy", "claude"), vec![busy.id()]),
            ];
            let d = m.details(Some(&sessions));
            for c in [&mut busy, &mut idle] {
                let _ = c.kill();
                let _ = c.wait();
            }
            let b = d.busiest.expect("the loop is busy");
            assert_eq!((b.path.as_str(), b.program.as_str()), ("/p/busy", "sh"));
            assert!((20..=150).contains(&b.percent), "{}", b.percent);
            let top = d.top.expect("asked for the processes");
            let mine = top.iter().find(|t| t.pid == busy.id()).expect("the loop is in the top");
            assert_eq!(mine.session.as_ref().map(|s| s.path.as_str()), Some("/p/busy"));
            assert!(d.load.is_some() && d.cores >= 1);
        }
    }

    #[test]
    fn with_the_top_processes_hidden_it_reads_no_process() {
        let m = Monitor::default();
        m.tick();
        std::thread::sleep(Duration::from_millis(50));
        m.tick();
        let started = Instant::now();
        let d = m.details(None);
        assert!(started.elapsed() < MIN_WINDOW, "no measuring window");
        assert_eq!((d.top, d.busiest), (None, None));
        assert!(m.state.lock().unwrap().last.is_none(), "no process reading kept");
        assert_eq!(d.history.len(), 1, "the CPU's own numbers still come");
    }

    /// `cargo test prints_this_computer -- --ignored --nocapture`: the panel's numbers here, as JSON.
    #[test]
    #[ignore = "reads this computer's processes"]
    fn prints_this_computer() {
        let m = Monitor::default();
        for _ in 0..3 {
            m.tick();
            std::thread::sleep(Duration::from_millis(500));
        }
        println!("{}", serde_json::to_string(&m.details(Some(&[]))).unwrap());
    }
}
