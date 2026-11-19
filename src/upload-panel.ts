// The Upload side panel: sits in `.middle` between the Docker panel and the
// files panel. The project's file tree, a server select and "Wyślij", which
// asks before anything is sent. Content: upload-view.ts; data: upload.rs.
import { api, type UploadHost, type UploadTile } from "./api";
import { dockSplitter, recall, remember } from "./dock-frame";
import { t } from "./i18n";
import { escapeHtml } from "./notices";
import { FileTree } from "./treeview";
import { choiceBox, toast } from "./ui";
import { barBottomHtml, barTopHtml, hostLabel, openPlan, uploadQuestion } from "./upload-view";

export interface UploadContext {
  /** The folder of the active project, if any. */
  project(): string | null;
  hosts(): UploadHost[];
  /** The session (tile or one left in tmux) sending this file of `project` to
   *  that user@host: "running" while its rsync runs, "finished" after, null when none. */
  existing(tile: UploadTile, project: string): Promise<"running" | "finished" | null>;
  /** Shows that session's tile (attached again when it had none). */
  focus(tile: UploadTile, project: string): Promise<void>;
  /** The tile sending a file of `project` (the one the question was about); `title` is its name. Settles once it opened (or failed to). */
  send(tile: UploadTile, title: string, project: string): Promise<void>;
  onLayout(): void;
}

const OPEN_KEY = "desk.uploadPanel";
const WIDTH_KEY = "desk.uploadWidth";
const HOST_KEY = "desk.uploadHost";
const DEFAULT_WIDTH = 340;
const MIN_WIDTH = 260;

export class UploadPanel {
  readonly el: HTMLElement;
  private topBar: HTMLElement;
  private bar: HTMLElement;
  private tree: FileTree;
  private shown = false;
  private tools: { rsync: boolean; ssh: boolean } | null = null;
  private toolsCall = false;
  private file: string | null = null;
  /** The project the tree shows: another one clears the selected file. */
  private shownProject: string | null = null;
  /** The question is up (its overlay is not part of the panel). */
  private confirming = false;

  constructor(private ctx: UploadContext) {
    this.el = document.createElement("aside");
    this.el.className = "side dock upload";
    this.el.hidden = true;
    this.el.innerHTML =
      `<div class="splitter"></div>` +
      `<div class="side-head"><span class="dock-title">${escapeHtml(t("upload.title"))}</span><span class="spacer"></span>` +
      `<button type="button" data-u="close" title="${escapeHtml(t("docker.close"))}">×</button></div>` +
      `<div class="ul-top-bar"></div><div class="ul-tree"></div><div class="ul-bar"></div>`;
    this.topBar = this.el.querySelector<HTMLElement>(".ul-top-bar")!;
    this.bar = this.el.querySelector<HTMLElement>(".ul-bar")!;
    this.tree = new FileTree({
      file: (rel) => this.pick(rel),
      folder: () => this.pick(null),
      edit: (rel) => this.pick(rel),
    });
    this.el.querySelector<HTMLElement>(".ul-tree")!.append(this.tree.el);
    const w = Number(recall(WIDTH_KEY));
    this.el.style.width = `${w > 0 ? Math.max(MIN_WIDTH, w) : DEFAULT_WIDTH}px`;
    this.el.addEventListener("click", (e) => void this.click(e.target as HTMLElement));
    this.el.addEventListener("change", (e) => this.change(e.target as HTMLElement));
    dockSplitter(this.el, MIN_WIDTH, WIDTH_KEY, () => this.ctx.onLayout());
    if (recall(OPEN_KEY) === "1") this.start();
  }

  get isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) this.close();
    else this.open();
  }

  open(): void {
    if (this.shown) return;
    this.start();
    remember(OPEN_KEY, "1");
    this.ctx.onLayout();
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    this.el.hidden = true;
    remember(OPEN_KEY, "0");
    this.ctx.onLayout();
  }

  /** The active project changed: its tree, no file picked. */
  projectChanged(): void {
    if (!this.shown) return;
    this.showProject();
    this.refresh();
  }

  /** The servers changed in Options: none left closes the panel, else draws the select again. */
  hostsChanged(): void {
    if (this.ctx.hosts().length === 0) return this.close();
    this.refresh();
  }

  private start(): void {
    this.shown = true;
    this.el.hidden = false;
    this.showProject();
    this.loadTools();
    this.refresh();
  }

  private showProject(): void {
    const project = this.ctx.project();
    if (project !== this.shownProject) this.file = null;
    this.shownProject = project;
    void this.tree.load(project);
  }

  /** rsync and ssh present? Asked once; a failed call is asked again on the next open. */
  private loadTools(): void {
    if (this.tools !== null || this.toolsCall) return;
    this.toolsCall = true;
    api
      .uploadTools()
      .then((tools) => (this.tools = tools))
      .catch((err) => toast(String(err), { kind: "error" }))
      .finally(() => {
        this.toolsCall = false;
        this.refresh();
      });
  }

  /** The chosen server: the remembered one while it is still set up, else the first. */
  private current(): UploadHost | null {
    const hosts = this.ctx.hosts();
    const saved = recall(HOST_KEY);
    return hosts.find((h) => hostLabel(h) === saved) ?? hosts[0] ?? null;
  }

  private pick(file: string | null): void {
    this.file = file;
    this.refresh();
  }

  private refresh(): void {
    if (!this.shown) return;
    const h = this.current();
    const state = {
      project: this.ctx.project(),
      tools: this.tools,
      hosts: this.ctx.hosts(),
      host: h ? hostLabel(h) : null,
      file: this.file,
    };
    this.topBar.innerHTML = barTopHtml(state);
    this.bar.innerHTML = barBottomHtml(state);
  }

  private change(target: HTMLElement): void {
    const select = target.closest<HTMLSelectElement>("[data-u=host]");
    if (!select) return;
    remember(HOST_KEY, select.value);
    this.refresh();
  }

  private async click(target: HTMLElement): Promise<void> {
    const u = target.closest<HTMLElement>("[data-u]")?.dataset.u;
    if (u === "close") return this.close();
    if (u === "send") return this.send();
  }

  private async send(): Promise<void> {
    const project = this.ctx.project();
    const h = this.current();
    const file = this.file;
    if (this.confirming || project === null || h === null || file === null) return;
    // The active project changed without the tree hearing of it: `file` is another project's.
    if (project !== this.shownProject) return this.projectChanged();
    const tile: UploadTile = { host: h.host, user: h.user, file };
    this.confirming = true;
    try {
      // Still sending: shown, never a second rsync; nothing to confirm.
      if (openPlan(await this.ctx.existing(tile, project)) === "focus") {
        await this.ctx.focus(tile, project);
        return toast(t("upload.alreadyRunning"));
      }
      const info = await api.uploadFileSize(project, file);
      const { message, prod } = uploadQuestion(file, info, h);
      const answer = await choiceBox(message, t("upload.send"), { warning: prod ? t("upload.prodWarning") : undefined });
      if (answer !== "ok") return;
      await this.ctx.send(tile, t("upload.tile", { file, host: h.host }), project);
    } catch (err) {
      toast(String(err), { kind: "error" });
    } finally {
      this.confirming = false;
    }
  }
}
