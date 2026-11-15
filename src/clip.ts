// Programs in a terminal may set the clipboard (OSC 52: tmux copies a mouse
// selection this way, Claude Code's /copy too), but only right after you did
// something in that tile, so text printed by whatever runs there (a file being
// shown, a page Claude read) cannot slip into the clipboard behind your back.

/** How long after your click or key a program may set the clipboard. */
export const WRITE_WINDOW_MS = 3000;
export const MAX_CLIP = 1_000_000;

export function mayWrite(text: string, lastInputMs: number, nowMs: number): boolean {
  return text.length > 0 && text.length <= MAX_CLIP && nowMs - lastInputMs <= WRITE_WINDOW_MS;
}

/** What a tile does when a program sets the clipboard: write it (and say so),
 *  block it (and warn), or nothing, as it already handled this one. */
export type ClipVerdict = "write" | "block" | "repeat";

/** One tile's clipboard writes from its programs. One copy may arrive more
 *  than once: Claude Code's /copy under tmux prints its OSC 52 plain and
 *  wrapped for tmux passthrough, and desk's tmux passes both on. The same text
 *  again with no click or key of yours since is that copy, handled once. */
export class ClipGate {
  /** Your last real click or key in the tile. */
  private lastInput = 0;
  private last: { text: string; input: number } | null = null;

  input(nowMs: number): void {
    this.lastInput = nowMs;
  }

  ask(text: string, nowMs: number): ClipVerdict {
    if (this.last?.text === text && this.last.input === this.lastInput) return "repeat";
    this.last = { text, input: this.lastInput };
    return mayWrite(text, this.lastInput, nowMs) ? "write" : "block";
  }
}
