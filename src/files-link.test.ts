import { describe, expect, it, vi } from "vitest";
import { applyFilesCommand, filesWindowKey, type FilesSettings } from "./files-link";

const settings: FilesSettings = {
  browser: "auto",
  linkClick: "desk",
  fileEditor: "",
  language: "en",
  theme: "desk",
  uiScale: 1,
  keys: {},
  treeLeft: false,
};

function fake() {
  const side = {
    relabel: vi.fn(),
    open: vi.fn(() => Promise.resolve()),
    openAt: vi.fn(() => Promise.resolve()),
    showFiles: vi.fn(),
    reveal: vi.fn(),
    browse: vi.fn(),
    projectChanged: vi.fn(),
    browserChanged: vi.fn(() => Promise.resolve()),
    stopEditing: vi.fn((_reload?: boolean) => Promise.resolve(true)),
    shown: vi.fn((): string | null => "/p/a.ts"),
  };
  const setProject = vi.fn();
  const setSettings = vi.fn();
  const say = vi.fn();
  return { side, setProject, setSettings, say, deps: { side, setProject, setSettings, say } };
}

describe("files window protocol", () => {
  it("filesWindowKey maps desk shortcuts in the files window", () => {
    expect(filesWindowKey({ type: "files" })).toBe("showFiles");
    expect(filesWindowKey({ type: "preview" })).toBe("hide");
    expect(filesWindowKey({ type: "findInFiles" })).toBe("find");
    expect(filesWindowKey({ type: "palette" })).toBeNull();
    expect(filesWindowKey(null)).toBeNull();
  });

  it("settings command relabels and rethemes", () => {
    const f = fake();
    const order: string[] = [];
    f.setSettings.mockImplementation(() => order.push("settings"));
    f.side.relabel.mockImplementation(() => order.push("relabel"));
    applyFilesCommand({ op: "settings", settings }, f.deps);
    expect(f.setSettings).toHaveBeenCalledWith(settings);
    expect(f.side.relabel).toHaveBeenCalled();
    expect(f.side.browserChanged).toHaveBeenCalled();
    // The language must be set before the labels are redrawn.
    expect(order).toEqual(["settings", "relabel"]);
  });

  it("open and openAt go to the panel", () => {
    const f = fake();
    applyFilesCommand({ op: "open", link: "a.md", project: "/p" }, f.deps);
    expect(f.side.open).toHaveBeenCalledWith("a.md", "/p");
    applyFilesCommand({ op: "openAt", file: "b.ts", line: 7, project: "/p" }, f.deps);
    expect(f.side.openAt).toHaveBeenCalledWith("b.ts", 7, "/p");
  });

  it("project, showFiles, toggle and browse reach the panel", () => {
    const f = fake();
    applyFilesCommand({ op: "project", project: "/q" }, f.deps);
    expect(f.setProject).toHaveBeenCalledWith("/q");
    expect(f.side.projectChanged).toHaveBeenCalled();
    applyFilesCommand({ op: "showFiles" }, f.deps);
    applyFilesCommand({ op: "reveal" }, f.deps);
    applyFilesCommand({ op: "browse" }, f.deps);
    expect(f.side.showFiles).toHaveBeenCalled();
    // reveal opens and never closes: the panel's toggle is not it.
    expect(f.side.reveal).toHaveBeenCalled();
    expect(f.side.browse).toHaveBeenCalled();
  });

  it("release stops editing (saving) and answers with what is shown after", async () => {
    const f = fake();
    applyFilesCommand({ op: "release", id: 4 }, f.deps);
    await vi.waitFor(() => expect(f.say).toHaveBeenCalled());
    // No reload: the window goes right after.
    expect(f.side.stopEditing).toHaveBeenCalledWith(false);
    expect(f.say).toHaveBeenCalledWith({ op: "released", id: 4, ok: true, shown: "/p/a.ts" });
  });

  it("hello is answered with ready (a main page that came after the window)", () => {
    const f = fake();
    applyFilesCommand({ op: "hello" }, f.deps);
    expect(f.say).toHaveBeenCalledWith({ op: "ready" });
  });

  it("a save that fails (or throws) answers released ok:false", async () => {
    const f = fake();
    f.side.stopEditing.mockImplementationOnce(() => Promise.resolve(false));
    applyFilesCommand({ op: "release", id: 1 }, f.deps);
    await vi.waitFor(() => expect(f.say).toHaveBeenCalledTimes(1));
    expect(f.say).toHaveBeenLastCalledWith({ op: "released", id: 1, ok: false, shown: "/p/a.ts" });
    f.side.stopEditing.mockImplementationOnce(() => Promise.reject(new Error("boom")));
    applyFilesCommand({ op: "release", id: 2 }, f.deps);
    await vi.waitFor(() => expect(f.say).toHaveBeenCalledTimes(2));
    expect(f.say).toHaveBeenLastCalledWith({ op: "released", id: 2, ok: false, shown: "/p/a.ts" });
  });
});
