import { describe, expect, it } from "vitest";
import { MouseHold, stripProbeReplies } from "./input";

describe("stripProbeReplies", () => {
  it("drops Device Attributes replies and keeps typed keys", () => {
    expect(stripProbeReplies("\x1b[?1;2c")).toBe("");
    expect(stripProbeReplies("\x1b[>0;276;0c")).toBe("");
    expect(stripProbeReplies("a\x1b[?1;2cb")).toBe("ab");
    expect(stripProbeReplies("c")).toBe("c");
    expect(stripProbeReplies("\x1b[A")).toBe("\x1b[A"); // arrow up
    expect(stripProbeReplies("\x1b[12;40R")).toBe("\x1b[12;40R"); // cursor position report
    expect(stripProbeReplies("?1;2c")).toBe("?1;2c"); // typed text stays
  });
});

describe("a mouse button xterm.js never let go", () => {
  const PRESS = "\x1b[<0;12;12M";

  it("is let go where the program saw it last", () => {
    const m = new MouseHold();
    m.sent(PRESS);
    m.sent("\x1b[<32;12;1M"); // dragged up to the top row: Claude Code scrolls up while it lasts
    // tmux turned mouse reporting off and on (a resize): xterm.js sends no release.
    expect(m.release()).toBe("\x1b[<0;12;1m");
    expect(m.release()).toBeNull();
  });

  it("adds nothing when xterm.js let go itself", () => {
    const m = new MouseHold();
    m.sent(PRESS);
    m.sent("\x1b[<32;12;6M");
    m.sent("\x1b[<0;12;6m");
    expect(m.release()).toBeNull();
  });

  it("is not the wheel or a move with no button", () => {
    const m = new MouseHold();
    m.sent("\x1b[<64;10;10M");
    m.sent("\x1b[<65;10;10M");
    m.sent("\x1b[<35;10;10M");
    expect(m.release()).toBeNull();
  });

  it("keeps the button and the modifiers of the press", () => {
    const m = new MouseHold();
    m.sent("\x1b[<16;5;5M"); // Ctrl + left
    m.sent("\x1b[<48;6;5M"); // dragged
    expect(m.release()).toBe("\x1b[<16;6;5m");
    m.sent("\x1b[<2;3;3M"); // right
    expect(m.release()).toBe("\x1b[<2;3;3m");
  });

  it("finds the reports among other input", () => {
    const m = new MouseHold();
    m.sent("ab\x1b[<0;1;2Mcd");
    expect(m.release()).toBe("\x1b[<0;1;2m");
  });
});
