// The main window's stand-in for the side panel while the panel lives in the
// files window (Options → Okno i układ). It keeps no panel of its own: every
// call becomes a `files:do` command (files-link.ts), and what the window
// reports back (`files:said`) is what it knows. The Find in Files popup stays
// here; a picked hit opens in the files window.

import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { api } from "./api";
import { inProject } from "./address";
import { FindPanel } from "./find-panel";
import { editorChoice } from "./find-view";
import { TO_FILES, TO_MAIN, type FilesCommand, type FilesReport, type FilesSettings } from "./files-link";
import { t } from "./i18n";
import type { Panel } from "./side";
import { toast } from "./ui";

/** How long switching the mode off waits for the files window to save its edit. */
const RELEASE_MS = 10_000;

/** What main types for the files window: an @-mention, no control character (one could end the line). */
// eslint-disable-next-line no-control-regex
const MENTION = /^@[^\x00-\x1f\x7f]*$/;

/** What the stand-in needs from the main window. */
export interface FilesWindowContext {
  /** Folder of the active session's project, if any. */
  project(): string | null;
  /** Options the files window follows (Layout). */
  settings(): FilesSettings;
  /** Type text into the active session (no Enter). */
  insert(text: string): void;
  /** A plain terminal in this folder. */
  terminal(path: string): void;
  /** The window opened, closed or showed its files: the top bar follows. */
  changed(): void;
}

/**
 * Hand the panel to another host (Options switched where it lives). `stop`
 * first: false (a dirty file did not save) changes nothing. Then the old host
 * lets go (its native preview, its window), `swap` makes `to` the panel, and
 * `to` shows what `from` showed, unless `mayShow` says no (desk locked
 * meanwhile: no page over the lock screen). Nothing waits for that last step.
 */
export async function switchPanel(
  from: Panel,
  to: Panel,
  stop: () => Promise<boolean>,
  swap: (to: Panel) => void,
  mayShow: () => boolean = () => true,
): Promise<boolean> {
  if (!(await stop())) return false;
  const open = from.isOpen;
  const shown = open ? from.shown() : null;
  const files = from.filesShown;
  await from.handOver();
  swap(to);
  if (!mayShow()) return true;
  if (shown) void to.open(shown).catch(() => undefined);
  else if (open && files) to.showFiles();
  else if (open) to.toggle();
  return true;
}

export class FilesWindowPanel implements Panel {
  /** Nothing to show here: the panel is in its own window. */
  readonly el: HTMLElement;
  private find: FindPanel;
  /** What had the focus when the search opened; closing it without a file gives it back. */
  private beforeFind: HTMLElement | null = null;
  /** The files window has loaded and listens. */
  private ready = false;
  /** Commands sent before it was ready, in order. */
  private queue: FilesCommand[] = [];
  /** Each command waits for the one before (opening the window takes a while). */
  private chain: Promise<void> = Promise.resolve();
  /** The last state the files window (or Rust, when it hid it) reported. */
  private state: { open: boolean; filesShown: boolean; shown: string | null } = { open: false, filesShown: false, shown: null };
  private listening: Promise<UnlistenFn>;
  /** Handed over (the mode switched off): the window is gone, reports are ignored. */
  private retired = false;
  /** A `release` waits for the `released` with its id (a late answer to an earlier one is not it). */
  private released: { id: number; done: (ok: boolean) => void } | null = null;
  private releaseIds = 0;
  /** A files window was made or shown for this stand-in, or answered it: there may be one to close. */
  private reached = false;

  constructor(private ctx: FilesWindowContext) {
    this.el = document.createElement("div");
    this.el.hidden = true;
    const find: FindPanel = new FindPanel({
      open: (file, line, project) => {
        find.close();
        this.openAt(file, line, project);
      },
      closed: (back) => {
        const before = this.beforeFind;
        this.beforeFind = null;
        if (back && before?.isConnected) before.focus();
      },
    });
    this.find = find;
    // Before any command can open the window, so its `ready` is never missed.
    this.listening = listen<FilesReport>(TO_MAIN, (e) => this.heard(e.payload));
    // A files window may be there already (this page reloaded): it answers `ready` again.
    void this.listening.then(() => this.emit({ op: "hello" }));
  }

  get isOpen(): boolean {
    return this.state.open;
  }

  get filesShown(): boolean {
    return this.state.filesShown;
  }

  shown(): string | null {
    return this.state.shown;
  }

  browse(): void {
    this.send({ op: "browse" });
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.send({ op: "reveal" });
  }

  toggleFiles(): void {
    if (this.filesShown) this.close();
    else this.showFiles();
  }

  showFiles(): void {
    this.send({ op: "showFiles" });
  }

  /** ⇧⌘F: the popup here, for the active project. */
  showFind(seed?: string): void {
    const active = document.activeElement;
    if (!this.find.isOpen && active instanceof HTMLElement && !this.find.el.contains(active)) this.beforeFind = active;
    this.find.open(this.ctx.project(), seed);
  }

  projectChanged(): void {
    this.send({ op: "project", project: this.ctx.project() }, false);
  }

  /** Options changed something the files window shows (language, theme, browser...). */
  settingsChanged(): void {
    this.send({ op: "settings", settings: this.ctx.settings() }, false);
  }

  relabel(): void {
    this.find.relabel();
  }

  /** The files window names the browser itself, from the settings it gets. */
  browserChanged(): Promise<void> {
    return Promise.resolve();
  }

  /** Sent, not awaited: the files window shows its own errors. */
  open(link: string, project?: string): Promise<void> {
    this.send({ op: "open", link, project });
    return Promise.resolve();
  }

  /** A Find in Files hit: in the files window's editor, or in the program from Options. */
  private openAt(file: string, line: number, project: string): void {
    if (editorChoice(this.ctx.settings().fileEditor) === "program") {
      void api.openFileAt(project, file, line).catch((err) => toast(String(err), { kind: "error" }));
      return;
    }
    this.send({ op: "openAt", file, line, project });
  }

  /** Hide the window (its state stays); Rust reports it closed. */
  close(): void {
    this.chain = this.chain.then(() => api.filesWindowHide().catch(() => undefined));
  }

  /**
   * Before the mode switches off: the files window saves its edit (as ✎ does)
   * and says what it shows after. True: saved, or nothing to save (the window
   * never loaded: no command reached it, so it holds no edit). False keeps the
   * mode: the save failed, or no answer came in `ms` (a loaded window may hold
   * an edit, and destroying it would drop that silently).
   */
  release(ms = RELEASE_MS): Promise<boolean> {
    if (this.retired || !this.ready) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const finish = (ok: boolean, why: string): void => {
        clearTimeout(timer);
        this.released = null;
        if (!ok) toast(why, { kind: "warn" });
        resolve(ok);
      };
      timer = setTimeout(() => finish(false, t("filesWin.noAnswer")), ms);
      const id = ++this.releaseIds;
      this.released = { id, done: (ok) => finish(ok, t("filesWin.notSaved")) };
      // Not shown: saving needs no window on screen (a failed save says so here).
      this.send({ op: "release", id }, false);
    });
  }

  /** The mode is off: the window goes for good, after what was already sent. */
  async handOver(): Promise<void> {
    this.retired = true;
    this.queue = [];
    this.state = { open: false, filesShown: false, shown: null };
    this.find.close();
    (await this.listening)();
    // Never reached a window (a refused switch): the native page, if any, is the side panel's.
    if (!this.reached) return;
    // The native page first: the side panel's next open must not find it under the dying window.
    this.chain = this.chain
      .then(() => api.previewClose().catch(() => undefined))
      .then(() => api.filesWindowDestroy().catch(() => undefined));
    await this.chain;
  }

  browserPref(): string {
    return this.ctx.settings().browser;
  }

  linkClickPref(): string {
    return this.ctx.settings().linkClick;
  }

  /**
   * `show`: open the window first (it may be hidden or not made yet). Settings
   * and the project are not kept for a window that is not ready: `ready` sends
   * them fresh.
   */
  private send(cmd: FilesCommand, show = true): void {
    if (this.retired) return;
    if (!show && !this.ready) return;
    this.chain = this.chain.then(async () => {
      await this.listening;
      if (this.retired) return;
      if (show) {
        // Before the await: a switch-off during the build must still destroy the window.
        const before = this.reached;
        this.reached = true;
        try {
          await api.filesWindowOpen();
        } catch (err) {
          this.reached = before;
          // Refused while desk is locked: the command must not act on a hidden window.
          toast(String(err), { kind: "warn" });
          return;
        }
      }
      if (this.ready) this.emit(cmd);
      else this.queue.push(cmd);
    });
  }

  private emit(cmd: FilesCommand): void {
    void emitTo("files", TO_FILES, cmd).catch(() => undefined);
  }

  private heard(r: FilesReport): void {
    if (this.retired) return;
    switch (r.op) {
      case "ready": {
        this.ready = true;
        this.reached = true;
        // The page knows no project and no Options until told: those first.
        this.emit({ op: "settings", settings: this.ctx.settings() });
        this.emit({ op: "project", project: this.ctx.project() });
        const queued = this.queue;
        this.queue = [];
        for (const cmd of queued) this.emit(cmd);
        return;
      }
      case "state":
        this.state = { open: r.open, filesShown: r.filesShown, shown: r.shown };
        this.ctx.changed();
        return;
      case "insert":
        // The files page has no pty_write: it may only ask for an @-mention (mention() adds the quotes itself).
        if (typeof r.text !== "string" || !MENTION.test(r.text)) return toast(t("side.unsafePath"), { kind: "warn" });
        return this.ctx.insert(r.text);
      case "terminal": {
        // A shell only where the active project is (no `..` out of it).
        const project = this.ctx.project();
        if (typeof r.path !== "string" || !project || !inProject(project, r.path) || /(^|[\\/])\.\.([\\/]|$)/.test(r.path)) {
          return toast(t("side.unsafePath"), { kind: "warn" });
        }
        return this.ctx.terminal(r.path);
      }
      case "find":
        return this.showFind();
      case "released":
        // Late (after its timeout, maybe during a later request): the mode stayed, nothing to do.
        if (this.released?.id !== r.id) return;
        this.state = { ...this.state, shown: r.shown };
        return this.released.done(r.ok);
    }
  }
}
