//! What the terminal says while the prompt is rewritten (prompt_ai.rs) when
//! no pill can: Claude outside desk, or the status file could not be written.
//! In desk the tile keeps Claude's last frame meanwhile (prompt-pill.ts):
//! Claude Code clears its screen before it hands the prompt to `$VISUAL`, so
//! there is nothing worth drawing from here.

/// A line of its own: the AI star and the text, faded.
pub fn note(text: &str) -> String {
    format!("\r\n  \x1b[35m✦\x1b[0m \x1b[2m{text}\x1b[0m\r\n")
}

/// The terminal cursor back on, as any editor leaves it when it exits.
pub const SHOW_CURSOR: &str = "\x1b[?25h";

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_note_is_one_faded_line_with_the_star() {
        assert_eq!(note("Nic do poprawy"), "\r\n  \x1b[35m✦\x1b[0m \x1b[2mNic do poprawy\x1b[0m\r\n");
    }
}
