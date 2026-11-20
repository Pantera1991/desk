//! Start (Super) as desk's shortcut key on Linux (Options → Shortcuts).
//! WebKitGTK never tells the page that Super is held (no `metaKey`), so the
//! page sees Start+F as a plain "f" and the terminal gets it. While the
//! option is on, the window takes Start+key before the webview does and
//! tells the page which key it was; the page runs it as a shortcut.

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};

static ON: AtomicBool = AtomicBool::new(false);

/// layout.superKeys: on at start from the saved layout, then from Options.
pub fn set(on: bool) {
    ON.store(on, Ordering::Relaxed);
}

/// What the page needs to build its key event.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct SuperKey {
    /// The key's `KeyboardEvent.code`: "KeyF", "Digit0", "Enter".
    pub code: String,
    pub shift: bool,
    pub ctrl: bool,
    pub alt: bool,
}

/// The `code` of a key GTK reports as `ch` (its lowercase character) and
/// `name` (its keyval name). None for keys no shortcut uses (Super alone,
/// Tab, arrows), which go on as they would.
pub fn code_of(ch: Option<char>, name: &str) -> Option<String> {
    if let Some(c) = ch {
        if c.is_ascii_lowercase() {
            return Some(format!("Key{}", c.to_ascii_uppercase()));
        }
        if c.is_ascii_digit() {
            return Some(format!("Digit{c}"));
        }
    }
    let code = match name {
        "Return" | "KP_Enter" => "Enter",
        "Escape" => "Escape",
        "BackSpace" => "Backspace",
        "equal" | "plus" => "Equal",
        "minus" | "underscore" => "Minus",
        "grave" | "asciitilde" => "Backquote",
        "bracketleft" | "braceleft" => "BracketLeft",
        "bracketright" | "braceright" => "BracketRight",
        "backslash" | "bar" => "Backslash",
        "semicolon" | "colon" => "Semicolon",
        _ => return None,
    };
    Some(code.into())
}

#[cfg(target_os = "linux")]
pub fn install(window: &tauri::Window) {
    use gtk::gdk::ModifierType as M;
    use gtk::glib::Propagation;
    use gtk::prelude::*;
    use std::cell::Cell;
    use std::rc::Rc;
    use tauri::{Emitter, Manager};

    let Ok(gtk_window) = window.gtk_window() else { return };
    let app = window.app_handle().clone();
    // The key held down: GTK repeats it, and Start+Q held would close one tile after another.
    let held = Rc::new(Cell::new(None::<u32>));
    let held_up = held.clone();
    gtk_window.connect_key_press_event(move |_, ev| {
        let state = ev.state();
        if !ON.load(Ordering::Relaxed) || !state.contains(M::SUPER_MASK) {
            return Propagation::Proceed;
        }
        let key = ev.keyval();
        let lower = key.to_lower();
        let name = lower.name().map(|n| n.to_string()).unwrap_or_default();
        let Some(code) = code_of(lower.to_unicode(), &name) else {
            return Propagation::Proceed;
        };
        if held.replace(Some(*key)) != Some(*key) {
            let _ = app.emit_to(
                "main",
                "super-key",
                SuperKey {
                    code,
                    shift: state.contains(M::SHIFT_MASK),
                    ctrl: state.contains(M::CONTROL_MASK),
                    alt: state.contains(M::MOD1_MASK),
                },
            );
        }
        Propagation::Stop
    });
    gtk_window.connect_key_release_event(move |_, _| {
        held_up.set(None);
        Propagation::Proceed
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn letters_and_digits_take_their_codes() {
        assert_eq!(code_of(Some('f'), "f").as_deref(), Some("KeyF"));
        assert_eq!(code_of(Some('0'), "0").as_deref(), Some("Digit0"));
    }

    #[test]
    fn named_keys_take_their_codes() {
        assert_eq!(code_of(Some('\r'), "Return").as_deref(), Some("Enter"));
        assert_eq!(code_of(None, "Escape").as_deref(), Some("Escape"));
        assert_eq!(code_of(Some('='), "equal").as_deref(), Some("Equal"));
        assert_eq!(code_of(Some('-'), "minus").as_deref(), Some("Minus"));
        assert_eq!(code_of(None, "BackSpace").as_deref(), Some("Backspace"));
    }

    #[test]
    fn keys_no_shortcut_uses_go_on() {
        assert_eq!(code_of(None, "Super_L"), None);
        assert_eq!(code_of(None, "Tab"), None);
        assert_eq!(code_of(None, "Left"), None);
        // A Polish letter is not a shortcut key either.
        assert_eq!(code_of(Some('ą'), "aogonek"), None);
    }

    #[test]
    fn off_until_set() {
        assert!(!ON.load(Ordering::Relaxed));
        set(true);
        assert!(ON.load(Ordering::Relaxed));
        set(false);
    }
}
