//! Temperature guard: every 5 s desk reads the CPU temperature, shows it in
//! the top bar and, while the computer stays hotter than the limit set in
//! Options (75 °C by default), slows the work running in its sessions (tests,
//! builds, whatever an agent starts) until it cools down. It keeps running,
//! only slower, and nothing outside desk's sessions is touched. What you type
//! into (the shell, the agent, an editor) keeps full speed: see `split`.
//!
//! Reading
//! - macOS: the CPU die sensors ("PMU tdie*" on Apple Silicon) through
//!   IOHIDEventSystemClient, as Stats or macmon read them; no admin rights.
//!   The system's own thermal state counts too: serious or worse is over the
//!   limit whatever the sensors say (Intel Macs have no such sensors).
//! - Linux: the CPU hwmon drivers (coretemp, k10temp...), else the hottest
//!   thermal zone.
//! - Windows: the ACPI thermal zones performance counter. Many machines have
//!   none; then the bar shows no temperature and nothing is slowed.
//!
//! Slowing
//! - macOS: `PRIO_DARWIN_BG`, what `taskpolicy -b` sets: low CPU and disk
//!   priority on slower cores at a lower clock; new child processes inherit it.
//! - Windows: EcoQoS, Task Manager's efficiency mode, on each process.
//! - Linux: the processes move into the systemd user scope
//!   `desk-sessions.scope`, capped at half the CPU cores. Without systemd's
//!   user manager nothing is slowed and the bar says why.
//!
//! The sessions get full speed back 7 °C below the limit (after at least a
//! minute, so it does not flap), when slowing is turned off, and when desk
//! quits. After a crash the next start puts them back.
//!
//! Fans
//! - Only when the user picked a mode with fans in Options (`Mode`): up to
//!   four steps ("from 72°C, 70%"), each with its own threshold; `StepPolicy`
//!   picks the step from the same average as slowing, independent of it, and
//!   fans.rs sets every fan to that step's percent (macOS on Apple Silicon
//!   only). Below the first step the fans are macOS's again.
//!
//! Emergency stop
//! - Only when turned on in Options (off by default): once the same average
//!   reaches its limit (90 °C by default), desk freezes the work in all its
//!   sessions, tiles open or not (`Halt`, `freeze_plan`). Nothing is killed:
//!   macOS and Linux stop the processes (SIGSTOP), Windows suspends their
//!   threads. It stays so until the user resumes it from the top bar, which
//!   waits until the CPU is `RESUME_MARGIN` below the limit, or turns it off
//!   in Options. Quitting desk resumes everything; after a crash the next
//!   start does (the pids are kept in `halted-pids`).

use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap, HashSet, VecDeque};
use crate::fans::{FanStatus, Fans};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::time::{Duration, Instant};

pub const DEFAULT_LIMIT: u32 = 75;
/// Lowest and highest limit Options accepts.
pub const MIN_LIMIT: u32 = 50;
pub const MAX_LIMIT: u32 = 100;
/// Back to full speed this far below the limit.
pub const COOL_MARGIN: f32 = 7.0;
const TICK: Duration = Duration::from_secs(5);
/// Readings averaged before deciding (15 s): one spike slows nothing.
const WINDOW: usize = 3;
/// Slowed at least this long, so the sessions do not flap at the limit.
const MIN_SLOW: Duration = Duration::from_secs(60);

/// The emergency stop's limit (Options, layout `emergencyAt`), °C.
pub const DEFAULT_EMERGENCY: u32 = 90;
pub const MIN_EMERGENCY: u32 = 60;
pub const MAX_EMERGENCY: u32 = 110;
/// Resuming after an emergency stop waits until the average is this far
/// below its limit, so the work does not freeze again at once.
pub const RESUME_MARGIN: f32 = 5.0;

/// The emergency limit the guard uses: 0 when the stop is off, else the
/// layout's within MIN_EMERGENCY..=MAX_EMERGENCY.
pub fn emergency_limit(on: bool, celsius: u32) -> u32 {
    if on { celsius.clamp(MIN_EMERGENCY, MAX_EMERGENCY) } else { 0 }
}

/// How a fan step comes down (Options, layout `fanMargin` and `fanWait`):
/// `margin` °C below its threshold, and no sooner than `wait` seconds after
/// the last change of step.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StepDown {
    pub margin: u32,
    pub wait: u32,
}

pub const DEFAULT_FAN_MARGIN: u32 = 7;
pub const DEFAULT_FAN_WAIT: u32 = 60;
/// 0: a step comes down as soon as the average is under its own threshold.
const FAN_MARGINS: std::ops::RangeInclusive<u32> = 0..=15;
const FAN_WAITS: std::ops::RangeInclusive<u32> = 15..=300;

impl StepDown {
    /// Any pair from a file, clamped to what Options offers.
    pub fn new(margin: u32, wait: u32) -> Self {
        Self {
            margin: margin.clamp(*FAN_MARGINS.start(), *FAN_MARGINS.end()),
            wait: wait.clamp(*FAN_WAITS.start(), *FAN_WAITS.end()),
        }
    }
}

impl Default for StepDown {
    fn default() -> Self {
        Self { margin: DEFAULT_FAN_MARGIN, wait: DEFAULT_FAN_WAIT }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    /// Hottest CPU sensor in °C; None when desk cannot read one here.
    pub celsius: Option<i32>,
    /// Slowing limit; 0: this mode never slows.
    pub limit: u32,
    /// The fan steps; empty: this mode never uses the fans.
    pub fan_steps: Vec<Step>,
    /// The step desk wants the fans at now (index into `fan_steps`); None: auto.
    pub fan_step: Option<usize>,
    /// A step comes down this many °C below its threshold (StepDown).
    pub fan_margin: u32,
    /// Too hot: desk is slowing its sessions.
    pub slowed: bool,
    /// Processes slowed (what the sessions' shells, agents and editors started).
    pub processes: usize,
    /// Why desk cannot slow anything here, if it cannot.
    pub cannot_slow: Option<String>,
    /// The fans, when the mode uses them.
    pub fans: Option<FanStatus>,
    /// The emergency stop's limit, °C; 0: off.
    pub emergency: u32,
    /// The emergency stop tripped: the sessions' work is frozen until the
    /// user resumes it.
    pub halted: bool,
    /// Processes frozen.
    pub frozen: usize,
    /// Programs typed at a shell prompt left running (`freeze_plan`); what
    /// they started is frozen.
    pub jobs: usize,
}

/// What desk does when hot (Options, layout `thermalMode`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    Off,
    Slow,
    /// The fan steps and slowing, each from its own threshold.
    Together,
    Fans,
}

impl Mode {
    /// The layout's name; anything unknown is `Slow`, today's behaviour.
    /// "fansFirst" (fans from a lower limit, then slowing) is what `Together`
    /// does now that every step has its own threshold.
    pub fn parse(s: &str) -> Mode {
        match s {
            "off" => Mode::Off,
            "fansFirst" | "together" => Mode::Together,
            "fans" => Mode::Fans,
            _ => Mode::Slow,
        }
    }

    /// What the mode does besides the fans (the permission was removed).
    pub fn without_fans(self) -> Mode {
        match self {
            Mode::Together => Mode::Slow,
            Mode::Fans => Mode::Off,
            m => m,
        }
    }

    pub fn uses_fans(self) -> bool {
        matches!(self, Mode::Together | Mode::Fans)
    }

    /// The slowing limit, within MIN_LIMIT..=MAX_LIMIT; 0: this mode never slows.
    pub fn slow_limit(self, limit: u32) -> u32 {
        match self {
            Mode::Slow | Mode::Together => limit.clamp(MIN_LIMIT, MAX_LIMIT),
            Mode::Off | Mode::Fans => 0,
        }
    }
}

/// When to slow: the average of the last readings at or over the limit (or
/// the system saying it is too hot), and when to stop.
#[derive(Debug, Default)]
pub struct Policy {
    readings: VecDeque<f32>,
    since: Option<Instant>,
}

impl Policy {
    /// Takes a reading (None: no sensor) and the system's own "too hot";
    /// says whether the sessions should be slowed now.
    pub fn step(&mut self, celsius: Option<f32>, pressure: bool, limit: u32, now: Instant) -> bool {
        if let Some(c) = celsius {
            if self.readings.len() == WINDOW {
                self.readings.pop_front();
            }
            self.readings.push_back(c);
        }
        if limit == 0 {
            self.since = None;
            return false;
        }
        let avg = (self.readings.len() == WINDOW).then(|| self.readings.iter().sum::<f32>() / WINDOW as f32);
        let limit = limit as f32;
        match self.since {
            None if pressure || avg.is_some_and(|a| a >= limit) => self.since = Some(now),
            Some(start) => {
                let cool = !pressure && avg.is_none_or(|a| a <= limit - COOL_MARGIN);
                if cool && now.duration_since(start) >= MIN_SLOW {
                    self.since = None;
                }
            }
            None => {}
        }
        self.since.is_some()
    }
}

/// Why the emergency stop tripped.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum HaltCause {
    /// The average of the readings reached the limit.
    Temperature,
    /// macOS said its thermal state is critical.
    System,
}

/// Why "resume" is refused.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Refusal {
    /// The average is not yet RESUME_MARGIN below the limit.
    Hot(f32),
    /// macOS still says its thermal state is critical.
    Critical,
}

/// When to freeze the sessions' work: the average of the last readings at or
/// over the emergency limit, or at once the system's critical thermal state.
/// It holds until the user resumes (`resume`); cooling down does not undo it.
#[derive(Debug, Default)]
pub struct Halt {
    readings: VecDeque<f32>,
    /// Some while tripped.
    cause: Option<HaltCause>,
    /// The last step's critical state.
    critical: bool,
}

impl Halt {
    /// Takes a reading (None: no sensor, nothing changes) and the system's
    /// critical state; says whether the work should be frozen now. `limit` 0:
    /// the stop is off and lets go.
    pub fn step(&mut self, celsius: Option<f32>, critical: bool, limit: u32) -> bool {
        if let Some(c) = celsius {
            if self.readings.len() == WINDOW {
                self.readings.pop_front();
            }
            self.readings.push_back(c);
        }
        self.critical = critical;
        if limit == 0 {
            self.cause = None;
        } else if self.cause.is_none() {
            if critical {
                self.cause = Some(HaltCause::System);
            } else if self.average().is_some_and(|a| a >= limit as f32) {
                self.cause = Some(HaltCause::Temperature);
            }
        }
        self.tripped()
    }

    pub fn tripped(&self) -> bool {
        self.cause.is_some()
    }

    /// Why it tripped; None while it has not.
    pub fn cause(&self) -> Option<HaltCause> {
        self.cause
    }

    /// The user's "resume": refused while the system is still critical, or
    /// with the average while it is not yet RESUME_MARGIN below `limit`
    /// (0: off, always allowed).
    pub fn resume(&mut self, limit: u32) -> Result<(), Refusal> {
        if limit > 0 && self.critical {
            return Err(Refusal::Critical);
        }
        if let Some(a) = self.average()
            && limit > 0
            && a > limit as f32 - RESUME_MARGIN
        {
            return Err(Refusal::Hot(a));
        }
        self.cause = None;
        Ok(())
    }

    fn average(&self) -> Option<f32> {
        (self.readings.len() == WINDOW).then(|| self.readings.iter().sum::<f32>() / WINDOW as f32)
    }
}

/// One fan step from Options: from `celsius` (the average, as for slowing)
/// the fans run at `percent` of their maximum (fan_control::LEVELS).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Step {
    pub celsius: u32,
    pub percent: u8,
}

/// Most steps Options keeps.
pub const MAX_STEPS: usize = 4;

/// One step, full speed from 70°C: what the fans did before steps.
pub fn default_steps() -> Vec<Step> {
    vec![Step { celsius: 70, percent: 100 }]
}

/// A table desk can use, whatever it was given: thresholds within
/// MIN_LIMIT..=MAX_LIMIT and rising, percents on the 40–100 list (nearest 10)
/// and never falling, one row per threshold (the last kept), at most
/// MAX_STEPS rows; nothing left: the default.
pub fn normalize_steps(steps: Vec<Step>) -> Vec<Step> {
    let mut rows: Vec<Step> = steps
        .into_iter()
        .map(|s| Step {
            celsius: s.celsius.clamp(MIN_LIMIT, MAX_LIMIT),
            percent: ((f32::from(s.percent) / 10.0).round() * 10.0).clamp(40.0, 100.0) as u8,
        })
        .collect();
    rows.sort_by_key(|s| (s.celsius, s.percent));
    let mut out: Vec<Step> = Vec::new();
    for row in rows {
        match out.last_mut() {
            Some(last) if last.celsius == row.celsius => *last = row,
            _ => out.push(row),
        }
    }
    out.truncate(MAX_STEPS);
    let mut top = 0;
    for row in &mut out {
        top = top.max(row.percent);
        row.percent = top;
    }
    if out.is_empty() { default_steps() } else { out }
}

/// Which step the fans should be at: up at once (several steps if need be),
/// down only under `StepDown::margin` below a step's threshold and `StepDown::wait`
/// after the last change, straight to the step the average still holds;
/// below the first threshold, auto. No reading: nothing holds the fans, so
/// they go back to auto after the wait.
#[derive(Debug, Default)]
pub struct StepPolicy {
    readings: VecDeque<f32>,
    /// The threshold of the held step (None: auto). Kept by threshold rather
    /// than by row, so an edited table maps it to the row starting at or below
    /// it and never holds the fans above what the new table says.
    held: Option<u32>,
    /// The last change of step, up or down.
    since: Option<Instant>,
    down: StepDown,
}

impl StepPolicy {
    /// The way down from Options; takes effect from the next reading.
    pub fn set_down(&mut self, down: StepDown) {
        self.down = down;
    }

    /// The step for now, as an index into `steps` (None: auto). `steps` may
    /// differ from the last call (Options edited): the held step becomes the
    /// last row starting at or below its threshold, then the usual rules apply.
    pub fn step(&mut self, celsius: Option<f32>, pressure: bool, steps: &[Step], now: Instant) -> Option<usize> {
        match celsius {
            Some(c) => {
                if self.readings.len() == WINDOW {
                    self.readings.pop_front();
                }
                self.readings.push_back(c);
            }
            None => self.readings.clear(),
        }
        if steps.is_empty() {
            self.held = None;
            self.since = None;
            return None;
        }
        let avg = (self.readings.len() == WINDOW).then(|| self.readings.iter().sum::<f32>() / WINDOW as f32);
        let held = self.held.and_then(|c| steps.iter().rposition(|s| s.celsius <= c));
        let up = if pressure {
            Some(steps.len() - 1)
        } else {
            avg.and_then(|a| steps.iter().rposition(|s| a >= s.celsius as f32))
        };
        let wait = Duration::from_secs(self.down.wait.into());
        let margin = self.down.margin as f32;
        let settled = self.since.is_none_or(|s| now.duration_since(s) >= wait);
        let next = if up > held {
            self.since = Some(now);
            up
        } else if held.is_some() && !pressure && settled {
            // Below the first limit the fans are macOS's: the margin holds only between steps.
            // A step holds while the average is at least its threshold minus the margin, so with
            // no margin it holds exactly as long as it would be stepped up to (no flapping).
            let down = avg
                .filter(|&a| a >= steps[0].celsius as f32)
                .and_then(|a| steps.iter().rposition(|s| a >= s.celsius as f32 - margin));
            if down < held {
                self.since = Some(now);
                down
            } else {
                held
            }
        } else {
            held
        };
        self.held = next.map(|k| steps[k].celsius);
        next
    }
}

/// One running process: what desk needs to know to decide about it.
#[derive(Debug, Clone, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub parent: u32,
    /// The program's file name: "zsh", "claude", "node".
    pub name: String,
    /// Its terminal ("ttys004", "pts/3"); None without one or where desk
    /// cannot tell (Windows).
    pub tty: Option<String>,
    /// Its process group; None where there are none (Windows).
    pub group: Option<u32>,
    /// Stopped (Ctrl+Z, or waiting to read a terminal it does not own).
    pub stopped: bool,
}

/// The given processes still running and everything they started.
pub fn descendants(roots: &[u32], table: &[Proc]) -> Vec<u32> {
    let alive: HashSet<u32> = table.iter().map(|p| p.pid).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table {
        if p.pid != p.parent {
            children.entry(p.parent).or_default().push(p.pid);
        }
    }
    let mut seen = BTreeSet::new();
    let mut stack: Vec<u32> = roots.iter().copied().filter(|p| alive.contains(p)).collect();
    while let Some(pid) = stack.pop() {
        // Never pid 0/1 (the kernel, launchd/init) nor desk itself.
        if pid <= 1 || pid == std::process::id() || !seen.insert(pid) {
            continue;
        }
        if let Some(c) = children.get(&pid) {
            stack.extend(c);
        }
    }
    seen.into_iter().collect()
}

/// The sessions' processes: the ones to slow and the ones to leave alone.
#[derive(Debug, Default, PartialEq)]
pub struct Split {
    pub slow: Vec<u32>,
    pub spare: Vec<u32>,
}

/// Programs that only start other programs in a terminal.
const SHELLS: &[&str] = &[
    "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "elvish", "xonsh", "pwsh", "powershell", "cmd",
];

/// What to slow among the sessions' processes (`roots` and everything they
/// started), so that typing never stutters: the work, not what you type into.
/// - A session's shell and the shells it starts are never slowed.
/// - The program a shell runs (an agent, an editor) is left alone while its
///   terminal takes keys one at a time (`typing(tty)`): you may be typing
///   into it. With the terminal in line mode it is a job (`pnpm test`).
/// - Everything such a program starts is slowed: tests, builds, tools.
pub fn split(roots: &[u32], table: &[Proc], typing: impl Fn(Option<&str>) -> bool) -> Split {
    let by_pid: HashMap<u32, &Proc> = table.iter().map(|p| (p.pid, p)).collect();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in table {
        if p.pid != p.parent {
            children.entry(p.parent).or_default().push(p.pid);
        }
    }
    let mut typed: HashMap<Option<&str>, bool> = HashMap::new();
    let mut spare = BTreeSet::new();
    // Shells first, then the programs they run; `fronts` are those candidates.
    let mut fronts: Vec<u32> = roots.to_vec();
    while let Some(pid) = fronts.pop() {
        let Some(p) = by_pid.get(&pid) else { continue };
        if pid <= 1 || pid == std::process::id() || spare.contains(&pid) {
            continue;
        }
        if SHELLS.contains(&p.name.as_str()) {
            spare.insert(pid);
            fronts.extend(children.get(&pid).into_iter().flatten());
        } else if *typed.entry(p.tty.as_deref()).or_insert_with(|| typing(p.tty.as_deref())) {
            spare.insert(pid);
        }
    }
    let slow = descendants(roots, table).into_iter().filter(|p| !spare.contains(p)).collect();
    Split {
        slow,
        spare: spare.into_iter().collect(),
    }
}

/// What the emergency stop freezes, and the jobs it leaves running.
#[derive(Debug, Default, PartialEq)]
pub struct FreezePlan {
    pub freeze: Vec<u32>,
    pub jobs: Vec<u32>,
}

/// What the emergency stop freezes among the sessions' processes (`roots`
/// and everything they started): all of it, except
/// - the sessions' own processes: tmux wakes a pane's process that stops,
///   and they only wait for what they started anyway;
/// - a job a shell runs with job control (`pnpm test` typed at a prompt: its
///   own process group). The shell would see it stop, take the terminal back
///   and, once it runs again, leave it in the background. What the job
///   started (the test workers, the compiler) is frozen;
/// - what is stopped already (Ctrl+Z): resuming must not start it.
pub fn freeze_plan(roots: &[u32], table: &[Proc]) -> FreezePlan {
    let by_pid: HashMap<u32, &Proc> = table.iter().map(|p| (p.pid, p)).collect();
    let mut plan = FreezePlan::default();
    for pid in descendants(roots, table) {
        let Some(p) = by_pid.get(&pid) else { continue };
        if roots.contains(&pid) || p.stopped {
            continue;
        }
        let job = by_pid
            .get(&p.parent)
            .is_some_and(|sh| SHELLS.contains(&sh.name.as_str()) && p.group.is_some() && p.group != sh.group);
        if job {
            plan.jobs.push(pid);
        } else {
            plan.freeze.push(pid);
        }
    }
    plan
}

/// `ps -A -o pid=,ppid=,pgid=,stat=,tty=,comm=` output.
pub fn parse_ps(out: &str) -> Vec<Proc> {
    out.lines()
        .filter_map(|l| {
            let mut it = l.split_whitespace();
            let pid = it.next()?.parse().ok()?;
            let parent = it.next()?.parse().ok()?;
            let group = it.next()?.parse().ok()?;
            let stat = it.next()?;
            let tty = it.next()?;
            // The rest is the program, a path with spaces at times.
            let comm = it.collect::<Vec<_>>().join(" ");
            Some(Proc {
                pid,
                parent,
                name: program_name(&comm),
                tty: (!tty.starts_with('?')).then(|| tty.to_string()),
                group: Some(group),
                stopped: stat.starts_with('T'),
            })
        })
        .collect()
}

/// "/bin/zsh", "-zsh" (a login shell) and "pwsh.exe" are zsh, zsh and pwsh.
pub fn program_name(comm: &str) -> String {
    let file = comm.rsplit(['/', '\\']).next().unwrap_or(comm);
    let file = file.strip_prefix('-').unwrap_or(file);
    let lower = file.to_lowercase();
    lower.strip_suffix(".exe").unwrap_or(&lower).to_string()
}

/// The hottest believable reading (sensors that are off report nonsense).
pub fn hottest(celsius: impl IntoIterator<Item = f32>) -> Option<f32> {
    celsius
        .into_iter()
        .filter(|c| (1.0..=130.0).contains(c))
        .reduce(f32::max)
}

/// macOS: Apple Silicon names its CPU die sensors "PMU tdie1", "PMU tdie2"...
pub fn is_cpu_sensor(name: &str) -> bool {
    name.contains("tdie")
}

/// Linux hwmon drivers that report the CPU itself.
const CPU_DRIVERS: &[&str] = &["coretemp", "k10temp", "zenpower", "cpu_thermal", "cpu-thermal", "soc_thermal"];

/// Linux: the CPU drivers' sensors (name, millidegrees) if there are any,
/// else the hottest thermal zone (type, millidegrees).
pub fn pick_linux(hwmon: &[(String, Vec<i64>)], zones: &[(String, i64)]) -> Option<f32> {
    let c = |m: i64| m as f32 / 1000.0;
    let cpu = hottest(
        hwmon
            .iter()
            .filter(|(name, _)| CPU_DRIVERS.contains(&name.as_str()))
            .flat_map(|(_, temps)| temps.iter().map(|&m| c(m))),
    );
    cpu.or_else(|| hottest(zones.iter().map(|&(_, m)| c(m))))
}

/// Linux: the CPU quota for slowed sessions, half the cores, in µs per second.
pub fn quota_usec(cpus: usize) -> u64 {
    (cpus / 2).max(1) as u64 * 1_000_000
}

pub const SCOPE: &str = "desk-sessions.scope";
const SYSTEMD: [&str; 4] = [
    "org.freedesktop.systemd1",
    "/org/freedesktop/systemd1",
    "org.freedesktop.systemd1.Manager",
    "",
];

/// `busctl --user call` arguments for systemd's Manager `method` with `rest`.
fn busctl_call(method: &str, rest: Vec<String>) -> Vec<String> {
    let mut v: Vec<String> = ["--user", "call"].map(String::from).to_vec();
    v.extend(SYSTEMD[..3].iter().map(|s| s.to_string()));
    v.push(method.into());
    v.extend(rest);
    v
}

/// A new scope holding `pids`, capped at `quota` µs of CPU per second.
pub fn start_args(pids: &[u32], quota: u64) -> Vec<String> {
    let mut rest: Vec<String> = ["ssa(sv)a(sa(sv))", SCOPE, "fail", "2", "PIDs", "au"].map(String::from).to_vec();
    rest.push(pids.len().to_string());
    rest.extend(pids.iter().map(u32::to_string));
    rest.extend(["CPUQuotaPerSecUSec".into(), "t".into(), quota.to_string(), "0".into()]);
    busctl_call("StartTransientUnit", rest)
}

/// Move `pids` into the existing scope.
pub fn attach_args(pids: &[u32]) -> Vec<String> {
    let mut rest: Vec<String> = ["ssau", SCOPE, SYSTEMD[3]].map(String::from).to_vec();
    rest.push(pids.len().to_string());
    rest.extend(pids.iter().map(u32::to_string));
    busctl_call("AttachProcessesToUnit", rest)
}

/// Set the scope's cap; u64::MAX lifts it.
pub fn quota_args(quota: u64) -> Vec<String> {
    let rest = ["sba(sv)", SCOPE, "true", "1", "CPUQuotaPerSecUSec", "t"].map(String::from);
    let mut rest = rest.to_vec();
    rest.push(quota.to_string());
    busctl_call("SetUnitProperties", rest)
}

/// Linux: `/proc/<pid>/cgroup` of a process already in desk's scope.
pub fn in_scope(cgroup: &str) -> bool {
    cgroup.lines().any(|l| l.ends_with(&format!("/{SCOPE}")))
}

struct Inner {
    status: Status,
    policy: Policy,
    fan_policy: StepPolicy,
    fans: Fans,
    os: os::Slower,
    halt: Halt,
    /// Processes the emergency stop froze, to resume exactly those.
    frozen: BTreeSet<u32>,
    /// The sessions when the stop tripped: what they start later is frozen
    /// too, sessions opened since are not.
    halt_roots: Option<Vec<u32>>,
    /// `frozen`, kept on disk so the next start resumes them after a crash.
    marker: PathBuf,
    /// The first reading after start: put back what a crashed desk left slowed.
    first: bool,
    /// desk is quitting: nothing more is slowed.
    stopped: bool,
}

impl Inner {
    /// Freezes what is not frozen yet, forgets what has ended, and keeps the
    /// marker in step.
    fn freeze(&mut self, pids: &[u32], table: &[Proc]) {
        let alive: HashSet<u32> = table.iter().map(|p| p.pid).collect();
        let before = self.frozen.len();
        self.frozen.retain(|p| alive.contains(p));
        let new: Vec<u32> = pids.iter().copied().filter(|p| !self.frozen.contains(p)).collect();
        let done = os::freeze(&new);
        let changed = self.frozen.len() != before || !done.is_empty();
        self.frozen.extend(done);
        if changed {
            self.write_marker();
        }
    }

    /// Everything frozen runs again.
    fn thaw(&mut self) {
        let pids: Vec<u32> = std::mem::take(&mut self.frozen).into_iter().collect();
        os::thaw(&pids);
        self.halt_roots = None;
        self.write_marker();
    }

    fn write_marker(&self) {
        if self.frozen.is_empty() {
            let _ = std::fs::remove_file(&self.marker);
        } else {
            let pids: Vec<String> = self.frozen.iter().map(u32::to_string).collect();
            let _ = std::fs::write(&self.marker, pids.join("\n"));
        }
    }

    /// What a crashed desk left frozen in the sessions runs again.
    fn recover_frozen(&mut self, roots: &[u32], table: &[Proc]) {
        let Ok(text) = std::fs::read_to_string(&self.marker) else { return };
        let _ = std::fs::remove_file(&self.marker);
        let pids = to_thaw(&text, roots, table);
        os::thaw(&pids);
    }
}

/// The pids in a crashed desk's marker that are still in the sessions and
/// stopped (Windows does not say: every one still in the sessions).
pub fn to_thaw(marker: &str, roots: &[u32], table: &[Proc]) -> Vec<u32> {
    let listed: HashSet<u32> = marker.split_whitespace().filter_map(|p| p.parse().ok()).collect();
    let ours: HashSet<u32> = descendants(roots, table).into_iter().collect();
    table
        .iter()
        .filter(|p| listed.contains(&p.pid) && ours.contains(&p.pid) && (p.stopped || p.group.is_none()))
        .map(|p| p.pid)
        .collect()
}

pub struct Guard {
    /// From Options: the mode, the slowing limit, the fan steps and their way down.
    config: Mutex<(Mode, u32, Vec<Step>, StepDown)>,
    /// The emergency stop's limit (`emergency_limit`); 0: off.
    emergency: AtomicU32,
    inner: Mutex<Inner>,
}

impl Guard {
    pub fn new(mode: Mode, limit: u32, steps: Vec<Step>, down: StepDown, emergency: u32, support_dir: &Path) -> Self {
        let fan_steps = if mode.uses_fans() { steps.clone() } else { Vec::new() };
        Self {
            config: Mutex::new((mode, limit, steps, down)),
            emergency: AtomicU32::new(emergency),
            inner: Mutex::new(Inner {
                status: Status {
                    celsius: None,
                    limit: mode.slow_limit(limit),
                    fan_steps,
                    fan_step: None,
                    fan_margin: down.margin,
                    slowed: false,
                    processes: 0,
                    cannot_slow: None,
                    fans: None,
                    emergency,
                    halted: false,
                    frozen: 0,
                    jobs: 0,
                },
                policy: Policy::default(),
                fan_policy: StepPolicy::default(),
                fans: Fans::new(support_dir),
                // A unit struct on macOS and Windows, with state on Linux.
                #[allow(clippy::default_constructed_unit_structs)]
                os: os::Slower::default(),
                halt: Halt::default(),
                frozen: BTreeSet::new(),
                halt_roots: None,
                marker: support_dir.join("halted-pids"),
                first: true,
                stopped: false,
            }),
        }
    }

    pub fn configure(&self, mode: Mode, limit: u32, steps: Vec<Step>, down: StepDown) {
        *self.config.lock().unwrap() = (mode, limit, steps, down);
    }

    /// The emergency stop's limit from Options (`emergency_limit`); 0 turns
    /// it off, which resumes the work at the next reading.
    pub fn set_emergency(&self, limit: u32) {
        self.emergency.store(limit, Ordering::Relaxed);
    }

    /// The user's "resume" after an emergency stop. Refused while the system
    /// is critical, or with the average while not yet RESUME_MARGIN below.
    pub fn resume(&self) -> Result<Status, Refusal> {
        let mut g = self.inner.lock().unwrap();
        g.halt.resume(self.emergency.load(Ordering::Relaxed))?;
        g.thaw();
        g.status.halted = false;
        g.status.frozen = 0;
        g.status.jobs = 0;
        Ok(g.status.clone())
    }

    /// Before removing the permission: the fans back to auto now, if desk set
    /// them, and no forcing until `resume_fans`.
    pub fn pause_fans(&self) {
        self.inner.lock().unwrap().fans.pause();
    }

    pub fn resume_fans(&self) {
        self.inner.lock().unwrap().fans.resume();
    }

    /// The permission is gone: the mode keeps only what it did besides the
    /// fans (Options saves the same).
    pub fn drop_fan_mode(&self) {
        let mut config = self.config.lock().unwrap();
        config.0 = config.0.without_fans();
    }

    pub fn status(&self) -> Status {
        self.inner.lock().unwrap().status.clone()
    }

    /// One reading: decide, then slow the sessions' processes or give them
    /// their speed back. `roots`: the processes the sessions run. Returns the
    /// new status when it changed.
    pub fn tick(&self, celsius: Option<f32>, pressure: bool, roots: impl FnOnce() -> Vec<u32>) -> Option<Status> {
        let mut g = self.inner.lock().unwrap();
        if g.stopped {
            return None;
        }
        let (mode, limit, steps, down) = self.config.lock().unwrap().clone();
        let emergency = self.emergency.load(Ordering::Relaxed);
        let limit = mode.slow_limit(limit);
        let steps = if mode.uses_fans() { steps } else { Vec::new() };
        let now = Instant::now();
        let was = g.status.slowed;
        let slow = g.policy.step(celsius, pressure, limit, now);
        let halt = g.halt.step(celsius, false, emergency);
        g.fan_policy.set_down(down);
        let fan_step = g.fan_policy.step(celsius, pressure, &steps, now);
        if g.first {
            g.fans.recover();
        }
        // Also when the mode just dropped the fans: step releases them.
        let want = fan_step.map(|k| steps[k].percent);
        let fans = (!steps.is_empty() || g.fans.ours()).then(|| g.fans.step(want, now));
        let mut next = Status {
            celsius: celsius.map(|c| c.round() as i32),
            limit,
            fans: fans.filter(|_| !steps.is_empty()),
            fan_steps: steps,
            fan_step,
            fan_margin: down.margin,
            slowed: slow,
            processes: 0,
            cannot_slow: g.status.cannot_slow.clone(),
            emergency,
            halted: halt,
            frozen: 0,
            jobs: 0,
        };
        // The sessions and the process table, read once and only when needed.
        let need = slow || was || g.first || halt || !g.frozen.is_empty();
        let (roots, table) = if need { (roots(), os::processes()) } else { (Vec::new(), Vec::new()) };
        if slow {
            let parts = split(&roots, &table, os::typing);
            g.os.spare(&parts.spare);
            match g.os.slow(&parts.slow) {
                Ok(n) => {
                    next.processes = n;
                    next.cannot_slow = None;
                }
                Err(e) => next.cannot_slow = Some(e),
            }
        } else if was || g.first {
            let pids = descendants(&roots, &table);
            g.os.release(&pids);
        }
        if g.first {
            g.recover_frozen(&roots, &table);
        }
        if halt {
            let halt_roots = g.halt_roots.get_or_insert_with(|| roots.clone()).clone();
            let plan = freeze_plan(&halt_roots, &table);
            g.freeze(&plan.freeze, &table);
            next.frozen = g.frozen.len();
            next.jobs = plan.jobs.len();
        } else if !g.frozen.is_empty() {
            // The stop was turned off in Options.
            g.thaw();
        }
        g.first = false;
        if next == g.status {
            return None;
        }
        g.status = next.clone();
        Some(next)
    }

    /// desk quits: the sessions (tmux keeps them running) get full speed back,
    /// what the emergency stop froze runs again (nothing would be left to
    /// resume it), and the fans go back to auto.
    pub fn shutdown(&self, roots: &[u32]) {
        let mut g = self.inner.lock().unwrap();
        g.stopped = true;
        g.fans.release();
        if !g.frozen.is_empty() {
            g.thaw();
        }
        if g.status.slowed {
            let pids = descendants(roots, &os::processes());
            g.os.release(&pids);
        }
    }
}

/// Every process running now (thermal's table): the CPU panel's on Windows
/// (cpu.rs).
pub fn processes() -> Vec<Proc> {
    os::processes()
}

/// Reads every 5 s on its own thread; `tick` gets the reading and the
/// system's own "too hot".
pub fn spawn(mut tick: impl FnMut(Option<f32>, bool) + Send + 'static) {
    std::thread::spawn(move || {
        let mut sensor = os::Sensor::new();
        loop {
            tick(sensor.read(), os::pressure());
            std::thread::sleep(TICK);
        }
    });
}

/// Whether the terminal takes keys one at a time (raw mode: a shell prompt,
/// an editor, an agent) rather than whole lines (a job printing output).
/// A terminal desk cannot ask counts as typed into: better a job at full
/// speed than stuttering keys.
#[cfg(unix)]
fn tty_takes_keys(tty: Option<&str>) -> bool {
    let Some(tty) = tty else { return false };
    let Ok(path) = std::ffi::CString::new(format!("/dev/{tty}")) else {
        return true;
    };
    // SAFETY: opens and closes a descriptor of its own; O_NOCTTY keeps the
    // terminal from becoming desk's, O_NONBLOCK from waiting on it.
    unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_NOCTTY | libc::O_NONBLOCK);
        if fd < 0 {
            return true;
        }
        let mut t: libc::termios = std::mem::zeroed();
        let ok = libc::tcgetattr(fd, &mut t) == 0;
        libc::close(fd);
        !ok || t.c_lflag & libc::ICANON == 0
    }
}

#[cfg(unix)]
fn ps_processes() -> Vec<Proc> {
    std::process::Command::new("ps")
        .args(["-A", "-o", "pid=,ppid=,pgid=,stat=,tty=,comm="])
        .output()
        .map(|o| parse_ps(&String::from_utf8_lossy(&o.stdout)))
        .unwrap_or_default()
}

/// The emergency stop on macOS and Linux: SIGSTOP, which nothing can catch,
/// and SIGCONT. Returns the pids stopped.
#[cfg(unix)]
fn signal_freeze(pids: &[u32]) -> Vec<u32> {
    pids.iter().copied().filter(|&p| signal(p, libc::SIGSTOP)).collect()
}

#[cfg(unix)]
fn signal_thaw(pids: &[u32]) {
    for &p in pids {
        signal(p, libc::SIGCONT);
    }
}

#[cfg(unix)]
fn signal(pid: u32, sig: libc::c_int) -> bool {
    // Never the kernel, init, a process group (0 or negative) nor desk.
    let Ok(pid) = libc::pid_t::try_from(pid) else { return false };
    if pid <= 1 || pid as u32 == std::process::id() {
        return false;
    }
    // SAFETY: plain syscall on one pid; a gone or foreign process just fails.
    unsafe { libc::kill(pid, sig) == 0 }
}

#[cfg(target_os = "macos")]
mod os {
    use super::{hottest, is_cpu_sensor};
    use std::ffi::{CStr, c_char, c_void};
    use std::ptr::null;

    type CFRef = *const c_void;
    const NUMBER_SINT32: isize = 3;
    const UTF8: u32 = 0x0800_0100;
    const EVENT_TEMPERATURE: i64 = 15;

    #[link(name = "IOKit", kind = "framework")]
    unsafe extern "C" {
        fn IOHIDEventSystemClientCreate(allocator: CFRef) -> CFRef;
        fn IOHIDEventSystemClientSetMatching(client: CFRef, matching: CFRef) -> i32;
        fn IOHIDEventSystemClientCopyServices(client: CFRef) -> CFRef;
        fn IOHIDServiceClientCopyProperty(service: CFRef, key: CFRef) -> CFRef;
        fn IOHIDServiceClientCopyEvent(service: CFRef, kind: i64, options: i32, timestamp: i64) -> CFRef;
        fn IOHIDEventGetFloatValue(event: CFRef, field: i32) -> f64;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        static kCFTypeDictionaryKeyCallBacks: u8;
        static kCFTypeDictionaryValueCallBacks: u8;
        fn CFNumberCreate(allocator: CFRef, kind: isize, value: *const c_void) -> CFRef;
        fn CFDictionaryCreate(
            allocator: CFRef,
            keys: *const CFRef,
            values: *const CFRef,
            count: isize,
            key_callbacks: *const u8,
            value_callbacks: *const u8,
        ) -> CFRef;
        fn CFStringCreateWithCString(allocator: CFRef, s: *const c_char, encoding: u32) -> CFRef;
        fn CFStringGetCString(s: CFRef, buf: *mut c_char, size: isize, encoding: u32) -> u8;
        fn CFArrayGetCount(array: CFRef) -> isize;
        fn CFArrayGetValueAtIndex(array: CFRef, i: isize) -> CFRef;
        fn CFRetain(x: CFRef) -> CFRef;
        fn CFRelease(x: CFRef);
    }

    unsafe fn cf_str(s: &CStr) -> CFRef {
        unsafe { CFStringCreateWithCString(null(), s.as_ptr(), UTF8) }
    }

    unsafe fn cf_int(n: i32) -> CFRef {
        unsafe { CFNumberCreate(null(), NUMBER_SINT32, (&raw const n).cast()) }
    }

    unsafe fn rust_str(s: CFRef) -> String {
        let mut buf = [0 as c_char; 128];
        if unsafe { CFStringGetCString(s, buf.as_mut_ptr(), buf.len() as isize, UTF8) } == 0 {
            return String::new();
        }
        unsafe { CStr::from_ptr(buf.as_ptr()) }.to_string_lossy().into_owned()
    }

    /// The CPU die sensors, found once and read every tick.
    pub struct Sensor {
        client: CFRef,
        dies: Vec<CFRef>,
    }

    impl Sensor {
        pub fn new() -> Self {
            let mut dies = Vec::new();
            // SAFETY: CoreFoundation create/copy results are released below;
            // the sensors kept are retained and released in Drop.
            unsafe {
                let client = IOHIDEventSystemClientCreate(null());
                if client.is_null() {
                    return Self { client, dies };
                }
                // Apple's vendor page (0xff00), usage 5: temperature sensors.
                let keys = [cf_str(c"PrimaryUsagePage"), cf_str(c"PrimaryUsage")];
                let values = [cf_int(0xff00), cf_int(5)];
                let matching = CFDictionaryCreate(
                    null(),
                    keys.as_ptr(),
                    values.as_ptr(),
                    2,
                    &raw const kCFTypeDictionaryKeyCallBacks,
                    &raw const kCFTypeDictionaryValueCallBacks,
                );
                IOHIDEventSystemClientSetMatching(client, matching);
                for x in keys.into_iter().chain(values).chain([matching]) {
                    CFRelease(x);
                }
                let services = IOHIDEventSystemClientCopyServices(client);
                if !services.is_null() {
                    let product = cf_str(c"Product");
                    for i in 0..CFArrayGetCount(services) {
                        let service = CFArrayGetValueAtIndex(services, i);
                        let name = IOHIDServiceClientCopyProperty(service, product);
                        if name.is_null() {
                            continue;
                        }
                        if is_cpu_sensor(&rust_str(name)) {
                            dies.push(CFRetain(service));
                        }
                        CFRelease(name);
                    }
                    CFRelease(product);
                    CFRelease(services);
                }
                Self { client, dies }
            }
        }

        pub fn read(&mut self) -> Option<f32> {
            hottest(self.dies.iter().filter_map(|&service| {
                // SAFETY: `service` is retained by self; the event is released.
                unsafe {
                    let event = IOHIDServiceClientCopyEvent(service, EVENT_TEMPERATURE, 0, 0);
                    if event.is_null() {
                        return None;
                    }
                    let c = IOHIDEventGetFloatValue(event, (EVENT_TEMPERATURE as i32) << 16);
                    CFRelease(event);
                    Some(c as f32)
                }
            }))
        }
    }

    impl Drop for Sensor {
        fn drop(&mut self) {
            // SAFETY: each was retained (or created) by this Sensor.
            unsafe {
                for &s in &self.dies {
                    CFRelease(s);
                }
                if !self.client.is_null() {
                    CFRelease(self.client);
                }
            }
        }
    }

    /// The system's thermal state is serious or critical.
    pub fn pressure() -> bool {
        use objc2_foundation::{NSProcessInfo, NSProcessInfoThermalState};
        NSProcessInfo::processInfo().thermalState().0 >= NSProcessInfoThermalState::Serious.0
    }

    pub fn processes() -> Vec<super::Proc> {
        super::ps_processes()
    }

    pub fn typing(tty: Option<&str>) -> bool {
        super::tty_takes_keys(tty)
    }

    pub fn freeze(pids: &[u32]) -> Vec<u32> {
        super::signal_freeze(pids)
    }

    pub fn thaw(pids: &[u32]) {
        super::signal_thaw(pids)
    }

    #[derive(Default)]
    pub struct Slower;

    impl Slower {
        pub fn slow(&mut self, pids: &[u32]) -> Result<usize, String> {
            Ok(pids.iter().filter(|&&p| set_background(p, true)).count())
        }

        pub fn release(&mut self, pids: &[u32]) {
            for &p in pids {
                set_background(p, false);
            }
        }

        /// Full speed for what is never slowed: one desk slowed before this
        /// rule, or a program that went from a job to taking keys.
        pub fn spare(&mut self, pids: &[u32]) {
            self.release(pids);
        }
    }

    fn set_background(pid: u32, on: bool) -> bool {
        let prio = if on { libc::PRIO_DARWIN_BG } else { 0 };
        // SAFETY: plain syscall on a pid; a gone or foreign process just fails.
        unsafe { libc::setpriority(libc::PRIO_DARWIN_PROCESS, pid, prio) == 0 }
    }
}

#[cfg(target_os = "linux")]
mod os {
    use super::{attach_args, in_scope, pick_linux, quota_args, quota_usec, start_args};
    use std::fs;
    use std::process::Command;

    pub struct Sensor;

    impl Sensor {
        pub fn new() -> Self {
            Self
        }

        pub fn read(&mut self) -> Option<f32> {
            let read = |p: std::path::PathBuf| fs::read_to_string(p).ok().map(|s| s.trim().to_string());
            let hwmon: Vec<(String, Vec<i64>)> = fs::read_dir("/sys/class/hwmon")
                .into_iter()
                .flatten()
                .flatten()
                .filter_map(|e| {
                    let dir = e.path();
                    let name = read(dir.join("name"))?;
                    let temps = fs::read_dir(&dir)
                        .into_iter()
                        .flatten()
                        .flatten()
                        .filter(|f| {
                            let n = f.file_name().to_string_lossy().into_owned();
                            n.starts_with("temp") && n.ends_with("_input")
                        })
                        .filter_map(|f| read(f.path())?.parse().ok())
                        .collect();
                    Some((name, temps))
                })
                .collect();
            let zones: Vec<(String, i64)> = fs::read_dir("/sys/class/thermal")
                .into_iter()
                .flatten()
                .flatten()
                .filter(|e| e.file_name().to_string_lossy().starts_with("thermal_zone"))
                .filter_map(|e| {
                    let kind = read(e.path().join("type")).unwrap_or_default();
                    Some((kind, read(e.path().join("temp"))?.parse().ok()?))
                })
                .collect();
            pick_linux(&hwmon, &zones)
        }
    }

    pub fn pressure() -> bool {
        false
    }

    pub fn processes() -> Vec<super::Proc> {
        super::ps_processes()
    }

    pub fn typing(tty: Option<&str>) -> bool {
        super::tty_takes_keys(tty)
    }

    pub fn freeze(pids: &[u32]) -> Vec<u32> {
        super::signal_freeze(pids)
    }

    pub fn thaw(pids: &[u32]) {
        super::signal_thaw(pids)
    }

    fn busctl(args: &[String]) -> Result<(), String> {
        let out = Command::new("busctl")
            .args(args)
            .output()
            .map_err(|e| format!("busctl: {e}"))?;
        if out.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&out.stderr).trim().to_string())
        }
    }

    /// The sessions' processes in a systemd user scope with a CPU cap.
    #[derive(Default)]
    pub struct Slower {
        capped: bool,
    }

    impl Slower {
        pub fn slow(&mut self, pids: &[u32]) -> Result<usize, String> {
            let quota = quota_usec(std::thread::available_parallelism().map_or(2, |n| n.get()));
            let outside: Vec<u32> = pids
                .iter()
                .copied()
                .filter(|p| !fs::read_to_string(format!("/proc/{p}/cgroup")).is_ok_and(|c| in_scope(&c)))
                .collect();
            if !outside.is_empty() && busctl(&attach_args(&outside)).is_err() {
                // No scope yet (or it ended with its last process).
                busctl(&start_args(&outside, quota))
                    .map_err(|e| format!("systemd ({e})"))?;
                self.capped = true;
            }
            if !self.capped {
                busctl(&quota_args(quota)).map_err(|e| format!("systemd ({e})"))?;
                self.capped = true;
            }
            Ok(pids.len())
        }

        /// Lifts the cap, whether this desk set it or one before it did.
        pub fn release(&mut self, _pids: &[u32]) {
            let _ = busctl(&quota_args(u64::MAX));
            self.capped = false;
        }

        /// Nothing to do: what is spared is never moved into the scope. (A
        /// process an older desk put there stays capped until it cools down.)
        pub fn spare(&mut self, _pids: &[u32]) {}
    }
}

#[cfg(windows)]
mod os {
    use super::hottest;
    use std::ffi::c_void;
    use windows::Win32::Foundation::CloseHandle;
    use std::collections::HashSet;
    use windows::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
        TH32CS_SNAPTHREAD, THREADENTRY32, Thread32First, Thread32Next,
    };
    use windows::Win32::System::Performance::{
        PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT_DOUBLE, PDH_HCOUNTER, PDH_HQUERY, PdhAddEnglishCounterW,
        PdhCloseQuery, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW,
    };
    use windows::Win32::System::Threading::{
        OpenProcess, OpenThread, PROCESS_POWER_THROTTLING_CURRENT_VERSION, PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
        PROCESS_POWER_THROTTLING_STATE, PROCESS_SET_INFORMATION, ProcessPowerThrottling, ResumeThread,
        SetProcessInformation, SuspendThread, THREAD_SUSPEND_RESUME,
    };
    use windows::core::{PCWSTR, w};

    /// The "Thermal Zone Information" counter, in kelvin.
    pub struct Sensor {
        query: PDH_HQUERY,
        counter: Option<PDH_HCOUNTER>,
    }

    impl Sensor {
        pub fn new() -> Self {
            let mut query = PDH_HQUERY::default();
            let mut counter = PDH_HCOUNTER::default();
            // SAFETY: out-pointers to locals; the query is closed in Drop.
            unsafe {
                if PdhOpenQueryW(PCWSTR::null(), 0, &mut query) != 0 {
                    return Self { query, counter: None };
                }
                let ok = PdhAddEnglishCounterW(query, w!("\\Thermal Zone Information(*)\\Temperature"), 0, &mut counter) == 0;
                Self { query, counter: ok.then_some(counter) }
            }
        }

        pub fn read(&mut self) -> Option<f32> {
            let counter = self.counter?;
            // SAFETY: the buffer is sized by PDH's first call and outlives the second.
            unsafe {
                if PdhCollectQueryData(self.query) != 0 {
                    return None;
                }
                let (mut size, mut count) = (0u32, 0u32);
                let _ = PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, None);
                if size == 0 {
                    return None;
                }
                let n = size as usize / size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>() + 1;
                let mut items = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); n];
                if PdhGetFormattedCounterArrayW(counter, PDH_FMT_DOUBLE, &mut size, &mut count, Some(items.as_mut_ptr())) != 0 {
                    return None;
                }
                hottest(
                    items[..(count as usize).min(n)]
                        .iter()
                        .filter(|i| i.FmtValue.CStatus == 0)
                        .map(|i| (i.FmtValue.Anonymous.doubleValue - 273.15) as f32),
                )
            }
        }
    }

    impl Drop for Sensor {
        fn drop(&mut self) {
            // SAFETY: opened in new().
            unsafe {
                let _ = PdhCloseQuery(self.query);
            }
        }
    }

    pub fn pressure() -> bool {
        false
    }

    pub fn processes() -> Vec<super::Proc> {
        let mut out = Vec::new();
        // SAFETY: the snapshot handle is closed below; the entry is sized.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) else {
                return out;
            };
            let mut e = PROCESSENTRY32W {
                dwSize: size_of::<PROCESSENTRY32W>() as u32,
                ..Default::default()
            };
            if Process32FirstW(snap, &mut e).is_ok() {
                loop {
                    let len = e.szExeFile.iter().position(|&c| c == 0).unwrap_or(e.szExeFile.len());
                    out.push(super::Proc {
                        pid: e.th32ProcessID,
                        parent: e.th32ParentProcessID,
                        name: super::program_name(&String::from_utf16_lossy(&e.szExeFile[..len])),
                        tty: None,
                        group: None,
                        stopped: false,
                    });
                    if Process32NextW(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    /// Windows does not say what a console is doing: the program a shell
    /// runs always counts as typed into, only what it starts is slowed.
    pub fn typing(_tty: Option<&str>) -> bool {
        true
    }

    /// The emergency stop on Windows: every thread of each process suspended,
    /// as Resource Monitor's "Suspend process" does. Twice over, so a thread
    /// started meanwhile by one not yet suspended is caught too. Returns the
    /// pids with a thread suspended.
    pub fn freeze(pids: &[u32]) -> Vec<u32> {
        let want: HashSet<u32> = pids.iter().copied().collect();
        let (mut done, mut seen) = (HashSet::new(), HashSet::new());
        for _ in 0..2 {
            for (pid, tid) in threads(&want) {
                if seen.insert(tid) && suspend(tid, true) {
                    done.insert(pid);
                }
            }
        }
        pids.iter().copied().filter(|p| done.contains(p)).collect()
    }

    /// Each thread resumed once: back to where it was before `freeze`.
    pub fn thaw(pids: &[u32]) {
        let want: HashSet<u32> = pids.iter().copied().collect();
        for (_, tid) in threads(&want) {
            suspend(tid, false);
        }
    }

    /// (process, thread) for every thread of `pids`.
    fn threads(pids: &HashSet<u32>) -> Vec<(u32, u32)> {
        let mut out = Vec::new();
        if pids.is_empty() {
            return out;
        }
        // SAFETY: the snapshot handle is closed below; the entry is sized.
        unsafe {
            let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) else {
                return out;
            };
            let mut e = THREADENTRY32 {
                dwSize: size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            if Thread32First(snap, &mut e).is_ok() {
                loop {
                    if pids.contains(&e.th32OwnerProcessID) {
                        out.push((e.th32OwnerProcessID, e.th32ThreadID));
                    }
                    if Thread32Next(snap, &mut e).is_err() {
                        break;
                    }
                }
            }
            let _ = CloseHandle(snap);
        }
        out
    }

    fn suspend(tid: u32, on: bool) -> bool {
        // SAFETY: the handle is closed; a gone or foreign thread just fails.
        unsafe {
            let Ok(h) = OpenThread(THREAD_SUSPEND_RESUME, false, tid) else {
                return false;
            };
            let count = if on { SuspendThread(h) } else { ResumeThread(h) };
            let _ = CloseHandle(h);
            count != u32::MAX
        }
    }

    #[derive(Default)]
    pub struct Slower;

    impl Slower {
        pub fn slow(&mut self, pids: &[u32]) -> Result<usize, String> {
            Ok(pids.iter().filter(|&&p| eco(p, true)).count())
        }

        pub fn release(&mut self, pids: &[u32]) {
            for &p in pids {
                eco(p, false);
            }
        }

        pub fn spare(&mut self, pids: &[u32]) {
            self.release(pids);
        }
    }

    /// EcoQoS on (efficiency mode) or back to the system's default.
    fn eco(pid: u32, on: bool) -> bool {
        let mask = if on { PROCESS_POWER_THROTTLING_EXECUTION_SPEED } else { 0 };
        let state = PROCESS_POWER_THROTTLING_STATE {
            Version: PROCESS_POWER_THROTTLING_CURRENT_VERSION,
            ControlMask: mask,
            StateMask: mask,
        };
        // SAFETY: the handle is closed; `state` outlives the call.
        unsafe {
            let Ok(h) = OpenProcess(PROCESS_SET_INFORMATION, false, pid) else {
                return false;
            };
            let ok = SetProcessInformation(
                h,
                ProcessPowerThrottling,
                (&raw const state).cast::<c_void>(),
                size_of::<PROCESS_POWER_THROTTLING_STATE>() as u32,
            )
            .is_ok();
            let _ = CloseHandle(h);
            ok
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(p: &mut Policy, readings: &[f32], limit: u32, start: Instant, every: u64) -> Vec<bool> {
        readings
            .iter()
            .enumerate()
            .map(|(i, &c)| p.step(Some(c), false, limit, start + Duration::from_secs(i as u64 * every)))
            .collect()
    }

    #[test]
    fn slows_when_the_average_reaches_the_limit_not_on_one_spike() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert_eq!(run(&mut p, &[60.0, 95.0, 60.0, 60.0], 75, t, 5), [false, false, false, false]);
        let mut p = Policy::default();
        assert_eq!(run(&mut p, &[74.0, 76.0, 76.0], 75, t, 5), [false, false, true]);
    }

    #[test]
    fn full_speed_back_only_well_below_the_limit_and_after_a_minute() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert_eq!(run(&mut p, &[80.0, 80.0, 80.0], 75, t, 5), [false, false, true]);
        // Under the limit but not 7 °C under: still slowed.
        let s = |p: &mut Policy, c, secs| p.step(Some(c), false, 75, t + Duration::from_secs(secs));
        for secs in [15, 20, 25] {
            assert!(s(&mut p, 70.0, secs));
        }
        // Cool, but within the first minute.
        for secs in [30, 35, 40] {
            assert!(s(&mut p, 60.0, secs));
        }
        assert!(!s(&mut p, 60.0, 70));
    }

    #[test]
    fn the_system_saying_too_hot_slows_without_a_sensor() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert!(p.step(None, true, 75, t));
        assert!(p.step(None, false, 75, t + Duration::from_secs(30)));
        assert!(!p.step(None, false, 75, t + Duration::from_secs(61)));
    }

    #[test]
    fn limit_zero_never_slows() {
        let mut p = Policy::default();
        let t = Instant::now();
        assert_eq!(run(&mut p, &[99.0, 99.0, 99.0], 0, t, 5), [false, false, false]);
        assert!(!p.step(None, true, 0, t));
        // Turned off while slowed: back at once.
        assert!(p.step(Some(99.0), false, 75, t));
        assert!(!p.step(Some(99.0), false, 0, t));
    }

    #[test]
    fn modes_slow_and_use_the_fans() {
        let all = [Mode::Off, Mode::Slow, Mode::Together, Mode::Fans];
        assert_eq!(all.map(|m| m.slow_limit(75)), [0, 75, 75, 0]);
        assert_eq!(all.map(Mode::uses_fans), [false, false, true, true]);
        assert_eq!(Mode::Slow.slow_limit(10), 50);
    }

    #[test]
    fn without_fans_keeps_what_a_mode_did_besides() {
        assert_eq!(
            [Mode::Off, Mode::Slow, Mode::Together, Mode::Fans].map(Mode::without_fans),
            [Mode::Off, Mode::Slow, Mode::Slow, Mode::Off]
        );
    }

    #[test]
    fn mode_names() {
        for (name, mode) in [
            ("off", Mode::Off),
            ("slow", Mode::Slow),
            ("fansFirst", Mode::Together),
            ("together", Mode::Together),
            ("fans", Mode::Fans),
        ] {
            assert_eq!(Mode::parse(name), mode);
        }
        assert_eq!(Mode::parse("x"), Mode::Slow);
    }

    #[test]
    fn fan_and_slow_policies_are_independent() {
        let t = Instant::now();
        let (mut fans, mut slow) = (StepPolicy::default(), Policy::default());
        let steps = [st(70, 100)];
        let fan_steps: Vec<_> =
            (0..3).map(|i| fans.step(Some(72.0), false, &steps, t + Duration::from_secs(5 * i))).collect();
        assert_eq!(fan_steps, [None, None, Some(0)]);
        assert_eq!(run(&mut slow, &[72.0, 72.0, 72.0], 75, t, 5), [false, false, false]);
    }

    fn proc(pid: u32, parent: u32, name: &str, tty: Option<&str>) -> Proc {
        Proc {
            pid,
            parent,
            name: name.into(),
            tty: tty.map(String::from),
            group: None,
            stopped: false,
        }
    }

    /// A process in process group `group`, stopped or not.
    fn in_group(pid: u32, parent: u32, name: &str, group: u32, stopped: bool) -> Proc {
        Proc {
            group: Some(group),
            stopped,
            ..proc(pid, parent, name, Some("ttys009"))
        }
    }

    #[test]
    fn descendants_of_live_sessions_only() {
        let table: Vec<Proc> = [(1, 0), (10, 1), (11, 10), (12, 11), (13, 10), (20, 1), (21, 20)]
            .iter()
            .map(|&(pid, parent)| proc(pid, parent, "x", None))
            .collect();
        assert_eq!(descendants(&[10], &table), [10, 11, 12, 13]);
        // A session gone (99) adds nothing; init and desk are never in.
        assert_eq!(descendants(&[99, 20], &table), [20, 21]);
        assert_eq!(descendants(&[1], &table), Vec::<u32>::new());
        let me = std::process::id();
        assert_eq!(descendants(&[me], &[proc(me, 1, "desk", None), proc(me + 1, me, "x", None)]), Vec::<u32>::new());
    }

    /// A terminal takes keys one at a time (raw mode) or not.
    fn raw(ttys: &'static [&'static str]) -> impl Fn(Option<&str>) -> bool {
        move |tty| tty.is_some_and(|t| ttys.contains(&t))
    }

    #[test]
    fn the_agent_you_type_into_keeps_full_speed_and_what_it_runs_is_slowed() {
        // A Claude tile as desk starts it: zsh -lc 'claude ...; exec zsh -l'.
        let t = Some("ttys000");
        let table = [
            proc(1, 0, "launchd", None),
            proc(100, 1, "tmux", None),
            proc(200, 100, "zsh", t),
            proc(210, 200, "claude", t),
            proc(220, 210, "node", t),         // an MCP server
            proc(230, 210, "zsh", None),       // the agent's Bash tool
            proc(231, 230, "node", None),      // pnpm test
            proc(232, 231, "node", None),      // a vitest worker
        ];
        let s = split(&[200], &table, raw(&["ttys000"]));
        assert_eq!(s.spare, [200, 210]);
        assert_eq!(s.slow, [220, 230, 231, 232]);
    }

    #[test]
    fn a_shell_and_the_editor_in_it_keep_full_speed() {
        let t = Some("ttys001");
        let table = [
            proc(300, 1, "zsh", t),
            proc(310, 300, "nvim", t),
            proc(311, 310, "node", None), // a language server
        ];
        let s = split(&[300], &table, raw(&["ttys001"]));
        assert_eq!(s.spare, [300, 310]);
        assert_eq!(s.slow, [311]);
        // The shell alone at its prompt.
        assert_eq!(split(&[300], &table[..1], raw(&["ttys001"])), Split { slow: vec![], spare: vec![300] });
    }

    #[test]
    fn tests_started_from_a_shell_are_slowed_whole() {
        // `pnpm test` typed at a prompt: the terminal is not taking single
        // keys, nobody types into pnpm.
        let t = Some("ttys002");
        let table = [
            proc(400, 1, "zsh", t),
            proc(410, 400, "node", t),
            proc(411, 410, "node", t),
            proc(420, 400, "zsh", t), // a subshell: still a shell
            proc(421, 420, "cargo", t),
        ];
        let s = split(&[400], &table, raw(&[]));
        assert_eq!(s.spare, [400, 420]);
        assert_eq!(s.slow, [410, 411, 421]);
    }

    #[test]
    fn a_session_that_is_one_program_follows_its_terminal() {
        let table = [proc(500, 1, "htop", Some("pts/3")), proc(600, 1, "node", Some("pts/4")), proc(601, 600, "node", Some("pts/4"))];
        let s = split(&[500, 600, 999], &table, raw(&["pts/3"]));
        assert_eq!(s.spare, [500]);
        assert_eq!(s.slow, [600, 601]);
    }

    #[test]
    fn reads_ps() {
        let out = "    1     0     1 Ss   ??       /sbin/launchd\n 2299  2297  2299 Ss   ttys000  -zsh\nbad line\n 2319  2299  2299 S+   ttys000  /Users/x/Application Support/bin/claude\n   77     1     0 I    ?        kworker\n  900   412   900 T    pts/3    bash\n";
        let with = |p: Proc, group: u32, stopped: bool| Proc { group: Some(group), stopped, ..p };
        assert_eq!(
            parse_ps(out),
            [
                with(proc(1, 0, "launchd", None), 1, false),
                with(proc(2299, 2297, "zsh", Some("ttys000")), 2299, false),
                with(proc(2319, 2299, "claude", Some("ttys000")), 2299, false),
                with(proc(77, 1, "kworker", None), 0, false),
                with(proc(900, 412, "bash", Some("pts/3")), 900, true),
            ]
        );
        assert_eq!(program_name("C:\\Program Files\\PowerShell\\7\\pwsh.exe"), "pwsh");
    }

    #[test]
    fn hottest_skips_dead_sensors() {
        // Apple Silicon's "tdev" sensors read about -9200 °C.
        assert_eq!(hottest([72.5, -9201.1, 86.3, 0.0, 400.0]), Some(86.3));
        assert_eq!(hottest([]), None);
        assert!(is_cpu_sensor("PMU tdie1") && is_cpu_sensor("PMU tdie14"));
        assert!(!is_cpu_sensor("PMU tdev1") && !is_cpu_sensor("gas gauge battery") && !is_cpu_sensor("NAND CH0 temp"));
    }

    #[test]
    fn linux_prefers_cpu_drivers_over_zones() {
        let hwmon = vec![
            ("nvme".to_string(), vec![41_000]),
            ("coretemp".to_string(), vec![61_000, 67_500]),
            ("iwlwifi_1".to_string(), vec![90_000]),
        ];
        let zones = vec![("acpitz".to_string(), 27_800), ("x86_pkg_temp".to_string(), 66_000)];
        assert_eq!(pick_linux(&hwmon, &zones), Some(67.5));
        assert_eq!(pick_linux(&hwmon[..1], &zones), Some(66.0));
        assert_eq!(pick_linux(&[], &[]), None);
    }

    /// `cargo test reads_this_computer -- --ignored --nocapture`
    #[test]
    #[ignore = "reads this computer's sensors"]
    fn reads_this_computer() {
        let c = os::Sensor::new().read();
        println!("CPU: {c:?} °C, pressure: {}", os::pressure());
        assert!(c.is_some());
    }

    /// What desk would slow and spare right now in the sessions whose root
    /// pids are in DESK_ROOTS (`tmux -L desk list-panes -a -F '#{pane_pid}'`):
    /// `DESK_ROOTS="$(...)" cargo test splits_this_computer -- --ignored --nocapture`
    #[cfg(unix)]
    #[test]
    #[ignore = "reads this computer's processes"]
    fn splits_this_computer() {
        let roots: Vec<u32> = std::env::var("DESK_ROOTS")
            .unwrap_or_default()
            .split_whitespace()
            .filter_map(|p| p.parse().ok())
            .collect();
        let table = os::processes();
        let parts = split(&roots, &table, os::typing);
        let show = |pids: &[u32]| {
            let mut names: HashMap<&str, usize> = HashMap::new();
            for p in table.iter().filter(|p| pids.contains(&p.pid)) {
                *names.entry(&p.name).or_default() += 1;
            }
            let mut names: Vec<_> = names.into_iter().collect();
            names.sort();
            format!("{names:?}")
        };
        println!("spared {}: {}", parts.spare.len(), show(&parts.spare));
        println!("slowed {}: {}", parts.slow.len(), show(&parts.slow));
        assert!(!roots.is_empty() && !parts.spare.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn slows_a_process_and_gives_it_its_speed_back() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        // getpriority() only reports this for the calling process; ps shows
        // the scheduling priority: 31 normally, 4 in the background.
        let background = || {
            let out = std::process::Command::new("ps")
                .args(["-o", "pri=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim() == "4"
        };
        let mut s = os::Slower;
        // Started from a session desk is slowing right now, it inherits that.
        s.release(&[pid]);
        assert!(!background());
        assert_eq!(s.slow(&[pid]), Ok(1));
        assert!(background());
        s.release(&[pid]);
        assert!(!background());
        assert_eq!(s.slow(&[pid]), Ok(1));
        s.spare(&[pid]);
        assert!(!background());
        let _ = child.kill();
        let _ = child.wait();
    }

    /// A real terminal: line mode as a job leaves it, then raw as an editor sets it.
    #[cfg(unix)]
    #[test]
    fn tells_a_terminal_taking_keys_from_one_running_a_job() {
        let (mut master, mut slave) = (0, 0);
        // SAFETY: openpty fills the two descriptors, closed below.
        unsafe {
            assert_eq!(libc::openpty(&mut master, &mut slave, std::ptr::null_mut(), std::ptr::null_mut(), std::ptr::null_mut()), 0);
            let name = std::ffi::CStr::from_ptr(libc::ttyname(slave)).to_string_lossy().into_owned();
            let tty = name.strip_prefix("/dev/").unwrap();
            assert!(!tty_takes_keys(Some(tty)));
            let mut t: libc::termios = std::mem::zeroed();
            libc::tcgetattr(slave, &mut t);
            libc::cfmakeraw(&mut t);
            libc::tcsetattr(slave, libc::TCSANOW, &t);
            assert!(tty_takes_keys(Some(tty)));
            libc::close(slave);
            libc::close(master);
        }
        assert!(!tty_takes_keys(None));
    }

    #[test]
    fn systemd_calls() {
        let head = "--user call org.freedesktop.systemd1 /org/freedesktop/systemd1 org.freedesktop.systemd1.Manager";
        assert_eq!(
            start_args(&[10, 11], 4_000_000).join(" "),
            format!("{head} StartTransientUnit ssa(sv)a(sa(sv)) desk-sessions.scope fail 2 PIDs au 2 10 11 CPUQuotaPerSecUSec t 4000000 0")
        );
        let attach = attach_args(&[12]);
        assert_eq!(attach[6..], ["ssau", "desk-sessions.scope", "", "1", "12"]);
        assert_eq!(
            quota_args(u64::MAX).join(" "),
            format!("{head} SetUnitProperties sba(sv) desk-sessions.scope true 1 CPUQuotaPerSecUSec t 18446744073709551615")
        );
        assert_eq!([1, 2, 8, 18].map(quota_usec), [1_000_000, 1_000_000, 4_000_000, 9_000_000]);
        assert!(in_scope("0::/user.slice/user-1000.slice/user@1000.service/desk-sessions.scope\n"));
        assert!(!in_scope("0::/user.slice/user-1000.slice/user@1000.service/app.slice/app-desk.scope\n"));
    }

    fn st(celsius: u32, percent: u8) -> Step {
        Step { celsius, percent }
    }

    fn s3() -> Vec<Step> {
        vec![st(65, 50), st(72, 70), st(80, 100)]
    }

    /// A full window of the same reading.
    fn hold(p: &mut StepPolicy, c: f32, steps: &[Step], t: Instant) -> Option<usize> {
        (0..3).map(|_| p.step(Some(c), false, steps, t)).last().unwrap()
    }

    #[test]
    fn normalize_repairs_any_table() {
        assert_eq!(normalize_steps(vec![]), vec![st(70, 100)]);
        assert_eq!(normalize_steps(vec![st(80, 100), st(65, 50)]), vec![st(65, 50), st(80, 100)]);
        assert_eq!(normalize_steps(vec![st(30, 45), st(120, 100)]), vec![st(50, 50), st(100, 100)]);
        assert_eq!(normalize_steps(vec![st(70, 90), st(80, 60)]), vec![st(70, 90), st(80, 90)]);
        assert_eq!(normalize_steps(vec![st(70, 50), st(70, 80)]), vec![st(70, 80)]);
        assert_eq!(normalize_steps(vec![st(70, 0)]), vec![st(70, 40)]);
        let six = (0..6).map(|i| st(60 + i * 5, 40 + i as u8 * 10)).collect();
        assert_eq!(normalize_steps(six), vec![st(60, 40), st(65, 50), st(70, 60), st(75, 70)]);
    }

    #[test]
    fn steps_up_at_once_even_several() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 60.0, &s3(), t), None);
        assert_eq!(hold(&mut p, 74.0, &s3(), t), Some(1));
        assert_eq!(hold(&mut p, 85.0, &s3(), t), Some(2));
        assert_eq!(hold(&mut StepPolicy::default(), 85.0, &s3(), t), Some(2));
    }

    #[test]
    fn steps_down_only_well_below_and_after_a_minute() {
        let t = Instant::now();
        let s = Duration::from_secs;
        let steps = vec![st(60, 50), st(72, 70), st(80, 100)];
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 74.0, &steps, t), Some(1));
        assert_eq!(hold(&mut p, 68.0, &steps, t + s(10)), Some(1)); // above 72 − 7
        assert_eq!(hold(&mut p, 64.0, &steps, t + s(20)), Some(1)); // low enough, but not a minute yet
        assert_eq!(hold(&mut p, 64.0, &steps, t + s(61)), Some(0));
        assert_eq!(hold(&mut p, 57.0, &steps, t + s(122)), None); // below the first limit, though above 60 − 7
    }

    #[test]
    fn steps_down_straight_to_the_right_step() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        let steps = vec![st(60, 50), st(72, 70), st(80, 100)];
        assert_eq!(hold(&mut p, 85.0, &steps, t), Some(2));
        // Cooled within the minute: nothing yet, then straight to the first step.
        assert_eq!(hold(&mut p, 62.0, &steps, t + Duration::from_secs(30)), Some(2));
        assert_eq!(p.step(Some(62.0), false, &steps, t + Duration::from_secs(61)), Some(0));
    }

    #[test]
    fn the_way_down_follows_the_settings() {
        // 3°C under the step and 15 s since the last change, instead of 7°C and a minute.
        let t = Instant::now();
        let s = Duration::from_secs;
        let steps = vec![st(60, 50), st(72, 70)];
        let mut p = StepPolicy::default();
        p.set_down(StepDown::new(3, 15));
        assert_eq!(hold(&mut p, 74.0, &steps, t), Some(1));
        assert_eq!(hold(&mut p, 68.0, &steps, t + s(10)), Some(1)); // low enough, not 15 s yet
        assert_eq!(hold(&mut p, 68.0, &steps, t + s(16)), Some(0)); // 68 < 72 − 3
    }

    #[test]
    fn no_margin_comes_down_right_under_the_step() {
        // 0°C: down once the average is under the step's own limit, after the wait; an average
        // sitting right on the limit holds the step instead of flapping every 15 s.
        let t = Instant::now();
        let s = Duration::from_secs;
        let steps = vec![st(60, 50), st(72, 70)];
        let mut p = StepPolicy::default();
        p.set_down(StepDown::new(0, 15));
        assert_eq!(hold(&mut p, 74.0, &steps, t), Some(1));
        assert_eq!(hold(&mut p, 72.0, &steps, t + s(20)), Some(1));
        assert_eq!(hold(&mut p, 72.0, &steps, t + s(40)), Some(1));
        assert_eq!(hold(&mut p, 71.0, &steps, t + s(60)), Some(0));
        assert_eq!(hold(&mut p, 59.0, &steps, t + s(80)), None);
    }

    #[test]
    fn the_way_down_is_clamped_to_what_options_offer() {
        assert_eq!(StepDown::new(0, 1), StepDown { margin: 0, wait: 15 });
        assert_eq!(StepDown::new(40, 9999), StepDown { margin: 15, wait: 300 });
        assert_eq!(StepDown::default(), StepDown { margin: 7, wait: 60 });
    }

    #[test]
    fn below_the_first_limit_macos_has_the_fans() {
        // Idle at 48°C with the first step at 50°C: back to auto, not at 43°C.
        let t = Instant::now();
        let steps = vec![st(50, 60), st(70, 80)];
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 52.0, &steps, t), Some(0));
        assert_eq!(hold(&mut p, 48.0, &steps, t + Duration::from_secs(30)), Some(0));
        assert_eq!(hold(&mut p, 48.0, &steps, t + Duration::from_secs(61)), None);
        // A step whose margin reaches below the first limit gives way there too.
        let close = vec![st(50, 60), st(55, 80)];
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 56.0, &close, t), Some(1));
        assert_eq!(hold(&mut p, 49.0, &close, t + Duration::from_secs(61)), None);
    }

    #[test]
    fn the_minute_counts_from_every_change() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 85.0, &s3(), t), Some(2));
        // A minute later it has cooled to 70°C: one step down.
        assert_eq!(hold(&mut p, 70.0, &s3(), t + Duration::from_secs(61)), Some(1));
        // Cooler still right after: the next change waits another minute.
        assert_eq!(hold(&mut p, 55.0, &s3(), t + Duration::from_secs(66)), Some(1));
        assert_eq!(hold(&mut p, 55.0, &s3(), t + Duration::from_secs(122)), None);
    }

    #[test]
    fn an_edited_table_never_holds_the_fans_above_it() {
        // "Chłodno" at 70°C holds 68 → 80%; the user deletes the first row.
        let t = Instant::now();
        let cool = vec![st(60, 60), st(68, 80), st(75, 100)];
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 70.0, &cool, t), Some(1));
        let edited = vec![st(68, 80), st(75, 100)];
        assert_eq!(p.step(Some(70.0), false, &edited, t + Duration::from_secs(5)), Some(0));
    }

    #[test]
    fn a_new_percent_on_the_held_step_applies_at_once() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 74.0, &s3(), t), Some(1));
        let louder = vec![st(65, 50), st(72, 90), st(80, 100)];
        assert_eq!(p.step(Some(74.0), false, &louder, t + Duration::from_secs(5)), Some(1));
    }

    #[test]
    fn pressure_means_the_top_step() {
        let mut p = StepPolicy::default();
        assert_eq!(p.step(Some(50.0), true, &s3(), Instant::now()), Some(2));
    }

    #[test]
    fn a_lost_sensor_gives_the_fans_back_after_the_minute() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 74.0, &s3(), t), Some(1));
        assert_eq!(p.step(None, false, &s3(), t + Duration::from_secs(30)), Some(1));
        assert_eq!(p.step(None, false, &s3(), t + Duration::from_secs(61)), None);
    }

    #[test]
    fn edited_table_clamps_the_held_step() {
        let t = Instant::now();
        let mut p = StepPolicy::default();
        assert_eq!(hold(&mut p, 85.0, &s3(), t), Some(2));
        assert_eq!(hold(&mut p, 85.0, &[st(65, 50)], t + Duration::from_secs(5)), Some(0));
        assert_eq!(p.step(Some(85.0), false, &[], t + Duration::from_secs(10)), None);
    }

    fn halt_run(h: &mut Halt, readings: &[f32], limit: u32) -> Vec<bool> {
        readings.iter().map(|&c| h.step(Some(c), false, limit)).collect()
    }

    #[test]
    fn the_emergency_stop_trips_on_the_average_not_on_one_spike() {
        let mut h = Halt::default();
        assert_eq!(halt_run(&mut h, &[80.0, 110.0, 80.0, 80.0], 95), [false; 4]);
        let mut h = Halt::default();
        assert_eq!(halt_run(&mut h, &[94.0, 96.0, 96.0], 95), [false, false, true]);
    }

    #[test]
    fn the_emergency_stop_holds_until_resumed_by_hand() {
        let mut h = Halt::default();
        assert_eq!(halt_run(&mut h, &[97.0, 97.0, 97.0], 95), [false, false, true]);
        // Cold again: still frozen, only the user resumes.
        assert_eq!(halt_run(&mut h, &[50.0, 50.0, 50.0], 95), [true; 3]);
        assert_eq!(h.resume(95), Ok(()));
        assert!(!h.tripped());
        assert!(!h.step(Some(50.0), false, 95));
        // Hot again: frozen again.
        assert_eq!(halt_run(&mut h, &[99.0, 99.0, 99.0], 95), [false, false, true]);
    }

    #[test]
    fn resuming_waits_until_the_cpu_is_five_degrees_below_the_limit() {
        let mut h = Halt::default();
        halt_run(&mut h, &[96.0, 96.0, 96.0], 95);
        halt_run(&mut h, &[91.0, 91.0, 91.0], 95);
        assert_eq!(h.resume(95), Err(Refusal::Hot(91.0)));
        assert!(h.tripped());
        halt_run(&mut h, &[90.0, 90.0, 90.0], 95);
        assert_eq!(h.resume(95), Ok(()));
        // No reading to go by: allowed.
        let mut h = Halt::default();
        assert_eq!(h.resume(95), Ok(()));
    }

    #[test]
    fn turning_the_emergency_stop_off_lets_go_and_it_never_trips_off() {
        let mut h = Halt::default();
        assert_eq!(halt_run(&mut h, &[99.0, 99.0, 99.0], 0), [false; 3]);
        assert!(h.step(Some(99.0), false, 95));
        assert!(!h.step(Some(99.0), false, 0));
        assert_eq!(h.resume(0), Ok(()));
        assert!(h.step(None, false, 95), "the readings are kept: the average is still over");
    }

    #[test]
    fn a_critical_macos_stops_at_once_and_blocks_resume() {
        let mut h = Halt::default();
        assert!(h.step(Some(50.0), true, 90));
        assert_eq!(h.cause(), Some(HaltCause::System));
        assert_eq!(h.resume(90), Err(Refusal::Critical));
        for _ in 0..3 {
            assert!(h.step(Some(50.0), false, 90), "cooled down: still frozen until resumed");
        }
        assert_eq!(h.resume(90), Ok(()));
        assert_eq!(h.cause(), None);
    }

    #[test]
    fn critical_with_the_stop_off_does_nothing() {
        let mut h = Halt::default();
        assert!(!h.step(Some(99.0), true, 0));
        assert_eq!(h.cause(), None);
        assert!(h.step(Some(50.0), true, 90));
        assert!(!h.step(Some(50.0), true, 0), "turned off: lets go");
        assert_eq!(h.resume(0), Ok(()));
    }

    #[test]
    fn the_cause_is_the_temperature_when_the_average_trips() {
        let mut h = Halt::default();
        for c in [91.0, 91.0, 91.0] {
            h.step(Some(c), false, 90);
        }
        assert_eq!(h.cause(), Some(HaltCause::Temperature));
        h.step(Some(91.0), true, 90);
        assert_eq!(h.cause(), Some(HaltCause::Temperature), "the first cause stays");
    }

    #[test]
    fn after_critical_clears_a_hot_average_still_blocks_resume() {
        let mut h = Halt::default();
        for c in [95.0, 95.0, 95.0] {
            h.step(Some(c), true, 90);
        }
        assert_eq!(h.cause(), Some(HaltCause::System));
        for _ in 0..3 {
            h.step(Some(88.0), false, 90);
        }
        assert_eq!(h.resume(90), Err(Refusal::Hot(88.0)));
    }

    #[test]
    fn emergency_limits() {
        assert_eq!(emergency_limit(false, 95), 0);
        assert_eq!([0, 59, 60, 95, 110, 200].map(|c| emergency_limit(true, c)), [60, 60, 60, 95, 110, 110]);
    }

    #[test]
    fn the_emergency_stop_freezes_everything_an_agent_runs() {
        // A Claude tile as desk starts it: zsh -lc 'claude ...; exec zsh -l',
        // no job control, so all in the pane's process group.
        let table = [
            in_group(100, 1, "tmux", 100, false),
            in_group(200, 100, "zsh", 200, false),
            in_group(210, 200, "claude", 200, false),
            in_group(220, 210, "node", 200, false),
            in_group(230, 210, "bash", 200, false),
            in_group(231, 230, "cargo", 200, false),
            in_group(232, 231, "rustc", 200, false),
        ];
        let plan = freeze_plan(&[200], &table);
        assert_eq!(plan.freeze, [210, 220, 230, 231, 232]);
        assert!(plan.jobs.is_empty());
    }

    #[test]
    fn a_job_typed_at_a_prompt_keeps_its_terminal_and_what_it_runs_freezes() {
        let table = [
            in_group(300, 1, "zsh", 300, false),
            // `pnpm test | tee log`: a job of two, its own process group.
            in_group(310, 300, "node", 310, false),
            in_group(311, 300, "tee", 310, false),
            in_group(312, 310, "node", 310, false), // a vitest worker
            // A job stopped with Ctrl+Z, and what it started: left as they are.
            in_group(320, 300, "vim", 320, true),
            in_group(321, 320, "node", 320, true),
        ];
        let plan = freeze_plan(&[300], &table);
        assert_eq!(plan.freeze, [312]);
        assert_eq!(plan.jobs, [310, 311]);
        // Windows: no process groups, so no jobs; the session's own process never.
        let flat: Vec<Proc> = table[..4].iter().map(|p| Proc { group: None, ..p.clone() }).collect();
        assert_eq!(freeze_plan(&[300], &flat), FreezePlan { freeze: vec![310, 311, 312], jobs: vec![] });
    }

    #[test]
    fn after_a_crash_only_what_is_still_frozen_in_the_sessions_runs_again() {
        let table = [
            in_group(200, 1, "zsh", 200, false),
            in_group(210, 200, "claude", 200, true),
            in_group(211, 210, "node", 200, false), // running: someone resumed it
            in_group(400, 1, "node", 400, true),    // stopped, but not in a session
        ];
        assert_eq!(to_thaw("210\n211\n400\n999\nbad", &[200], &table), [210]);
        let windows = [proc(200, 1, "pwsh", None), proc(210, 200, "claude", None)];
        assert_eq!(to_thaw("210", &[200], &windows), [210]);
    }

    #[cfg(unix)]
    #[test]
    fn freezes_a_process_and_lets_it_run_again() {
        let mut child = std::process::Command::new("sleep").arg("30").spawn().unwrap();
        let pid = child.id();
        let state = || {
            let out = std::process::Command::new("ps")
                .args(["-o", "stat=", "-p", &pid.to_string()])
                .output()
                .unwrap();
            String::from_utf8_lossy(&out.stdout).trim().to_string()
        };
        assert!(!state().starts_with('T'));
        assert_eq!(os::freeze(&[pid]), [pid]);
        assert!(state().starts_with('T'), "{}", state());
        os::thaw(&[pid]);
        assert!(!state().starts_with('T'), "{}", state());
        // Never desk itself nor init.
        assert!(os::freeze(&[std::process::id(), 1, 0]).is_empty());
        let _ = child.kill();
        let _ = child.wait();
    }

    #[cfg(unix)]
    #[test]
    fn the_guard_freezes_a_sessions_work_and_only_the_user_resumes_it() {
        let dir = tempfile::tempdir().unwrap();
        // A session as desk starts it: a shell running a program, no job control.
        let mut session = std::process::Command::new("sh").args(["-c", "sleep 30; true"]).spawn().unwrap();
        let root = session.id();
        let mut work = None;
        for _ in 0..50 {
            work = descendants(&[root], &os::processes()).into_iter().find(|&p| p != root);
            if work.is_some() {
                break;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        let work = work.expect("sh started sleep");
        let stopped = |pid: u32| os::processes().iter().any(|p| p.pid == pid && p.stopped);
        let marker = dir.path().join("halted-pids");
        let guard = Guard::new(Mode::Off, 75, Vec::new(), StepDown::default(), 95, dir.path());
        let tick = |c: f32| guard.tick(Some(c), false, || vec![root]);

        tick(97.0);
        tick(97.0);
        assert!(!stopped(work), "one hot reading is not enough");
        let s = tick(97.0).unwrap();
        assert!(s.halted && s.frozen == 1 && s.jobs == 0, "{s:?}");
        assert!(stopped(work) && !stopped(root));
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), work.to_string());

        // Still hot: refused. Cooled down: frozen all the same until resumed.
        assert_eq!(guard.resume().unwrap_err(), Refusal::Hot(97.0));
        for _ in 0..3 {
            tick(85.0);
        }
        assert!(guard.status().halted && stopped(work));
        let s = guard.resume().unwrap();
        assert!(!s.halted && s.frozen == 0, "{s:?}");
        assert!(!stopped(work) && !marker.exists());

        // Hot again, then turned off in Options: running again at the next reading.
        for _ in 0..3 {
            tick(99.0);
        }
        assert!(stopped(work));
        guard.set_emergency(0);
        let s = tick(99.0).unwrap();
        assert!(!s.halted && s.emergency == 0, "{s:?}");
        assert!(!stopped(work));

        // On again while still hot: frozen at once; quitting desk lets it run.
        guard.set_emergency(95);
        assert!(tick(99.0).unwrap().halted);
        assert!(stopped(work));
        guard.shutdown(&[root]);
        assert!(!stopped(work) && !marker.exists());

        // SAFETY: plain syscall on our own child.
        unsafe { libc::kill(work as libc::pid_t, libc::SIGKILL) };
        let _ = session.kill();
        let _ = session.wait();
    }
}
