//! The files panel (tree, editor, page preview) in a window of its own, when
//! Options says so (`layout.files_window`). It is made on demand, never at
//! start; closing it only hides it (its state, unsaved edits and preview stay),
//! switching the mode off destroys it. Its page is `files.html`, and its
//! capability (capabilities/files.json) holds only the panel's commands.
//!
//! Lock: it is hidden while desk is locked and `files_window_open` refuses;
//! unlocking shows it again only if it was visible before.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard};
use tauri::{AppHandle, Emitter, Manager, State, WebviewUrl, WebviewWindowBuilder};

/// The window's label (and the capability's webview).
pub const LABEL: &str = "files";

/// It was visible when desk locked: unlock shows it again.
static VISIBLE_BEFORE_LOCK: AtomicBool = AtomicBool::new(false);

/// Showing or making the window is refused while desk is locked.
pub fn may_show(locked: bool) -> Result<(), String> {
    if locked {
        return Err(tr!("desk jest zablokowany", "desk is locked").into());
    }
    Ok(())
}

/// Unlock brings the window back only if it was up when desk locked.
pub fn after_unlock(was_visible: bool) -> bool {
    was_visible
}

/// Not `get_webview_window`: it finds nothing once the window holds a second
/// webview (the page preview), as with the main window (see `main_window`).
fn window<M: Manager<tauri::Wry>>(app: &M) -> Option<tauri::Window> {
    app.get_window(LABEL)
}

/// Create the window (at its saved place) or show the existing one.
fn show(app: &AppHandle, focus: bool) -> Result<(), String> {
    if let Some(w) = window(app) {
        let _ = w.unminimize();
        w.show().map_err(|e| e.to_string())?;
        if focus {
            let _ = w.set_focus();
        }
        return Ok(());
    }
    let built = WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("files.html".into()))
        .title(tr!("desk — pliki", "desk — files"))
        .inner_size(900.0, 700.0)
        .min_inner_size(360.0, 300.0)
        .background_color(tauri::window::Color(11, 13, 16, 255))
        .visible(false)
        .build()
        .map_err(|e| e.to_string())?;
    let w = built.as_ref().window();
    crate::window_place::restore(&w, &crate::window_place::files_file(&crate::env::support_dir()));
    w.show().map_err(|e| e.to_string())?;
    if focus {
        let _ = w.set_focus();
    }
    Ok(())
}

/// Hide it and tell the main window, which keeps the toolbar's state.
pub fn hide(app: &AppHandle) {
    if let Some(w) = window(app) {
        let _ = w.hide();
    }
    let _ = app.emit_to(
        "main",
        "files:said",
        serde_json::json!({ "op": "state", "open": false, "filesShown": false, "shown": null }),
    );
}

/// Unlock shows the window again only if it was visible before the lock and
/// still exists: it never builds one (the mode may have been switched off).
pub fn restore_on_unlock(was_visible: bool, exists: bool) -> bool {
    after_unlock(was_visible) && exists
}

/// Open, lock, unlock and destroy take turns: the lock check and the show are
/// one step, so the window cannot appear while desk locks. Building a window
/// waits for the main thread on some systems, so nothing that holds this may
/// run on it (`lock_desk` and `files_window_open` are async commands).
static GUARD: Mutex<()> = Mutex::new(());

fn guard() -> MutexGuard<'static, ()> {
    GUARD.lock().unwrap_or_else(|e| e.into_inner())
}

/// desk locked: the window goes out of sight, remembering if it was there.
pub fn on_lock(app: &AppHandle) {
    let _turn = guard();
    let visible = window(app).is_some_and(|w| w.is_visible().unwrap_or(false));
    VISIBLE_BEFORE_LOCK.store(visible, Ordering::SeqCst);
    if visible && let Some(w) = window(app) {
        let _ = w.hide();
    }
}

/// desk unlocked: an existing window comes back if it had been visible.
pub fn on_unlock(app: &AppHandle) {
    let _turn = guard();
    let was_visible = VISIBLE_BEFORE_LOCK.swap(false, Ordering::SeqCst);
    if let Some(w) = window(app)
        && restore_on_unlock(was_visible, true)
    {
        let _ = w.show();
    }
}

/// Close the window for good (the mode is off, or the main window closed).
pub fn destroy(app: &AppHandle) {
    let _turn = guard();
    VISIBLE_BEFORE_LOCK.store(false, Ordering::SeqCst);
    if let Some(w) = window(app) {
        let _ = w.destroy();
    }
}

/// Creates the window or shows and focuses it; refused while locked. Async: a
/// command that builds a window on the main thread deadlocks on Windows.
#[tauri::command(async)]
pub fn files_window_open(app: AppHandle, lock: State<crate::lock::Lock>) -> Result<(), String> {
    let _turn = guard();
    may_show(lock.is_locked())?;
    show(&app, true)
}

#[tauri::command]
pub fn files_window_hide(app: AppHandle) {
    hide(&app);
}

/// The mode was switched off: the window closes for good.
#[tauri::command(async)]
pub fn files_window_destroy(app: AppHandle) {
    destroy(&app);
}

/// The files window gives the focus back to desk's main window.
#[tauri::command]
pub fn focus_main_window(app: AppHandle) {
    if let Some(w) = crate::main_window(&app) {
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_is_refused_while_locked() {
        assert!(may_show(true).is_err());
        assert!(may_show(false).is_ok());
    }

    #[test]
    fn unlock_shows_only_what_was_visible() {
        assert!(after_unlock(true));
        assert!(!after_unlock(false));
    }

    #[test]
    fn unlock_never_builds_a_window() {
        assert!(restore_on_unlock(true, true));
        assert!(!restore_on_unlock(true, false), "destroyed meanwhile: stays gone");
        assert!(!restore_on_unlock(false, true));
    }

    #[test]
    fn the_places_have_separate_files() {
        let dir = std::path::Path::new("support");
        assert_ne!(
            crate::window_place::files_file(dir),
            crate::window_place::file(dir)
        );
        assert!(crate::window_place::files_file(dir).ends_with("files-window.json"));
    }
}
