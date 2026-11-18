//! Watches `state/` (written by the hook script) and forwards session state
//! changes to the webview as `session-state` events, and how a Ctrl+G prompt
//! rewrite goes as `prompt-ai` events (prompt_status.rs).

use crate::hooks::{SessionState, read_state};
use notify::event::ModifyKind;
use notify::{EventKind, RecursiveMode, Watcher};
use std::path::Path;
use tauri::{AppHandle, Emitter};

/// Only a file written (created, its data changed or moved into place by the
/// hook's tmp + mv) is news. Opening and reading it (Access) or its access
/// time (Metadata) are not: the callback reads the file itself, so reacting to
/// those starts a loop that never ends and eats the CPU.
fn is_write(kind: &EventKind) -> bool {
    match kind {
        EventKind::Create(_) => true,
        EventKind::Modify(ModifyKind::Metadata(_)) => false,
        EventKind::Modify(_) => true,
        _ => false,
    }
}

pub fn read_all(state_dir: &Path) -> Vec<SessionState> {
    let Ok(entries) = std::fs::read_dir(state_dir) else {
        return Vec::new();
    };
    entries
        .flatten()
        .filter_map(|e| read_state(&e.path()))
        .collect()
}

/// The returned watcher must be kept alive for events to keep coming.
pub fn watch(app: AppHandle, state_dir: &Path) -> notify::Result<notify::RecommendedWatcher> {
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        if !is_write(&event.kind) {
            return;
        }
        for path in event.paths {
            if let Some(state) = read_state(&path) {
                let _ = app.emit("session-state", state);
            } else if let Some(status) = crate::prompt_status::read_status(&path) {
                let _ = app.emit("prompt-ai", status);
            }
        }
    })?;
    watcher.watch(state_dir, RecursiveMode::NonRecursive)?;
    Ok(watcher)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Duration;

    /// The events the watcher acts on while `act` runs in a watched folder.
    fn writes_seen(dir: &Path, act: impl FnOnce()) -> Vec<EventKind> {
        let (tx, rx) = mpsc::channel();
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            if let Ok(e) = res {
                let _ = tx.send(e.kind);
            }
        })
        .unwrap();
        watcher.watch(dir, RecursiveMode::NonRecursive).unwrap();
        act();
        std::thread::sleep(Duration::from_millis(300));
        drop(watcher);
        rx.try_iter().filter(is_write).collect()
    }

    #[test]
    fn reading_a_state_file_is_not_a_write() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("p-1.json");
        std::fs::write(&file, "{}").unwrap();
        // What the callback does on every event: had it counted, this loops forever.
        let seen = writes_seen(tmp.path(), || {
            for _ in 0..5 {
                std::fs::read_to_string(&file).unwrap();
            }
        });
        assert!(seen.is_empty(), "{seen:?}");
    }

    #[test]
    fn the_hook_moving_a_file_in_place_is_a_write() {
        let tmp = tempfile::tempdir().unwrap();
        let seen = writes_seen(tmp.path(), || {
            // Like desk-hook.sh: a temp file, then mv.
            let part = tmp.path().join(".p-1.123");
            std::fs::write(&part, "{}").unwrap();
            std::fs::rename(&part, tmp.path().join("p-1.json")).unwrap();
        });
        assert!(!seen.is_empty());
    }

    #[test]
    fn opening_and_access_time_are_not_writes() {
        use notify::event::{AccessKind, AccessMode, MetadataKind};
        assert!(!is_write(&EventKind::Access(AccessKind::Open(AccessMode::Any))));
        assert!(!is_write(&EventKind::Access(AccessKind::Close(AccessMode::Read))));
        assert!(!is_write(&EventKind::Modify(ModifyKind::Metadata(MetadataKind::AccessTime))));
        assert!(is_write(&EventKind::Modify(ModifyKind::Data(notify::event::DataChange::Any))));
    }
}
