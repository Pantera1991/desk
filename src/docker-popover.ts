// The Docker chip's panel: slides down under the chip like the temperature
// panel, asks for the servers every 5 s while open (never two calls at once),
// keeps its scroll across refreshes, closes on Esc, a click elsewhere or the
// window losing focus. Content: docker-view.ts; data: docker.rs.
import type { DockerOverview, DockerTile } from "./api";
import { flipOpen, renderDocker } from "./docker-view";
import { t } from "./i18n";
import { escapeHtml } from "./notices";
import { confirmBox, toast } from "./ui";

export interface DockerPopoverContext {
  overview(): Promise<DockerOverview>;
  /** A logs or shell tile for a container or compose project; `title` is its name. */
  open(tile: DockerTile, title: string): void;
  removeImage(host: string, image: string): Promise<void>;
}

const CHIP = '[data-top="docker"]';
/** Fresh numbers this often while open. */
export const DOCKER_EVERY_MS = 5000;
const GAP = 8;
const STORE = "desk.dockerOpen";

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

export class DockerPopover {
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
  private el: HTMLElement;
  private html = "";
  private open = loadOpen();
  /** "host|image" of the images being removed. */
  private busy = new Set<string>();

  constructor(
    host: HTMLElement,
    private ctx: DockerPopoverContext,
  ) {
    this.el = document.createElement("div");
    this.el.className = "up-host";
    this.el.hidden = true;
    host.append(this.el);
    this.el.addEventListener("click", (e) => void this.click(e.target as HTMLElement));
    const leave = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (this.shown && !this.confirming && target && !this.el.contains(target) && !target.closest(CHIP)) this.close();
    };
    document.addEventListener("mousedown", leave, true);
    document.addEventListener("focusin", leave, true);
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.shown && !this.confirming && e.key === "Escape") {
          e.preventDefault();
          e.stopImmediatePropagation();
          this.close();
        }
      },
      true,
    );
    window.addEventListener("blur", () => this.close());
    window.addEventListener("resize", () => this.refresh());
  }

  get isOpen(): boolean {
    return this.shown;
  }

  toggle(): void {
    if (this.shown) return this.close();
    this.shown = true;
    this.overview = null;
    this.error = null;
    this.fetch();
    // A tick never queues behind a slow call: it is skipped.
    this.timer = setInterval(() => {
      if (!this.pending) this.fetch();
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
    this.el.innerHTML = this.html = "";
    this.chip()?.removeAttribute("aria-expanded");
  }

  /** Draws it again from the latest data, keeping its scroll; closes when the chip is gone. */
  refresh(): void {
    if (!this.shown) return;
    const chip = this.chip();
    if (!chip) return this.close();
    chip.setAttribute("aria-expanded", "true");
    const err = this.error ? `<p class="up-line up-dim dk-fail">${escapeHtml(this.error)}</p>` : "";
    const html =
      `<div class="up dk" role="dialog" aria-label="${escapeHtml(t("docker.title"))}"><i class="up-nib"></i>` +
      `<header class="up-head"><span class="up-title">${escapeHtml(t("docker.title"))}</span><button type="button" class="dk-btn" data-d="refresh">${escapeHtml(t("docker.refresh"))}</button></header>` +
      `<div class="up-body">${err}${renderDocker(this.overview, this.open, this.busy, new Map())}</div></div>`;
    if (html !== this.html || this.el.hidden) {
      const scroll = this.el.querySelector(".up-body")?.scrollTop ?? 0;
      this.el.innerHTML = this.html = html;
      this.el.hidden = false;
      const fresh = this.el.querySelector(".up-body");
      if (fresh) fresh.scrollTop = scroll;
    }
    this.place(chip);
  }

  private chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>(CHIP);
  }

  private async click(target: HTMLElement): Promise<void> {
    const b = target.closest<HTMLElement>("[data-d]");
    if (b) {
      const { d, host = "", target: what = "", question = "" } = b.dataset;
      if (d === "refresh") return this.fetch();
      if (d === "logs" || d === "projectLogs" || d === "shell") {
        this.close();
        const label = d === "shell" ? t("docker.tileShell", { name: what }) : t("docker.tileLogs", { name: what });
        return this.ctx.open({ host, target: what, kind: d }, label);
      }
      if (d === "rm") return this.remove(host, what, question);
      return;
    }
    const id = target.closest<HTMLElement>("[data-open]")?.dataset.open;
    if (id) {
      this.open = flipOpen(id, this.open);
      saveOpen(this.open);
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
      toast(String(err), { kind: "error" });
    }
    this.busy.delete(key);
    this.fetch();
    this.refresh();
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
      .then((o) => {
        if (gen !== this.gen) return;
        this.overview = o;
        this.error = null;
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

  /** Under the chip, its right edge on the chip's, inside the window; the nib points at the chip. */
  private place(chip: HTMLElement): void {
    const r = chip.getBoundingClientRect();
    const box = this.el.firstElementChild as HTMLElement | null;
    const width = box?.offsetWidth ?? 0;
    const left = Math.max(GAP, Math.min(r.right - width, window.innerWidth - width - GAP));
    const top = r.bottom + GAP;
    this.el.style.left = `${left}px`;
    this.el.style.top = `${top}px`;
    this.el.style.maxHeight = `${window.innerHeight - top - GAP}px`;
    const nib = r.left + r.width / 2;
    box?.style.setProperty("--nib", `${Math.max(12, left + width - nib - 5)}px`);
  }
}
