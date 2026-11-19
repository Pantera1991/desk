import { shortcuts } from "./platform";
import { setLanguage, t } from "./i18n";
import { describe, expect, it } from "vitest";
import { actionFor, BINDINGS, clashWith, hints, keysIn, keyText, setCustomKeys, setSuperKeys } from "./keys";

const k = (key: string, mods: Partial<{ metaKey: boolean; shiftKey: boolean; altKey: boolean; ctrlKey: boolean }> = {}) => ({
  key,
  metaKey: true,
  shiftKey: false,
  altKey: false,
  ctrlKey: false,
  ...mods,
});

const mac = (e: Parameters<typeof actionFor>[0]) => actionFor(e, "mac");

describe("actionFor", () => {
  it("maps the Polish-named shortcuts", () => {
    expect(mac(k("p"))).toEqual({ type: "palette" });
    expect(mac(k("n"))).toEqual({ type: "new" });
    expect(mac(k("d"))).toEqual({ type: "sub" });
    expect(mac(k("q"))).toEqual({ type: "close" });
    expect(mac(k("z"))).toBeNull(); // ⌘Z is undo again
    expect(mac(k("Q", { shiftKey: true }))).toEqual({ type: "kill" });
    expect(mac(k("T", { shiftKey: true }))).toEqual({ type: "reopen" });
    expect(actionFor({ ...k("T"), metaKey: false, ctrlKey: true, shiftKey: true, altKey: true, code: "KeyT" }, "linux")).toEqual({ type: "reopen" });
    expect(mac(k("Z", { shiftKey: true }))).toBeNull(); // redo
    expect(mac(k("3"))).toEqual({ type: "focus", index: 2 });
    expect(mac(k("e"))).toEqual({ type: "fullscreen" });
    expect(mac(k("Enter"))).toEqual({ type: "fullscreen" });
    expect(mac(k("j"))).toEqual({ type: "minimize" });
    expect(mac(k("Escape"))).toEqual({ type: "exitFullscreen" });
    expect(mac(k("k"))).toEqual({ type: "coffee" });
    expect(mac(k("b"))).toEqual({ type: "lock" });
    expect(mac(k("r"))).toEqual({ type: "chat" });
    expect(mac(k("s"))).toEqual({ type: "sessions" });
    expect(mac(k("t"))).toEqual({ type: "terminal" });
    expect(mac(k("f"))).toEqual({ type: "files" });
    expect(mac(k("g"))).toBeNull(); // ⌘G is the prompt rewrite (tile.ts)
    expect(mac(k("G", { shiftKey: true }))).toEqual({ type: "docker" });
    expect(mac(k("u"))).toEqual({ type: "run" });
    expect(mac(k("o"))).toEqual({ type: "settings" });
    expect(mac(k("w"))).toEqual({ type: "preview" });
    expect(mac(k("="))).toEqual({ type: "font", step: 1 });
    expect(mac(k("-"))).toEqual({ type: "font", step: -1 });
    expect(mac(k("0"))).toEqual({ type: "font", step: 0 });
  });

  it("leaves terminal keys alone", () => {
    expect(mac(k("Escape", { metaKey: false }))).toBeNull();
    expect(mac(k("c"))).toBeNull(); // copy
    expect(mac(k("v"))).toBeNull(); // paste
    expect(mac(k("p", { ctrlKey: true }))).toBeNull();
    expect(mac(k("0", { altKey: true }))).toBeNull();
    expect(mac(k("W", { shiftKey: true }))).toBeNull();
  });

  it("uses Ctrl+Shift on Windows and Linux", () => {
    const w = (code: string, key = "", mods: Partial<{ ctrlKey: boolean; shiftKey: boolean; altKey: boolean }> = {}) =>
      actionFor({ key, code, metaKey: false, ctrlKey: true, shiftKey: true, altKey: false, ...mods }, "windows");
    expect(w("KeyP", "P")).toEqual({ type: "palette" });
    expect(w("Digit3", "#")).toEqual({ type: "focus", index: 2 }); // Shift turns 3 into #
    expect(w("Backspace", "Backspace")).toEqual({ type: "kill" });
    expect(w("KeyQ", "Q")).toEqual({ type: "close" });
    expect(w("KeyZ", "Z")).toBeNull();
    expect(w("KeyC", "C")).toBeNull(); // copy, handled by the terminal tile
    expect(w("Equal", "+")).toEqual({ type: "font", step: 1 });
    expect(w("Minus", "_")).toEqual({ type: "font", step: -1 });
    expect(w("Escape", "Escape")).toBeNull(); // Task Manager
    expect(w("KeyP", "p", { shiftKey: false })).toBeNull(); // Ctrl+P is the shell's
    expect(w("KeyG", "G")).toEqual({ type: "docker" });
    expect(w("KeyG", "g", { shiftKey: false })).toBeNull(); // Ctrl+G is the prompt rewrite
    expect(actionFor({ key: "G", code: "KeyG", metaKey: false, ctrlKey: true, shiftKey: true, altKey: false }, "linux")).toEqual({ type: "docker" });
    expect(w("KeyZ", "Ż", { altKey: true })).toBeNull(); // AltGr+Shift+Z types Ż
    expect(actionFor(k("p"), "windows")).toBeNull(); // the Windows key is not ⌘
  });

  it("shows shortcuts for the platform", () => {
    expect(hints("mac")[0]).toEqual(["⌘P", "projekty"]);
    expect(hints("windows")[0]).toEqual(["Ctrl⇧P", "projekty"]);
    expect(hints("linux").find(([, l]) => l === "zabij")).toEqual(["Ctrl⇧⌫", "zabij"]);
  });
});

describe("keysIn", () => {
  it("names the modifier of a click as the platform does", () => {
    const text = "⌘-klik: panel desk, ⌥-klik: przeglądarka";
    expect(keysIn(text, "mac")).toBe(text);
    expect(keysIn(text, "windows")).toBe("Ctrl-klik: panel desk, Alt-klik: przeglądarka");
    expect(keysIn("⌥-click: browser", "linux")).toBe("Alt-click: browser");
  });

  it("still reads ⌘- before a space as the shortcut ⌘-", () => {
    expect(keysIn("⌘= większa, ⌘- mniejsza", "mac")).toBe("⌘= większa, ⌘- mniejsza");
    expect(keysIn("⌘= większa, ⌘- mniejsza", "windows")).toBe(shortcuts("⌘= większa, ⌘- mniejsza", "windows"));
  });

  it("is what every message goes through, before its params are filled in", () => {
    setLanguage("pl");
    expect(t("tile.attachFailedHint")).toBe(keysIn("⌘Q zamyka kafelek."));
    expect(t("tile.attachFailedHint")).not.toContain("⌘"); // tests run as Linux
    expect(t("top.browserTitle", { keys: "⌘W" })).toContain("(⌘W)");
  });
});

describe("custom shortcuts", () => {
  it("replace the defaults everywhere they are shown", () => {
    setCustomKeys({ palette: "Super+Shift+KeyP" });
    try {
      expect(mac(k("p"))).toBeNull();
      expect(mac(k("P", { shiftKey: true }))).toEqual({ type: "palette" });
      expect(hints("mac")[0]).toEqual(["⇧⌘P", "projekty"]);
      expect(keyText("palette", "mac")).toBe("⇧⌘P");
      expect(keysIn("Otwórz (⌘P), zwiń (⌘J)", "mac")).toBe("Otwórz (⇧⌘P), zwiń (⌘J)");
    } finally {
      setCustomKeys({});
    }
  });

  it("quit desk has no key until one is set (⌘Q closes a tile)", () => {
    expect(keyText("quit", "mac")).toBe("");
    expect(keyText("quit", "windows")).toBe("");
    setCustomKeys({ quit: "Super+Alt+KeyQ" });
    try {
      expect(mac(k("q", { altKey: true }))).toEqual({ type: "quit" });
      expect(mac(k("q"))).toEqual({ type: "close" });
    } finally {
      setCustomKeys({});
    }
  });

  it("refuse a key that is taken", () => {
    expect(clashWith("palette", "Super+KeyN", "mac")).toBe("nowy projekt (folder + opcjonalnie git init)");
    expect(clashWith("palette", "Super+KeyC", "mac")).toBe("kopiuj");
    expect(clashWith("docker", "Super+KeyG", "mac")).toBe(t("reserved.promptRewrite"));
    expect(t("reserved.promptRewrite")).not.toBe("reserved.promptRewrite");
    expect(clashWith("palette", "Super+Digit4", "mac")).toBe("skok do kafelka");
    expect(clashWith("palette", "Super+KeyP", "mac")).toBeNull(); // its own
    expect(clashWith("palette", "Super+KeyI", "mac")).toBeNull();
  });

  it("have unique ids", () => {
    expect(new Set(BINDINGS.map((b) => b.id)).size).toBe(BINDINGS.length);
  });
});

describe("the Start (Super) key on Linux", () => {
  const win = (code: string, more: Partial<{ shiftKey: boolean; ctrlKey: boolean }> = {}) =>
    actionFor({ key: code.replace(/^Key/, "").toLowerCase(), code, metaKey: true, shiftKey: false, altKey: false, ctrlKey: false, ...more }, "linux");

  it("is off by default: Ctrl+Shift as before", () => {
    expect(keyText("files", "linux")).toBe("Ctrl⇧F");
    expect(win("KeyF")).toBeNull();
  });

  it("when on, desk's shortcuts take Start like ⌘ on a Mac", () => {
    setSuperKeys(true);
    try {
      expect(keyText("files", "linux")).toBe("Win+F");
      expect(win("KeyF")).toEqual({ type: "files" });
      expect(win("KeyW")).toEqual({ type: "preview" });
      expect(win("KeyG", { shiftKey: true })).toEqual({ type: "docker" });
      expect(win("KeyQ", { shiftKey: true })).toEqual({ type: "kill" });
      expect(keysIn("⌘F", "linux")).toBe("Win+F");
      // Ctrl+Shift no longer does what Start does now.
      expect(actionFor({ key: "F", code: "KeyF", metaKey: false, shiftKey: true, altKey: false, ctrlKey: true }, "linux")).toBeNull();
      // macOS and Windows are not touched.
      expect(keyText("files", "mac")).toBe("⌘F");
      expect(keyText("files", "windows")).toBe("Ctrl⇧F");
    } finally {
      setSuperKeys(false);
    }
  });

  it("keeps Ctrl+Shift where GNOME takes Start first (P, L, S, N, D, O)", () => {
    setSuperKeys(true);
    try {
      for (const id of ["palette", "arrange", "sessions", "new", "sub", "settings"]) expect(keyText(id, "linux")).toMatch(/^Ctrl⇧/);
      expect(win("KeyP")).toBeNull();
      expect(actionFor({ key: "P", code: "KeyP", metaKey: false, shiftKey: true, altKey: false, ctrlKey: true }, "linux")).toEqual({ type: "palette" });
    } finally {
      setSuperKeys(false);
    }
  });

  it("leaves a shortcut set in Options as it is", () => {
    setSuperKeys(true);
    setCustomKeys({ files: "Control+Alt+KeyF" });
    try {
      expect(keyText("files", "linux")).toBe("Ctrl+Alt+F");
    } finally {
      setCustomKeys({});
      setSuperKeys(false);
    }
  });
});
