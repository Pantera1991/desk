// Find in Files: a popup over the window (like PhpStorm's). An input with
// toggles, the hit list and a read-only preview of the selected hit under it.
// Being an .overlay, it also hides the side panel's native page while open.

import { api, type GrepHit, type GrepOptions, type GrepResult } from "./api";
import { createEditor, type Editor } from "./editor";
import { headerText, Latest, lineMarks, loadOptions, moveSelection, rowHtml, saveOptions } from "./find-view";
import { t } from "./i18n";

const DEBOUNCE_MS = 250;
const PAGE = 10;

export interface FindPanelContext {
  /** Enter or a double click: open `file` (relative to `project`) at `line`. */
  open(file: string, line: number, project: string): void;
  /** The popup is closed; `back` when it closed without opening a file (Esc, a click outside). */
  closed(back: boolean): void;
}

export class FindPanel {
  readonly el: HTMLElement;
  private q: HTMLInputElement;
  private count: HTMLElement;
  private msg: HTMLElement;
  private list: HTMLElement;
  private pathLine: HTMLElement;
  private box: HTMLElement;
  private project: string | null = null;
  private opts: GrepOptions = loadOptions();
  private result: GrepResult | null = null;
  private error: string | null = null;
  private hits: GrepHit[] = [];
  private selected = -1;
  private timer: ReturnType<typeof setTimeout> | undefined;
  /** The latest search was sent and has not answered yet. */
  private waiting = false;
  /** Enter came while the hits were not those of the input yet: open the first answer's selection. */
  private enterWhenReady = false;
  private searches = new Latest();
  private previews = new Latest();
  /** The preview's file (`project + "\0" + file`): its text is kept while the selection stays in it. */
  private shown: { path: string; text: string; editor: Editor } | null = null;
  private cached: { path: string; text: string } | null = null;
  /** The popup is in the page. */
  private opened = false;

  constructor(private ctx: FindPanelContext) {
    this.el = document.createElement("div");
    this.el.className = "overlay find-overlay";
    this.el.innerHTML = `
      <div class="dialog find">
        <div class="ff-head"><span class="ff-title"></span><span class="ff-count" data-count></span>
          <button data-o="case">Aa</button><button data-o="word">W</button><button data-o="regex">.*</button></div>
        <input type="text" class="ff-input" data-q spellcheck="false" autocomplete="off" />
        <div class="ff-msg" data-msg></div>
        <div class="ff-list" data-list></div>
        <div class="ff-path" data-path></div>
        <div class="ff-prev" data-prev></div>
      </div>`;
    this.q = this.el.querySelector("[data-q]")!;
    this.count = this.el.querySelector("[data-count]")!;
    this.msg = this.el.querySelector("[data-msg]")!;
    this.list = this.el.querySelector("[data-list]")!;
    this.pathLine = this.el.querySelector("[data-path]")!;
    this.box = this.el.querySelector("[data-prev]")!;
    this.relabel();
    this.q.addEventListener("input", () => this.schedule());
    this.el.addEventListener("keydown", (e) => this.key(e as KeyboardEvent));
    // A click on a row or a toggle keeps the focus in the input (WebKit would
    // move it to <body>, and the panel's keys would stop working).
    this.el.addEventListener("mousedown", (e) => {
      // A click outside the popup closes it, the way Esc does.
      if (e.target === this.el) return this.close(true);
      const target = e.target as HTMLElement;
      if (target.closest("[data-list]") || target.closest("[data-o]")) e.preventDefault();
    });
    this.el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const o = target.closest<HTMLElement>("[data-o]")?.dataset.o as keyof GrepOptions | undefined;
      if (o) return this.toggle(o);
      const i = target.closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) this.select(Number(i));
    });
    this.el.addEventListener("dblclick", (e) => {
      const i = (e.target as HTMLElement).closest<HTMLElement>("[data-i]")?.dataset.i;
      if (i !== undefined) {
        this.select(Number(i));
        this.enter();
      }
    });
    this.syncToggles();
  }

  get isOpen(): boolean {
    return this.opened;
  }

  relabel(): void {
    const set = (sel: string, text: string) => {
      const e = this.el.querySelector<HTMLElement>(sel);
      if (e) e.textContent = text;
    };
    set(".ff-title", t("find.title"));
    this.q.placeholder = t("find.placeholder");
    for (const [o, key] of [["case", "find.case"], ["word", "find.word"], ["regex", "find.regex"]] as const) {
      const b = this.el.querySelector<HTMLElement>(`[data-o="${o}"]`);
      if (b) b.title = t(key);
    }
  }

  /** Show the popup for `project`; `seed` goes into the input. Open already: focus the input again. */
  open(project: string | null, seed?: string): void {
    if (project !== this.project) {
      // Another project: its hits are not these, never open one of them.
      this.abandon();
      this.hits = [];
      this.result = null;
      this.error = null;
      this.selected = -1;
      this.cached = null;
      this.draw();
    }
    this.project = project;
    if (!this.opened) {
      this.opened = true;
      document.body.appendChild(this.el);
    }
    if (seed) this.q.value = seed;
    this.q.focus();
    this.q.select();
    if (!project) {
      this.abandon();
      this.hits = [];
      this.result = null;
      this.draw();
      this.msg.textContent = t("find.noProject");
      return;
    }
    if (this.q.value.trim()) void this.run();
    else this.draw();
  }

  /** Close the popup; `back` when no file was opened from it (Esc, a click outside). */
  close(back = false): void {
    if (!this.opened) return;
    this.opened = false;
    this.el.remove();
    this.abandon();
    this.clearPreview();
    this.cached = null;
    this.ctx.closed(back);
  }

  /** Forget a pending search, the answer of a running one and a waiting Enter. */
  private abandon(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    this.searches.next();
    this.waiting = false;
    this.enterWhenReady = false;
  }

  /** The hits shown may not be those of the input yet: a search is due or running. */
  private get pending(): boolean {
    return this.timer !== undefined || this.waiting;
  }

  private schedule(): void {
    this.enterWhenReady = false;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.run(), DEBOUNCE_MS);
  }

  private toggle(o: keyof GrepOptions): void {
    this.enterWhenReady = false;
    this.opts = { ...this.opts, [o]: !this.opts[o] };
    saveOptions(this.opts);
    this.syncToggles();
    void this.run();
  }

  private syncToggles(): void {
    for (const o of ["case", "word", "regex"] as const) this.el.querySelector(`[data-o="${o}"]`)?.classList.toggle("on", this.opts[o]);
  }

  private async run(): Promise<void> {
    clearTimeout(this.timer);
    this.timer = undefined;
    const n = this.searches.next();
    const query = this.q.value;
    this.waiting = false;
    if (!this.project) return;
    if (!query.trim()) return this.answer(null, null);
    this.waiting = true;
    let r: GrepResult;
    try {
      r = await api.grepFiles(this.project, query, this.opts);
    } catch (err) {
      if (!this.searches.isLatest(n)) return;
      return this.answer(null, String(err));
    }
    if (!this.searches.isLatest(n) || !this.isOpen) return;
    this.answer(r, null);
  }

  /** The latest search answered (or there is nothing to search): show it, then a waiting Enter. */
  private answer(r: GrepResult | null, error: string | null): void {
    this.waiting = false;
    this.result = r;
    this.error = error;
    this.hits = r?.hits ?? [];
    this.selected = this.hits.length ? 0 : -1;
    // A file may have changed since the last search: read the preview again.
    this.cached = null;
    this.clearPreview();
    this.draw();
    if (this.enterWhenReady) {
      this.enterWhenReady = false;
      this.enter();
    }
  }

  private draw(): void {
    this.list.innerHTML = this.hits.map((h, i) => rowHtml(h, i === this.selected, i)).join("");
    // The error may span lines: textContent, never innerHTML.
    const text = headerText(this.result, this.error);
    if (this.error) {
      this.count.textContent = "";
      this.msg.textContent = text;
    } else {
      const none = this.result && this.hits.length === 0;
      this.count.textContent = none ? "" : text;
      this.msg.textContent = none ? t("find.none") : "";
    }
    this.list.querySelector(".sel")?.scrollIntoView?.({ block: "nearest" });
    void this.preview();
  }

  private select(i: number): void {
    const next = moveSelection(i, 0, this.hits.length);
    if (next === this.selected) return;
    this.selected = next;
    this.draw();
  }

  private key(e: KeyboardEvent): void {
    // In the preview the editor's own keys move its cursor; only Esc is ours.
    const inPreview = (e.target as Element | null)?.closest?.(".cm-editor");
    if (inPreview && e.key !== "Escape") return;
    const move = (d: number) => {
      e.preventDefault();
      this.select(this.hits.length ? moveSelection(this.selected, d, this.hits.length) : -1);
    };
    if (e.key === "ArrowDown") move(1);
    else if (e.key === "ArrowUp") move(-1);
    else if (e.key === "PageDown") move(PAGE);
    else if (e.key === "PageUp") move(-PAGE);
    else if (e.key === "Enter") {
      if (e.isComposing) return; // Enter ends the composition, it opens nothing
      e.preventDefault();
      this.requestEnter();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      this.close(true);
    }
  }

  /** Enter: the selected hit now, or, while the hits are stale, the first answer's (searching at once). */
  private requestEnter(): void {
    if (!this.pending) return this.enter();
    this.enterWhenReady = true;
    if (this.timer !== undefined) void this.run();
  }

  private enter(): void {
    const h = this.hits[this.selected];
    if (h && this.project) this.ctx.open(h.file, h.line, this.project);
  }

  private clearPreview(): void {
    this.previews.next();
    this.shown?.editor.destroy();
    this.shown = null;
    this.pathLine.textContent = "";
    this.box.replaceChildren();
  }

  /** The selected hit's file, scrolled to its line. */
  private async preview(): Promise<void> {
    const h = this.hits[this.selected];
    const project = this.project;
    if (!h || !project) return this.clearPreview();
    const n = this.previews.next();
    const path = project + "\0" + h.file;
    this.pathLine.textContent = h.file;
    if (this.shown?.path === path) {
      this.shown.editor.goTo(h.line, lineMarks(h));
      return;
    }
    let text: string;
    if (this.cached?.path === path) text = this.cached.text;
    else {
      try {
        text = await api.readProjectText(project, h.file);
      } catch (err) {
        if (!this.previews.isLatest(n)) return;
        this.shown?.editor.destroy();
        this.shown = null;
        this.box.replaceChildren();
        this.pathLine.textContent = `${h.file}: ${String(err)}`;
        return;
      }
      this.cached = { path, text };
    }
    if (!this.previews.isLatest(n) || !this.isOpen) return;
    this.shown?.editor.destroy();
    this.box.replaceChildren();
    const editor = createEditor(this.box, text, h.file.slice(h.file.lastIndexOf("/") + 1), { change() {}, save() {} }, { readOnly: true });
    this.shown = { path, text, editor };
    editor.goTo(h.line, lineMarks(h));
  }
}
