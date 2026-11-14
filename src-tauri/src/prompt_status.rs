//! How a Ctrl+G rewrite (prompt_ai.rs) goes, for the pill desk shows on the
//! tile. The wrapper writes `state/<slug>.prompt` next to the hook state and
//! state_watch.rs passes every change on as a `prompt-ai` event. The pill's
//! "Cofnij" leaves a marker that makes the next Ctrl+G put the draft back.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

/// How long the undo marker counts: desk sends Ctrl+G right after writing it.
const UNDO_SECS: u64 = 30;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    /// The model is rewriting the prompt.
    Checking,
    /// The server did not answer: desk connects through its WireGuard tunnel.
    Vpn,
    /// The rewrite is in Claude's prompt.
    Applied,
    /// The model had nothing to change: the prompt stays as typed.
    Clean,
    /// The draft is back in Claude's prompt (the pill's "Cofnij").
    Restored,
    /// The prompt is unchanged; the message says why.
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptStatus {
    pub slug: String,
    pub phase: Phase,
    pub message: Option<String>,
    /// Unix milliseconds.
    pub ts: u64,
}

#[derive(Serialize, Deserialize)]
struct Record {
    phase: Phase,
    #[serde(default)]
    message: Option<String>,
    #[serde(default)]
    ts: u64,
}

fn status_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!("{slug}.prompt"))
}

fn draft_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!(".{slug}.prompt-draft"))
}

fn undo_path(dir: &Path, slug: &str) -> PathBuf {
    dir.join(format!(".{slug}.prompt-undo"))
}

/// A tmux session name as desk makes them: no path, no dot file.
fn valid_slug(slug: &str) -> bool {
    !slug.is_empty() && !slug.starts_with('.') && !slug.contains(['/', '\\'])
}

/// `state/<slug>.prompt` -> its status; other files (hook state, temp files,
/// the draft and the undo marker) are not one.
pub fn read_status(path: &Path) -> Option<PromptStatus> {
    if path.extension()? != "prompt" {
        return None;
    }
    let slug = path.file_stem()?.to_str()?;
    if !valid_slug(slug) {
        return None;
    }
    let r: Record = serde_json::from_str(std::fs::read_to_string(path).ok()?.trim()).ok()?;
    Some(PromptStatus { slug: slug.to_string(), phase: r.phase, message: r.message, ts: r.ts })
}

/// The pill's "Cofnij": the next Ctrl+G in session `slug` puts the draft back
/// instead of asking the model.
pub fn request_undo(state_dir: &Path, slug: &str) -> Result<(), String> {
    if !valid_slug(slug) {
        return Err(format!("bad session: {slug}"));
    }
    std::fs::write(undo_path(state_dir, slug), b"").map_err(|e| e.to_string())
}

/// The wrapper's side, from the env desk starts Claude with (lib.rs); None
/// when Claude runs outside desk.
pub struct Reporter {
    dir: PathBuf,
    slug: String,
}

impl Reporter {
    pub fn from_env() -> Option<Self> {
        let var = |k: &str| std::env::var(k).ok().filter(|v| !v.is_empty());
        Self::new(PathBuf::from(var("DESK_STATE_DIR")?), var("DESK_SLUG")?)
    }

    pub fn new(dir: PathBuf, slug: String) -> Option<Self> {
        valid_slug(&slug).then_some(Self { dir, slug })
    }

    /// Tells the pill where the rewrite is; false when the file could not be
    /// written (the terminal says it instead).
    pub fn report(&self, phase: Phase, message: Option<&str>) -> bool {
        let ts = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_millis() as u64);
        let record = Record { phase, message: message.map(str::to_string), ts };
        let Ok(text) = serde_json::to_string(&record) else {
            return false;
        };
        // Renamed into place, so the watcher never reads half a file.
        let tmp = self.dir.join(format!(".{}.prompt.{}", self.slug, std::process::id()));
        std::fs::write(&tmp, text)
            .and_then(|()| std::fs::rename(&tmp, status_path(&self.dir, &self.slug)))
            .is_ok()
    }

    /// Keeps the draft the model rewrote, owner-only, for "Cofnij".
    pub fn keep_draft(&self, text: &str) {
        use std::io::Write;
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        std::os::unix::fs::OpenOptionsExt::mode(&mut opts, 0o600);
        if let Ok(mut f) = opts.open(draft_path(&self.dir, &self.slug)) {
            let _ = f.write_all(text.as_bytes());
        }
    }

    pub fn draft(&self) -> Option<String> {
        std::fs::read_to_string(draft_path(&self.dir, &self.slug)).ok()
    }

    /// The pill asked for the draft back moments ago. The marker is used up
    /// either way, so a stale one never swallows a later Ctrl+G.
    pub fn undo_requested(&self) -> bool {
        let path = undo_path(&self.dir, &self.slug);
        let Ok(modified) = std::fs::metadata(&path).and_then(|m| m.modified()) else {
            return false;
        };
        let _ = std::fs::remove_file(&path);
        modified.elapsed().is_ok_and(|age| age.as_secs() <= UNDO_SECS)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("desk-prompt-status-{name}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn a_report_reads_back_as_the_tile_status() {
        let dir = temp_dir("report");
        let r = Reporter::new(dir.clone(), "desk-claude-1a2b".into()).unwrap();
        assert!(r.report(Phase::Checking, None));
        let s = read_status(&dir.join("desk-claude-1a2b.prompt")).unwrap();
        assert_eq!((s.slug.as_str(), s.phase, s.message.as_deref()), ("desk-claude-1a2b", Phase::Checking, None));
        assert!(s.ts > 0);
        assert!(r.report(Phase::Error, Some("serwer LLM nie odpowiada")));
        let s = read_status(&dir.join("desk-claude-1a2b.prompt")).unwrap();
        assert_eq!((s.phase, s.message.as_deref()), (Phase::Error, Some("serwer LLM nie odpowiada")));
        // Hook state, temp files, the draft and the marker are not statuses.
        r.keep_draft("szkic");
        for other in ["desk-claude-1a2b.json", ".desk-claude-1a2b.prompt-draft", ".x.prompt"] {
            assert_eq!(read_status(&dir.join(other)), None, "{other}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn undo_is_asked_once_and_brings_the_draft_back() {
        let dir = temp_dir("undo");
        let r = Reporter::new(dir.clone(), "proj-claude".into()).unwrap();
        assert!(!r.undo_requested());
        r.keep_draft("popraw to prosze");
        request_undo(&dir, "proj-claude").unwrap();
        assert!(r.undo_requested());
        assert!(!r.undo_requested(), "the marker is used up");
        assert_eq!(r.draft().as_deref(), Some("popraw to prosze"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(draft_path(&dir, "proj-claude")).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn slugs_never_leave_the_state_dir() {
        let dir = Path::new("/nonexistent");
        for bad in ["", ".hidden", "../x", "a/b", "a\\b"] {
            assert!(request_undo(dir, bad).is_err(), "{bad}");
            assert!(Reporter::new(dir.into(), bad.into()).is_none(), "{bad}");
        }
    }
}
