// The Docker side panel: sits in `.middle` between the stage and the files
// panel, asks for the servers every 5 s while open (never two calls at once,
// none while the window is hidden), keeps its scroll across refreshes.
// Content: docker-view.ts; data: docker.rs.
import { api, type DockerOverview, DockerTile } from "./api";
import { deployFolder, deployQuestion, flipOpen, renderDocker, restartQuestion, rmErrorMessage } from "./docker-view";
import { t } from "./i18n";
import { escapeHtml } from "./notices";
import { confirmBox, toast } from "./ui";

export interface DockerPanelContext {
  overview(): Promise<DockerOverview>;
  /** Folders of the open cards: where a compose project may be deployed from. */
  openPaths(): string[];
  /** A logs, shell or deploy tile for a container or compose project; `title` is its name. Settles once it opened (or failed to). */
  open(tile: DockerTile, title: string, path?: string): Promise<void>;
  removeImage(host: string, image: string): Promise<void>;
  restart(host: string, container: string): Promise<void>;
  /** Focuses the deploy tile of that project (attaching again one still running without a tile); false when there is none. */
  focusDeploy(host: string, project: string): boolean;
}

/** Fresh numbers this often while open. */
export const DOCKER_EVERY_MS = 5000;
const STORE = "desk.dockerOpen";
const OPEN_KEY = "desk.dockerPanel";
const WIDTH_KEY = "desk.dockerWidth";
const DEFAULT_WIDTH = 380;
const MIN_WIDTH = 280;

function loadOpen(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(STORE) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

function saveOpen(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORE, JSON.stringify([...open]));
  } catch {
    // Not remembered; the branches simply start folded next time.
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Not remembered.
  }
}

function recall(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export class DockerPanel {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private shown = false;
  private overview: DockerOverview | null = null;
  private error: string | null = null;
  private pending = false;
  /** Bumped on close: a call still in flight from before belongs to no one. */
  private gen = 0;
  /** The confirmation of a removal is up (its overlay is not part of the panel). */
  private confirming = false;
  /** Asked again right after the call in flight (a removal finished meanwhile). */
  private again = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private html = "";
  private branches = loadOpen();
  /** "host|image" of the images being removed. */
  private busy = new Set<string>();
  /** "host|project" from a click on "Wdróż" until its tile opened: one deploy at a time. */
  private deploying = new Set<string>();
  /** Open folders holding a compose file (compose_dirs), asked for `composeKey` (the paths joined). */
  private compose = new Set<string>();
  private composeKey: string | null = null;

  constructor(
    private onLayout: () => void,
    private ctx: DockerPanelContext,
  ) {
    this.el = document.createElement("aside");
    this.el.className = "side dock";
    this.el.hidden = true;

    this.el.innerHTML =
      `<div class="splitter"></div>` +
      `<div class="side-head"><span class="dock-title">🐳 ${escapeHtml(t("docker.title"))}</span><span class="spacer"></span>` +
      `<button type="button" data-d="refresh" title="${escapeHtml(t("docker.refresh"))}">⟳</button>` +
      `<button type="button" data-d="close" title="${escapeHtml(t("docker.close"))}">×</button></div>` +
      `<div class="dock-body"></div>`;
    this.body = this.el.querySelector<HTMLElement>(".dock-body")!;
    const w = Number(recall(WIDTH_KEY));
    this.el.style.width = `${w > 0 ? Math.max(MIN_WIDTH, w) : DEFAULT_WIDTH}px`;
    this.el.addEventListener("click", (e) => void this.click(e.target as HTMLElement));
    this.splitter();
    document.addEventListener("visibilitychange", () => {
      if (this.shown && !document.hidden) this.fetch();
    });
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
    this.onLayout();
  }

  private start(): void {
    this.shown = true;
    this.overview = null;
    this.error = null;
    this.composeKey = null;
    this.el.hidden = false;
    this.fetch();
    // A tick never queues behind a slow call, and none fires while the window is hidden.
    this.timer = setInterval(() => {
      if (!this.pending && !document.hidden) this.fetch();
    }, DOCKER_EVERY_MS);
    this.refresh();
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    clearInterval(this.timer);
    this.again = false;
    this.gen++; // `pending` stays up until that call settles: never two at once
    this.el.hidden = true;
    this.body.innerHTML = this.html = "";
    remember(OPEN_KEY, "0");
    this.onLayout();
  }

  /** Draws it again from the latest data, keeping its scroll. */
  refresh(): void {
    if (!this.shown) return;
    const err = this.error ? `<p class="dim dk-fail">${escapeHtml(this.error)}</p>` : "";
    const html = `${err}${renderDocker(this.overview, this.branches, this.busy, this.deployable())}`;
    if (html === this.html) return;
    const scroll = this.body.scrollTop;
    this.body.innerHTML = this.html = html;
    this.body.scrollTop = scroll;
  }

  /** "host|project" → the open card's folder it deploys from (one with a compose file). */
  private deployable(): Map<string, string> {
    const map = new Map<string, string>();
    const paths = this.ctx.openPaths();
    for (const h of this.overview?.hosts ?? []) {
      for (const project of new Set(h.containers.map((c) => c.project).filter((p): p is string => p !== null))) {
        const path = deployFolder(project, h.containers, paths);
        if (path !== null && this.compose.has(path)) map.set(`${h.name}|${project}`, path);
      }
    }
    return map;
  }

  private async click(target: HTMLElement): Promise<void> {
    const b = target.closest<HTMLElement>("[data-d]");
    if (b) {
      const { d, host = "", target: what = "", question = "" } = b.dataset;
      if (d === "refresh") {
        this.composeKey = null; // a compose file may have been added meanwhile
        return this.fetch();
      }
      if (d === "close") return this.close();
      if (d === "logs" || d === "projectLogs" || d === "shell") {
        const label = d === "shell" ? t("docker.tileShell", { name: what }) : t("docker.tileLogs", { name: what });
        return this.ctx.open({ host, target: what, kind: d }, label).catch((err) => toast(String(err), { kind: "error" }));
      }
      if (d === "rm") return this.remove(host, what, question);
      if (d === "restart") return this.restart(host, what);
      if (d === "deploy") return this.deploy(host, what, b.dataset.path ?? "");
      return;
    }
    const id = target.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (id) {
      this.branches = flipOpen(id, this.branches);
      saveOpen(this.branches);
      this.refresh();
    }
  }

  private async remove(host: string, image: string, question: string): Promise<void> {
    const key = `${host}|${image}`;
    if (this.busy.has(key) || this.confirming) return;
    this.confirming = true;
    let ok: boolean;
    try {
      ok = await confirmBox(question, t("docker.remove"));
    } finally {
      this.confirming = false;
    }
    if (!ok) return;
    this.busy.add(key);
    this.refresh();
    try {
      await this.ctx.removeImage(host, image);
      toast(t("docker.removed", { image, host }), { kind: "ok" });
    } catch (err) {
      toast(rmErrorMessage(String(err), image), { kind: "error" });
    }
    this.busy.delete(key);
    this.fetch();
    this.refresh();
  }

  private async restart(host: string, container: string): Promise<void> {
    const key = `${host}|${container}`;
    if (this.busy.has(key) || this.confirming) return;
    this.confirming = true;
    let ok: boolean;
    try {
      ok = await confirmBox(restartQuestion(host, container), t("docker.restart"));
    } finally {
      this.confirming = false;
    }
    if (!ok) return;
    this.busy.add(key);
    this.refresh();
    try {
      await this.ctx.restart(host, container);
      toast(t("docker.restarted", { container, host }), { kind: "ok" });
    } catch (err) {
      toast(String(err), { kind: "error" });
    }
    this.busy.delete(key);
    this.fetch();
    this.refresh();
  }

  private async deploy(host: string, project: string, path: string): Promise<void> {
    const key = `${host}|${project}`;
    if (this.confirming || this.deploying.has(key) || path === "") return;
    this.deploying.add(key);
    try {
      if (this.ctx.focusDeploy(host, project)) return;
      // Drawn before a card closed or another one of the project opened: draw again, ask nothing.
      if (this.deployable().get(key) !== path) {
        this.refresh();
        this.fetch();
        return;
      }
      this.confirming = true;
      let ok: boolean;
      try {
        const git = await api.gitStatusSummary(path).catch(() => null);
        ok = await confirmBox(deployQuestion(host, project, path, git), t("docker.deploy"));
      } finally {
        this.confirming = false;
      }
      // A deploy tile may have come up while the question was open.
      if (!ok || this.ctx.focusDeploy(host, project)) return;
      await this.ctx.open({ host, target: project, kind: "deploy" }, t("docker.tileDeploy", { name: project }), path);
    } catch (err) {
      toast(String(err), { kind: "error" });
    } finally {
      this.deploying.delete(key);
    }
  }

  /** Which open folders hold a compose file: asked only when the open folders
   *  changed since the last answer (at most once per refresh). A failed call
   *  shows no new button and is asked again on the next refresh. */
  private async askCompose(gen: number): Promise<void> {
    const paths = this.ctx.openPaths();
    const key = paths.join("\n");
    if (key === this.composeKey) return;
    let dirs: string[] = [];
    if (paths.length > 0) {
      try {
        dirs = await api.composeDirs(paths);
      } catch {
        return;
      }
    }
    if (gen !== this.gen) return;
    this.compose = new Set(dirs);
    this.composeKey = key;
  }

  /** One request at a time; asked for while one is in flight, it follows right after. */
  private fetch(): void {
    if (!this.shown) return;
    if (this.pending) {
      this.again = true;
      return;
    }
    this.pending = true;
    const gen = this.gen;
    let call: Promise<DockerOverview>;
    try {
      call = this.ctx.overview();
    } catch (err) {
      call = Promise.reject(err);
    }
    call
      .then(async (o) => {
        if (gen !== this.gen) return;
        this.overview = o;
        this.error = null;
        await this.askCompose(gen);
      })
      // Shown in the panel; asked again in 5 s.
      .catch((err) => {
        if (gen === this.gen) this.error = String(err);
      })
      .finally(() => {
        this.pending = false;
        if (gen !== this.gen) {
          // Closed meanwhile; opened again since: the one call it waited for.
          if (this.shown && this.again) {
            this.again = false;
            this.fetch();
          }
          return;
        }
        this.refresh();
        if (this.again && this.shown) {
          this.again = false;
          this.fetch();
        }
        this.again = false;
      });
  }

  private splitter(): void {
    const bar = this.el.querySelector<HTMLElement>(".splitter");
    if (!bar) return;
    bar.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      bar.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const startW = this.el.getBoundingClientRect().width;
      const move = (ev: PointerEvent) => {
        const max = window.innerWidth - 320;
        const w = Math.min(max, Math.max(MIN_WIDTH, startW + startX - ev.clientX));
        this.el.style.width = `${w}px`;
      };
      const up = () => {
        bar.removeEventListener("pointermove", move);
        bar.removeEventListener("pointerup", up);
        remember(WIDTH_KEY, String(Math.round(this.el.getBoundingClientRect().width)));
        this.onLayout();
      };
      bar.addEventListener("pointermove", move);
      bar.addEventListener("pointerup", up);
    });
  }
}
