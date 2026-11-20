// Shift+Enter in a terminal tile: a new line in Claude Code's prompt, not a send.

/** What a tile sends for Shift+Enter: Meta+Enter, which Claude Code reads as a new line. */
export const NEWLINE = "\x1b\r";

/** Shift+Enter, on every event of the key: keydown, keypress and keyup. */
export function isShiftEnter(e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey">): boolean {
  return e.key === "Enter" && e.shiftKey && !e.metaKey && !e.ctrlKey;
}
