import { describe, expect, it } from "vitest";
import { isShiftEnter, NEWLINE } from "./newline";

const key = (over: Partial<KeyboardEvent>) => ({ key: "Enter", shiftKey: true, metaKey: false, ctrlKey: false, ...over });

describe("Shift+Enter", () => {
  it("is matched on keydown and on the keypress after it", () => {
    // The keypress matters: left to xterm it becomes a plain Enter and sends the prompt.
    expect(isShiftEnter(key({ type: "keydown" }))).toBe(true);
    expect(isShiftEnter(key({ type: "keypress" }))).toBe(true);
  });
  it("leaves plain Enter and other modifiers alone", () => {
    expect(isShiftEnter(key({ shiftKey: false }))).toBe(false);
    expect(isShiftEnter(key({ ctrlKey: true }))).toBe(false);
    expect(isShiftEnter(key({ metaKey: true }))).toBe(false);
    expect(isShiftEnter(key({ key: "a" }))).toBe(false);
  });
  it("sends Meta+Enter", () => {
    expect(NEWLINE).toBe("\x1b\r");
  });
});
