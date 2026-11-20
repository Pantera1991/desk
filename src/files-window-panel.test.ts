import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FilesReport, FilesSettings } from "./files-link";

const m = vi.hoisted(() => ({
  emitTo: vi.fn((_target: string, _event: string, _payload?: unknown) => Promise.resolve()),
  listeners: new Map<string, (e: { payload: unknown }) => void>(),
  filesWindowOpen: vi.fn(() => Promise.resolve()),
  filesWindowHide: vi.fn(() => Promise.resolve()),
  filesWindowDestroy: vi.fn(() => Promise.resolve()),
  previewClose: vi.fn(() => Promise.resolve()),
  /** Native calls in the order made. */
  calls: [] as string[],
  openFileAt: vi.fn((_p: string, _f: string, _l: number) => Promise.resolve()),
  toast: vi.fn(),
  find: null as null | {
    ctx: { open(file: string, line: number, project: string): void; closed(back: boolean): void };
    open: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    relabel: ReturnType<typeof vi.fn>;
  },
}));

vi.mock("@tauri-apps/api/event", () => ({
  emitTo: (target: string, event: string, payload?: unknown) => m.emitTo(target, event, payload),
  listen: (event: string, cb: (e: { payload: unknown }) => void) => {
    m.listeners.set(event, cb);
    return Promise.resolve(() => m.listeners.delete(event));
  },
}));
vi.mock("./api", () => ({
  api: {
    filesWindowOpen: () => m.filesWindowOpen(),
    filesWindowHide: () => m.filesWindowHide(),
    filesWindowDestroy: () => {
      m.calls.push("destroy");
      return m.filesWindowDestroy();
    },
    previewClose: () => {
      m.calls.push("previewClose");
      return m.previewClose();
    },
    openFileAt: (p: string, f: string, l: number) => m.openFileAt(p, f, l),
  },
}));
vi.mock("./ui", () => ({ toast: (...a: unknown[]) => m.toast(...a) }));
vi.mock("./find-panel", () => ({
  FindPanel: class {
    isOpen = false;
    el = { contains: () => false };
    open = vi.fn();
    close = vi.fn();
    relabel = vi.fn();
    constructor(ctx: { open(file: string, line: number, project: string): void; closed(back: boolean): void }) {
      m.find = { ctx, open: this.open, close: this.close, relabel: this.relabel };
    }
  },
}));

import { FilesWindowPanel, switchPanel, type FilesWindowContext } from "./files-window-panel";
import type { Panel } from "./side";

const settings: FilesSettings = {
  browser: "auto",
  linkClick: "desk",
  fileEditor: "",
  language: "en",
  theme: "desk",
  uiScale: 1,
  keys: {},
  treeLeft: true,
};

const flush = () => new Promise((r) => setTimeout(r, 0));

function ctx(over: Partial<FilesWindowContext> = {}): FilesWindowContext {
  return {
    project: () => "/p",
    settings: () => settings,
    insert: vi.fn(),
    terminal: vi.fn(),
    changed: vi.fn(),
    ...over,
  };
}

/** The files window says something to the main window. */
function say(report: FilesReport): void {
  m.listeners.get("files:said")!({ payload: report });
}

/** Everything the main window sent to the files window, in order. */
function sentAll(): unknown[] {
  return m.emitTo.mock.calls.filter(([target, event]) => target === "files" && event === "files:do").map(([, , p]) => p);
}

/** The commands sent, without the stand-in's greeting (its own test). */
function sent(): unknown[] {
  return sentAll().filter((c) => (c as { op: string }).op !== "hello");
}

/** The id of the last `release` sent. */
function releaseId(): number {
  const r = sent().filter((c) => (c as { op: string }).op === "release").pop() as { id: number } | undefined;
  return r!.id;
}

beforeEach(() => {
  vi.clearAllMocks();
  m.calls.length = 0;
  m.listeners.clear();
  m.find = null;
  vi.stubGlobal("document", { createElement: () => ({ hidden: false }), activeElement: null });
  vi.stubGlobal("HTMLElement", class {});
});

describe("FilesWindowPanel", () => {
  it("commands wait for ready and replay in order", async () => {
    const p = new FilesWindowPanel(ctx());
    p.showFiles();
    void p.open("x");
    await flush();
    expect(sent()).toEqual([]);
    expect(m.filesWindowOpen).toHaveBeenCalledTimes(2);
    say({ op: "ready" });
    await flush();
    const ops = sent().filter((c) => (c as { op: string }).op !== "settings" && (c as { op: string }).op !== "project");
    expect(ops).toEqual([{ op: "showFiles" }, { op: "open", link: "x", project: undefined }]);
    // Once ready, a command goes at once.
    p.browse();
    await flush();
    expect(sent().slice(-1)).toEqual([{ op: "browse" }]);
  });

  it("ready, then settings, then project, then the queued command", async () => {
    const p = new FilesWindowPanel(ctx());
    void p.open("a.md", "/p");
    // Settings and the project before ready are not queued: ready sends them fresh.
    p.settingsChanged();
    p.projectChanged();
    await flush();
    say({ op: "ready" });
    await flush();
    expect(sent()).toEqual([
      { op: "settings", settings },
      { op: "project", project: "/p" },
      { op: "open", link: "a.md", project: "/p" },
    ]);
  });

  it("settings and project changes reach the window without showing it", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    await flush();
    m.emitTo.mockClear();
    p.settingsChanged();
    p.projectChanged();
    await flush();
    expect(sent()).toEqual([
      { op: "settings", settings },
      { op: "project", project: "/p" },
    ]);
    expect(m.filesWindowOpen).not.toHaveBeenCalled();
  });

  it("state reports drive isOpen and filesShown", async () => {
    const c = ctx();
    const p = new FilesWindowPanel(c);
    await flush();
    expect(p.isOpen).toBe(false);
    expect(p.filesShown).toBe(false);
    say({ op: "state", open: true, filesShown: true, shown: "/p/a.md" });
    expect(p.isOpen).toBe(true);
    expect(p.filesShown).toBe(true);
    expect(p.shown()).toBe("/p/a.md");
    expect(c.changed).toHaveBeenCalled();
    // The window's own close button: Rust reports it closed, and that is the truth.
    say({ op: "state", open: false, filesShown: false, shown: null });
    expect(p.isOpen).toBe(false);
    expect(p.filesShown).toBe(false);
  });

  it("the folder and ⌘W hide an open window, and show a closed one", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    say({ op: "state", open: true, filesShown: true, shown: null });
    p.toggleFiles();
    await flush();
    expect(m.filesWindowHide).toHaveBeenCalledTimes(1);
    say({ op: "state", open: false, filesShown: false, shown: null });
    m.emitTo.mockClear();
    p.toggleFiles();
    p.toggle();
    await flush();
    expect(m.filesWindowOpen).toHaveBeenCalledTimes(2);
    expect(sent()).toEqual([{ op: "showFiles" }, { op: "reveal" }]);
  });

  it("a refused open (desk locked) drops the command", async () => {
    m.filesWindowOpen.mockImplementationOnce(() => Promise.reject("desk is locked"));
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    await flush();
    m.emitTo.mockClear();
    p.showFiles();
    await flush();
    expect(sent()).toEqual([]);
    expect(m.toast).toHaveBeenCalled();
  });

  it("a Find in Files hit opens in the files window", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    await flush();
    m.emitTo.mockClear();
    p.showFind("needle");
    expect(m.find!.open).toHaveBeenCalledWith("/p", "needle");
    m.find!.ctx.open("a.php", 3, "/p");
    await flush();
    expect(m.find!.close).toHaveBeenCalled();
    expect(m.filesWindowOpen).toHaveBeenCalled();
    expect(sent()).toEqual([{ op: "openAt", file: "a.php", line: 3, project: "/p" }]);
  });

  it("a hit goes to the program from Options without showing the window", async () => {
    const p = new FilesWindowPanel(ctx({ settings: () => ({ ...settings, fileEditor: "subl" }) }));
    await flush();
    say({ op: "ready" });
    await flush();
    m.emitTo.mockClear();
    p.showFind();
    m.find!.ctx.open("a.php", 3, "/p");
    await flush();
    expect(m.openFileAt).toHaveBeenCalledWith("/p", "a.php", 3);
    expect(m.filesWindowOpen).not.toHaveBeenCalled();
    expect(sent()).toEqual([]);
  });

  it("insert and terminal reports reach the main window", async () => {
    const c = ctx();
    const p = new FilesWindowPanel(c);
    await flush();
    say({ op: "insert", text: "@a.md " });
    say({ op: "terminal", path: "/p/src" });
    expect(c.insert).toHaveBeenCalledWith("@a.md ");
    expect(c.terminal).toHaveBeenCalledWith("/p/src");
    // ⇧⌘F in the files window: the search opens here.
    say({ op: "find" });
    expect(m.find!.open).toHaveBeenCalledWith("/p", undefined);
    expect(p.el.hidden).toBe(true);
  });

  it("main refuses an insert that is not a plain @-mention", async () => {
    const c = ctx();
    new FilesWindowPanel(c);
    await flush();
    say({ op: "insert", text: "ls\r" });
    say({ op: "insert", text: "@a.md\r" });
    say({ op: "insert", text: "@a\u001b[31m" });
    say({ op: "insert", text: "@a\u007f" });
    expect(c.insert).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenCalledTimes(4);
    // A path with spaces is quoted by the mention itself.
    say({ op: "insert", text: '@"my notes/a.md" ' });
    expect(c.insert).toHaveBeenCalledWith('@"my notes/a.md" ');
  });

  it("main opens a terminal only inside the active project", async () => {
    const c = ctx();
    new FilesWindowPanel(c);
    await flush();
    say({ op: "terminal", path: "/etc" });
    say({ op: "terminal", path: "/p-other/x" });
    say({ op: "terminal", path: "/p/../etc" });
    expect(c.terminal).not.toHaveBeenCalled();
    expect(m.toast).toHaveBeenCalledTimes(3);
    say({ op: "terminal", path: "/p" });
    say({ op: "terminal", path: "/p/src" });
    expect(c.terminal).toHaveBeenCalledTimes(2);
    // No active project: nothing to be inside of.
    const none = ctx({ project: () => null });
    new FilesWindowPanel(none);
    await flush();
    say({ op: "terminal", path: "/p/src" });
    expect(none.terminal).not.toHaveBeenCalled();
  });

  it("switching off while the first open is in flight still destroys the window", async () => {
    let built!: () => void;
    m.filesWindowOpen.mockImplementationOnce(() => new Promise<void>((r) => (built = r)));
    const p = new FilesWindowPanel(ctx());
    await flush();
    p.showFiles();
    await flush();
    const done = p.handOver();
    await flush();
    expect(m.calls).toEqual([]);
    built();
    await done;
    expect(m.calls).toEqual(["previewClose", "destroy"]);
  });

  it("handing over destroys the window after the pending commands, then stops listening", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    say({ op: "state", open: true, filesShown: false, shown: "/p/a.md" });
    p.showFiles();
    await p.handOver();
    expect(m.filesWindowDestroy).toHaveBeenCalledTimes(1);
    // The native page is closed first: the side panel's open must not find it under the dying window.
    expect(m.calls).toEqual(["previewClose", "destroy"]);
    expect(p.isOpen).toBe(false);
    expect(m.listeners.has("files:said")).toBe(false);
  });

  it("a stand-in that never reached a window leaves the native page alone", async () => {
    // Switching on was refused (the side panel's file did not save): its preview stays.
    const p = new FilesWindowPanel(ctx());
    await flush();
    await p.handOver();
    expect(m.calls).toEqual([]);
    expect(m.listeners.has("files:said")).toBe(false);
  });

  it("greets a files window that is already there (the main page reloaded), which answers ready", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    expect(sentAll()).toEqual([{ op: "hello" }]);
    // A window that is there answers ready: commands go at once from then on.
    say({ op: "ready" });
    await flush();
    void p.open("x");
    await flush();
    expect(sent().slice(-1)).toEqual([{ op: "open", link: "x", project: undefined }]);
  });
});

/** A panel that records what is done to it. */
function panel(open: boolean, shown: string | null, log: string[]): Panel {
  return {
    el: {} as HTMLElement,
    isOpen: open,
    filesShown: false,
    shown: () => shown,
    browse: () => log.push("browse"),
    toggle: () => log.push("toggle"),
    toggleFiles: () => log.push("toggleFiles"),
    showFiles: () => log.push("showFiles"),
    showFind: () => log.push("showFind"),
    projectChanged: () => log.push("projectChanged"),
    relabel: () => log.push("relabel"),
    browserChanged: () => Promise.resolve(),
    open: (link: string) => {
      log.push(`open ${link}`);
      return Promise.resolve();
    },
    close: () => log.push("close"),
    handOver: () => {
      log.push("handOver");
      return Promise.resolve();
    },
    browserPref: () => "auto",
    linkClickPref: () => "desk",
  };
}

describe("switchPanel", () => {
  it("switching to the window asks to save a dirty file first", async () => {
    const log: string[] = [];
    const from = panel(true, "/p/a.ts", log);
    const to = panel(false, null, log);
    const swap = vi.fn(() => log.push("swap"));
    // The save failed or was refused: nothing switches.
    expect(await switchPanel(from, to, () => Promise.resolve(false), swap)).toBe(false);
    expect(log).toEqual([]);
    expect(swap).not.toHaveBeenCalled();
    const stop = vi.fn(() => {
      log.push("stop");
      return Promise.resolve(true);
    });
    expect(await switchPanel(from, to, stop, swap)).toBe(true);
    // Stop editing, let go of the old host (its native preview too), swap, then show the same file.
    expect(log).toEqual(["stop", "handOver", "swap", "open /p/a.ts"]);
    expect(swap).toHaveBeenCalledWith(to);
  });

  it("switching off asks the files window to save first", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    say({ op: "state", open: true, filesShown: false, shown: "/p/a.ts" });
    await flush();
    m.emitTo.mockClear();
    const log: string[] = [];
    const side = panel(false, null, log);
    const swap = vi.fn();
    const done = switchPanel(p, side, () => p.release(), swap);
    await flush();
    expect(sent()).toEqual([{ op: "release", id: releaseId() }]);
    // Asking does not pop the window up.
    expect(m.filesWindowOpen).not.toHaveBeenCalled();
    say({ op: "released", id: releaseId(), ok: false, shown: "/p/a.ts" });
    expect(await done).toBe(false);
    expect(m.filesWindowDestroy).not.toHaveBeenCalled();
    expect(swap).not.toHaveBeenCalled();
    expect(log).toEqual([]);
    expect(m.toast).toHaveBeenCalled();
  });

  it("on released ok:true the window goes and the side panel opens what it showed", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    say({ op: "state", open: true, filesShown: false, shown: "/p/a.ts" });
    await flush();
    const log: string[] = [];
    const side = panel(false, null, log);
    const swap = vi.fn(() => log.push("swap"));
    const done = switchPanel(p, side, () => p.release(), swap);
    await flush();
    // What the window shows after the save (the editor may have moved on).
    say({ op: "released", id: releaseId(), ok: true, shown: "/p/b.ts" });
    expect(await done).toBe(true);
    expect(m.filesWindowDestroy).toHaveBeenCalledTimes(1);
    expect(log).toEqual(["swap", "open /p/b.ts"]);
  });

  it("a late answer to an earlier release does not settle the next one", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    await flush();
    expect(await p.release(5)).toBe(false);
    const first = releaseId();
    const second = p.release(1000);
    await flush();
    expect(releaseId()).not.toBe(first);
    // The first request's answer comes now: not this request's.
    say({ op: "released", id: first, ok: true, shown: null });
    say({ op: "released", id: releaseId(), ok: false, shown: null });
    expect(await second).toBe(false);
  });

  it("nothing reopens when the switch may not show it (desk locked meanwhile)", async () => {
    const log: string[] = [];
    const done = await switchPanel(
      panel(true, "/p/a.ts", log),
      panel(false, null, log),
      () => Promise.resolve(true),
      () => log.push("swap"),
      () => false,
    );
    expect(done).toBe(true);
    expect(log).toEqual(["handOver", "swap"]);
  });

  it("a window that never loaded holds no edit: released at once", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    expect(await p.release()).toBe(true);
    expect(sent()).toEqual([]);
  });

  it("a ready window that does not answer keeps the mode", async () => {
    const p = new FilesWindowPanel(ctx());
    await flush();
    say({ op: "ready" });
    await flush();
    expect(await p.release(5)).toBe(false);
    expect(m.toast).toHaveBeenCalled();
    // A late answer changes nothing.
    say({ op: "released", id: releaseId(), ok: true, shown: null });
  });

  it("a closed panel stays closed in its new place", async () => {
    const log: string[] = [];
    await switchPanel(panel(false, "/p/a.ts", log), panel(false, null, log), () => Promise.resolve(true), () => log.push("swap"));
    expect(log).toEqual(["handOver", "swap"]);
  });

  it("an open panel with nothing shown opens on the files or as it was", async () => {
    const log: string[] = [];
    const tree = { ...panel(true, null, log), filesShown: true };
    await switchPanel(tree, panel(false, null, log), () => Promise.resolve(true), () => log.push("swap"));
    expect(log).toEqual(["handOver", "swap", "showFiles"]);
    log.length = 0;
    await switchPanel(panel(true, null, log), panel(false, null, log), () => Promise.resolve(true), () => log.push("swap"));
    expect(log).toEqual(["handOver", "swap", "toggle"]);
  });
});
