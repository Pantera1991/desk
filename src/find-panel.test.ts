import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GrepHit, GrepOptions, GrepResult } from "./api";

const grepFiles = vi.fn<(p: string, q: string, o: GrepOptions) => Promise<GrepResult>>();
const readProjectText = vi.fn<(p: string, f: string) => Promise<string>>();
vi.mock("./api", () => ({
  api: {
    grepFiles: (p: string, q: string, o: GrepOptions) => grepFiles(p, q, o),
    readProjectText: (p: string, f: string) => readProjectText(p, f),
  },
}));

const goTo = vi.fn();
const destroy = vi.fn();
const createEditor = vi.fn();
vi.mock("./editor", () => ({ createEditor: (...a: unknown[]) => createEditor(...a) }));

import { t } from "./i18n";
import { FindPanel } from "./find-panel";

interface Fake {
  hidden: boolean;
  className: string;
  innerHTML: string;
  textContent: string;
  value: string;
  focus: ReturnType<typeof vi.fn>;
  select: ReturnType<typeof vi.fn>;
  classList: { toggle: ReturnType<typeof vi.fn> };
  querySelector(sel: string): Fake;
  addEventListener(n: string, f: (e: unknown) => void): void;
  replaceChildren(): void;
  remove: ReturnType<typeof vi.fn>;
  fire(n: string, e?: unknown): void;
}

/** Just enough DOM for the panel: every selector gives the same fake child. */
function fake(): Fake {
  const listeners: Record<string, ((e: unknown) => void)[]> = {};
  const kids = new Map<string, Fake>();
  return {
    hidden: false,
    className: "",
    innerHTML: "",
    textContent: "",
    value: "",
    focus: vi.fn(),
    select: vi.fn(),
    classList: { toggle: vi.fn() },
    querySelector(sel: string) {
      let k = kids.get(sel);
      if (!k) kids.set(sel, (k = fake()));
      return k;
    },
    addEventListener(n, f) {
      (listeners[n] ??= []).push(f);
    },
    replaceChildren() {},
    remove: vi.fn(),
    fire(n, e = {}) {
      for (const f of listeners[n] ?? []) f(e);
    },
  };
}

const hit = (file: string, line: number, text = "pre"): GrepHit => ({ file, line, text, marks: [[0, 3]], cut: 0 });
const result = (...hits: GrepHit[]): GrepResult => ({ hits, files: hits.length, more: false });

let el: Fake;
let store: Record<string, string>;
let appendChild: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useFakeTimers();
  el = fake();
  store = {};
  appendChild = vi.fn();
  vi.stubGlobal("document", { createElement: () => el, body: { appendChild } });
  vi.stubGlobal("localStorage", { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => void (store[k] = v) });
  grepFiles.mockReset();
  readProjectText.mockReset();
  readProjectText.mockResolvedValue("one\ntwo\nthree\nfour");
  createEditor.mockReset();
  goTo.mockReset();
  destroy.mockReset();
  createEditor.mockReturnValue({ goTo, destroy, focus: vi.fn(), value: () => "", view: {} });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A target whose `closest(sel)` finds something only for the selectors in `inside`. */
const target = (...inside: string[]) => ({ closest: (s: string) => (inside.includes(s) ? {} : null) });
const key = (k: string, more: Record<string, unknown> = {}) =>
  el.fire("keydown", { key: k, target: target(), preventDefault() {}, stopPropagation() {}, ...more });
const input = () => el.querySelector("[data-q]");
const type = async (text: string, ms = 250) => {
  input().value = text;
  input().fire("input");
  await vi.advanceTimersByTimeAsync(ms);
};
const make = (project: string | null = "/p") => {
  const ctx = { open: vi.fn(), closed: vi.fn() };
  const p = new FindPanel(ctx);
  p.open(project);
  return { p, ctx };
};

describe("the Find in Files panel", () => {
  it("typing searches after 250 ms with the saved options", async () => {
    store["desk.findOptions"] = JSON.stringify({ case: true, word: false, regex: true });
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    make();
    await type("pre", 249);
    expect(grepFiles).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(grepFiles).toHaveBeenCalledWith("/p", "pre", { case: true, word: false, regex: true });
    expect(el.querySelector("[data-list]").innerHTML).toContain('data-i="0"');
  });

  it("an older slow answer does not replace a newer one", async () => {
    let slow!: (r: GrepResult) => void;
    grepFiles.mockReturnValueOnce(new Promise((r) => (slow = r))).mockResolvedValueOnce(result(hit("new.txt", 2, "ab")));
    make();
    await type("a");
    await type("ab");
    slow(result(hit("old.txt", 1, "a")));
    await vi.advanceTimersByTimeAsync(0);
    const html = el.querySelector("[data-list]").innerHTML;
    expect(html).toContain("new.txt");
    expect(html).not.toContain("old.txt");
  });

  it("arrow keys move the selection and load the preview of that hit", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1), hit("b.txt", 3)));
    make();
    await type("pre");
    expect(readProjectText).toHaveBeenLastCalledWith("/p", "a.txt");
    expect(goTo).toHaveBeenLastCalledWith(1, [[0, 3]]);
    key("ArrowDown");
    await vi.advanceTimersByTimeAsync(0);
    expect(el.querySelector("[data-list]").innerHTML).toMatch(/ff-row sel" data-i="1"/);
    expect(readProjectText).toHaveBeenLastCalledWith("/p", "b.txt");
    expect(goTo).toHaveBeenLastCalledWith(3, [[0, 3]]);
    key("ArrowDown"); // at the end: stays
    key("ArrowUp");
    await vi.advanceTimersByTimeAsync(0);
    expect(readProjectText).toHaveBeenLastCalledWith("/p", "a.txt");
  });

  it("the first hit's preview reads it as a project file", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    make();
    await type("pre");
    expect(readProjectText).toHaveBeenCalledWith("/p", "a.txt");
    expect(createEditor).toHaveBeenCalledTimes(1);
  });

  it("a new answer reads the previewed file again (it may have changed on disk)", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    make();
    await type("pre");
    expect(readProjectText).toHaveBeenCalledTimes(1);
    await type("prev");
    expect(readProjectText).toHaveBeenCalledTimes(2);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(createEditor).toHaveBeenCalledTimes(2);
  });

  it("the preview selects the match in the whole line, not in the cut text", async () => {
    grepFiles.mockResolvedValue(result({ file: "min.js", line: 1, text: "…x", marks: [[61, 67]], cut: 29_940 }));
    make();
    await type("needle");
    expect(goTo).toHaveBeenLastCalledWith(1, [[30_000, 30_006]]);
  });

  it("Enter calls ctx.open(file, line) of the selected hit", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1), hit("src/b.txt", 3)));
    const { ctx } = make();
    await type("pre");
    key("ArrowDown");
    key("Enter");
    expect(ctx.open).toHaveBeenCalledWith("src/b.txt", 3, "/p");
  });

  it("keys typed in the preview editor stay there, except Escape", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1), hit("b.txt", 3)));
    const { p, ctx } = make();
    await type("pre");
    const inEditor = { target: target(".cm-editor") };
    key("ArrowDown", inEditor);
    key("PageDown", inEditor);
    key("Enter", inEditor);
    expect(el.querySelector("[data-list]").innerHTML).toMatch(/ff-row sel" data-i="0"/);
    expect(ctx.open).not.toHaveBeenCalled();
    key("Escape", inEditor);
    expect(p.isOpen).toBe(false);
  });

  it("opens as a popup over the window, once, and leaves the page on close", () => {
    const { p } = make();
    expect(el.className).toBe("overlay find-overlay");
    expect(appendChild).toHaveBeenCalledWith(el);
    p.open("/p"); // the shortcut again: the input gets the focus, no second popup
    expect(appendChild).toHaveBeenCalledTimes(1);
    expect(input().focus).toHaveBeenCalledTimes(2);
    p.close();
    expect(el.remove).toHaveBeenCalled();
    expect(p.isOpen).toBe(false);
  });

  it("a click outside the popup closes it like Esc; a click inside does not", () => {
    const { p, ctx } = make();
    el.fire("mousedown", { target: { closest: () => null }, preventDefault() {} });
    expect(p.isOpen).toBe(true);
    el.fire("mousedown", { target: el, preventDefault() {} });
    expect(p.isOpen).toBe(false);
    expect(ctx.closed).toHaveBeenCalledWith(true);
  });

  it("Enter while composing text does nothing", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    const { ctx } = make();
    await type("pre");
    key("Enter", { isComposing: true });
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it("a mouse press on the list or a toggle keeps the focus in the input", () => {
    make();
    for (const where of ["[data-list]", "[data-o]"]) {
      const preventDefault = vi.fn();
      el.fire("mousedown", { target: target(where), preventDefault });
      expect(preventDefault, where).toHaveBeenCalled();
    }
    const preventDefault = vi.fn();
    el.fire("mousedown", { target: target(".cm-editor"), preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it("Enter during the debounce opens the new query's first hit", async () => {
    grepFiles.mockResolvedValueOnce(result(hit("old.txt", 1))).mockResolvedValueOnce(result(hit("new.txt", 4)));
    const { ctx } = make();
    await type("pre");
    await type("prev", 100);
    key("Enter");
    await vi.advanceTimersByTimeAsync(0);
    expect(grepFiles).toHaveBeenLastCalledWith("/p", "prev", { case: false, word: false, regex: false });
    expect(ctx.open).toHaveBeenCalledTimes(1);
    expect(ctx.open).toHaveBeenCalledWith("new.txt", 4, "/p");
  });

  it("Enter while a search runs waits for its answer", async () => {
    let answer!: (r: GrepResult) => void;
    grepFiles.mockReturnValueOnce(new Promise((r) => (answer = r)));
    const { ctx } = make();
    await type("pre");
    key("Enter");
    expect(ctx.open).not.toHaveBeenCalled();
    answer(result(hit("a.txt", 2)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.open).toHaveBeenCalledWith("a.txt", 2, "/p");
  });

  it("reopened for another project, the old hits are gone and Enter waits for the new answer", async () => {
    grepFiles.mockResolvedValueOnce(result(hit("a.txt", 1)));
    const { p, ctx } = make();
    await type("pre");
    key("Escape");
    let answer!: (r: GrepResult) => void;
    grepFiles.mockReturnValueOnce(new Promise((r) => (answer = r)));
    p.open("/q");
    expect(el.querySelector("[data-list]").innerHTML).not.toContain("data-i");
    key("Enter");
    expect(ctx.open).not.toHaveBeenCalled();
    answer(result(hit("c.txt", 5)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.open).toHaveBeenCalledTimes(1);
    expect(ctx.open).toHaveBeenCalledWith("c.txt", 5, "/q");
  });

  it("new input forgets an Enter waiting for an answer", async () => {
    let answer!: (r: GrepResult) => void;
    grepFiles.mockReturnValueOnce(new Promise((r) => (answer = r))).mockResolvedValueOnce(result(hit("b.txt", 1)));
    const { ctx } = make();
    await type("pre");
    key("Enter");
    await type("prev");
    answer(result(hit("a.txt", 1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.open).not.toHaveBeenCalled();
  });

  it("Escape closes and calls ctx.closed()", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    const { p, ctx } = make();
    await type("pre");
    expect(p.isOpen).toBe(true);
    key("Escape");
    expect(p.isOpen).toBe(false);
    expect(ctx.closed).toHaveBeenCalledTimes(1);
    // Esc: the focus may go back where it was before the search.
    expect(ctx.closed).toHaveBeenCalledWith(true);
  });

  it("close() with a preview shown destroys its editor and calls ctx.closed()", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    const { p, ctx } = make();
    await type("pre");
    expect(createEditor).toHaveBeenCalledTimes(1);
    p.close();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toHaveBeenCalledTimes(1);
    expect(ctx.closed).toHaveBeenCalledWith(false);
    p.close(); // already closed: nothing more
    expect(ctx.closed).toHaveBeenCalledTimes(1);
  });

  it("a bad regex shows the error and no rows", async () => {
    grepFiles.mockRejectedValue("regex parse error:\n  unclosed group");
    make();
    await type("(");
    expect(el.querySelector("[data-msg]").textContent).toBe("regex parse error:\n  unclosed group");
    expect(el.querySelector("[data-list]").innerHTML).not.toContain("data-i");
  });

  it("toggles re-run the search and persist", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    make();
    await type("pre");
    grepFiles.mockClear();
    el.fire("click", { target: { closest: (s: string) => (s === "[data-o]" ? { dataset: { o: "word" } } : null) } });
    await vi.advanceTimersByTimeAsync(0);
    expect(grepFiles).toHaveBeenCalledWith("/p", "pre", { case: false, word: true, regex: false });
    expect(JSON.parse(store["desk.findOptions"])).toEqual({ case: false, word: true, regex: false });
  });

  it("without a project it says so and never searches", async () => {
    make(null);
    await type("pre");
    expect(grepFiles).not.toHaveBeenCalled();
    expect(el.querySelector("[data-msg]").textContent).toBe(t("find.noProject"));
  });

  it("an empty query clears the list without searching", async () => {
    grepFiles.mockResolvedValue(result(hit("a.txt", 1)));
    make();
    await type("pre");
    grepFiles.mockClear();
    await type("");
    expect(grepFiles).not.toHaveBeenCalled();
    expect(el.querySelector("[data-list]").innerHTML).not.toContain("data-i");
  });
});
