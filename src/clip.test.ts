import { describe, expect, it } from "vitest";
import { ClipGate, MAX_CLIP, mayWrite } from "./clip";

describe("clipboard writes from programs", () => {
  it("are allowed only right after your own input", () => {
    expect(mayWrite("x", 1000, 2500)).toBe(true);
    expect(mayWrite("x", 1000, 4001)).toBe(false); // printed later, nobody asked
    expect(mayWrite("", 1000, 1000)).toBe(false);
    expect(mayWrite("a".repeat(MAX_CLIP + 1), 1000, 1000)).toBe(false);
  });
});

describe("a tile's clipboard gate", () => {
  it("writes right after your click or key, blocks later", () => {
    const gate = new ClipGate();
    gate.input(1000);
    expect(gate.ask("a", 2500)).toBe("write");
    expect(gate.ask("b", 4001)).toBe("block");
  });

  it("writes once when one copy arrives twice", () => {
    // Claude Code's /copy under tmux prints the same OSC 52 plain and wrapped
    // for tmux passthrough; desk's tmux lets both through.
    const gate = new ClipGate();
    gate.input(1000); // Enter on /copy
    expect(gate.ask("hello", 1050)).toBe("write");
    expect(gate.ask("hello", 1051)).toBe("repeat");
  });

  it("writes the same text again after your next click or key", () => {
    const gate = new ClipGate();
    gate.input(1000);
    expect(gate.ask("hello", 1050)).toBe("write");
    gate.input(2000);
    expect(gate.ask("hello", 2050)).toBe("write");
  });

  it("writes a different text without new input", () => {
    const gate = new ClipGate();
    gate.input(1000);
    expect(gate.ask("hello", 1050)).toBe("write");
    expect(gate.ask("world", 1100)).toBe("write");
  });

  it("blocks a write sent twice once", () => {
    const gate = new ClipGate();
    gate.input(1000);
    expect(gate.ask("secret", 9000)).toBe("block");
    expect(gate.ask("secret", 9001)).toBe("repeat");
  });
});
