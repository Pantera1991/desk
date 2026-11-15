//! The desk session working the CPU hardest: all its processes (its panes'
//! and everything they started) together, from two readings of their CPU
//! time (cpu.rs). The temperature chip's panel offers its tile first.

use crate::thermal::{Proc, descendants};
use crate::tmux::SessionInfo;
use serde::Serialize;
use std::collections::HashMap;
use std::time::Duration;

/// Below this a session is idle, not busy: % of one core.
const MIN_PERCENT: u32 = 1;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Busiest {
    pub path: String,
    pub agent: String,
    pub instance: u32,
    /// CPU used, % of one core (400: four cores' worth).
    pub percent: u32,
    /// The program in it using the most: "cargo", "node".
    pub program: String,
}

/// The session whose processes used the most CPU from `before` to `after`
/// (`window` apart); None when none reached MIN_PERCENT. A process read only
/// once (it started or ended in between) counts nothing.
pub fn busiest(
    sessions: &[(SessionInfo, Vec<u32>)],
    table: &[Proc],
    before: &HashMap<u32, Duration>,
    after: &HashMap<u32, Duration>,
    window: Duration,
) -> Option<Busiest> {
    let names: HashMap<u32, &str> = table.iter().map(|p| (p.pid, p.name.as_str())).collect();
    sessions
        .iter()
        .filter_map(|(info, roots)| {
            let used: Vec<(u32, Duration)> = descendants(roots, table)
                .into_iter()
                .filter_map(|p| Some((p, after.get(&p)?.saturating_sub(*before.get(&p)?))))
                .collect();
            let total: Duration = used.iter().map(|&(_, d)| d).sum();
            let &(top, _) = used.iter().max_by_key(|&&(_, d)| d)?;
            let percent = (total.as_secs_f64() / window.as_secs_f64() * 100.0).round() as u32;
            (percent >= MIN_PERCENT).then(|| Busiest {
                path: info.path.clone(),
                agent: info.agent.clone(),
                instance: info.instance,
                percent,
                program: names.get(&top).copied().unwrap_or("?").to_string(),
            })
        })
        // The first of equals: sessions come sorted by name.
        .rev()
        .max_by_key(|b| b.percent)
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

    fn proc(pid: u32, parent: u32, name: &str) -> Proc {
        Proc {
            pid,
            parent,
            name: name.into(),
            tty: None,
            group: None,
            stopped: false,
        }
    }

    const WINDOW: Duration = Duration::from_millis(500);

    fn ms(pairs: &[(u32, u64)]) -> HashMap<u32, Duration> {
        pairs.iter().map(|&(p, m)| (p, Duration::from_millis(m))).collect()
    }

    #[test]
    fn the_session_with_the_most_cpu_over_all_its_processes_wins() {
        let sessions = vec![
            (info("shop-1", "/p/shop", "claude"), vec![100]),
            (info("crm-2", "/p/crm", "shell"), vec![200]),
        ];
        let table = [
            proc(100, 1, "zsh"),
            proc(110, 100, "claude"),
            proc(200, 1, "zsh"),
            proc(210, 200, "cargo"),
            proc(211, 210, "rustc"),
            proc(212, 210, "rustc"),
        ];
        // Over 500 ms: claude 300 ms; the build 150 + 400 + 350 ms.
        let before = ms(&[(100, 0), (110, 1000), (200, 0), (210, 50), (211, 0), (212, 0)]);
        let after = ms(&[(100, 0), (110, 1300), (200, 0), (210, 200), (211, 400), (212, 350)]);
        let b = busiest(&sessions, &table, &before, &after, WINDOW).unwrap();
        assert_eq!((b.path.as_str(), b.agent.as_str(), b.percent, b.program.as_str()), ("/p/crm", "shell", 180, "rustc"));
    }

    #[test]
    fn idle_sessions_and_processes_read_once_count_nothing() {
        let sessions = vec![(info("a-1", "/p/a", "claude"), vec![100])];
        let table = [proc(100, 1, "zsh"), proc(110, 100, "node"), proc(120, 100, "node")];
        // 110 started in between, 120 ended: neither counts; the shell idles.
        let before = ms(&[(100, 10), (120, 5)]);
        let after = ms(&[(100, 12), (110, 400)]);
        assert_eq!(busiest(&sessions, &table, &before, &after, WINDOW), None);
        assert_eq!(busiest(&[], &table, &before, &after, WINDOW), None);
    }

    #[test]
    fn of_two_equally_busy_sessions_the_first_wins() {
        let sessions = vec![(info("a-1", "/p/a", "claude"), vec![100]), (info("b-1", "/p/b", "claude"), vec![200])];
        let table = [proc(100, 1, "node"), proc(200, 1, "node")];
        let b = busiest(&sessions, &table, &ms(&[(100, 0), (200, 0)]), &ms(&[(100, 100), (200, 100)]), WINDOW);
        assert_eq!(b.map(|b| b.path), Some("/p/a".into()));
    }
}
