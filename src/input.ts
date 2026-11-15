// Input from xterm.js on its way to the session.
//
// When tmux attaches it asks the outer terminal (xterm.js) for its Device
// Attributes. xterm.js answers ("\x1b[?1;2c", "\x1b[>0;276;0c") through the
// same input stream, and tmux sometimes takes a late answer for typed keys:
// "c?1;2c" showed up in Claude's prompt after desk restarted. Programs inside
// the session never see these queries (tmux answers them itself), so the
// replies can be dropped.
// eslint-disable-next-line no-control-regex -- matching ESC is the point
const DA_REPLY = /\x1b\[[?>][\d;]*c/g;

export function stripProbeReplies(data: string): string {
  return data.replace(DA_REPLY, "");
}

// eslint-disable-next-line no-control-regex -- matching ESC is the point
const SGR_MOUSE = /\x1b\[<(\d+);(\d+);(\d+)([Mm])/g;
/** Bits of an SGR mouse report: a move (with or without a button), the wheel. */
const MOTION = 32;
const WHEEL = 64;

/**
 * A mouse button xterm.js reported pressed and never let go. xterm.js 6 stops
 * listening for the release when mouse reporting is turned off and on while
 * the button is down, and tmux does exactly that whenever Claude Code redraws
 * after a resize (switching sessions, a fullscreen tile) or loses focus. Claude
 * Code then keeps selecting as if the button were held: dragged past the top
 * of the tile it scrolls up by itself, and the wheel only works downwards
 * until the bottom. The tile asks for the missing release once you let go.
 */
export class MouseHold {
  private held: { code: number; col: string; row: string } | null = null;

  /** Everything xterm.js sends to the session. */
  sent(data: string): void {
    for (const [, b, col, row, end] of data.matchAll(SGR_MOUSE)) {
      const code = Number(b);
      if (end === "m") this.held = null;
      else if (code & WHEEL) continue;
      else if (!(code & MOTION)) this.held = { code, col, row };
      else if (this.held) this.held = { ...this.held, col, row };
    }
  }

  /** The release the program never got (at the place it saw last), once; null when nothing is held. */
  release(): string | null {
    const h = this.held;
    this.held = null;
    return h ? `\x1b[<${h.code};${h.col};${h.row}m` : null;
  }
}
