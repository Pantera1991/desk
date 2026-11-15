// The temperature chip's panel: slides down under the chip like the usage
// popover, asks for fresh numbers every 2 s while open, keeps its scroll
// across refreshes, closes on Esc, a click elsewhere, the window losing focus
// or the chip going away. Content: cpu-view.ts.
import type { CpuDetails, ThermalColors, ThermalStatus } from "./api";
import { showsProcesses } from "./cpu-parts";
import { renderCpu } from "./cpu-view";

export interface CpuPopoverContext {
  status(): ThermalStatus | null;
  colors(): ThermalColors | null;
  /** Parts hidden in Options (layout cpuHidden). */
  hidden(): readonly string[];
  /** Without `processes` none are read (the panel hides them). */
  details(processes: boolean): Promise<CpuDetails>;
  /** Open (or bring up) a session's tile. */
  focus(key: string): void;
  /** Options → Heat and coffee, where the temperature settings are. */
  options(): void;
  /** The resume button after an emergency stop. */
  resume(): void;
}

const CHIP = '[data-top="thermal"]';
/** Fresh numbers this often while open. */
const EVERY_MS = 2000;
const GAP = 8;

/** A click or the focus landing on `target` leaves the panel: anywhere but the panel and the chip (which toggles it). */
export function leftBy(target: { closest(selector: string): unknown } | null, inPanel: boolean): boolean {
  return target !== null && !inPanel && !target.closest(CHIP);
}

export class CpuPopover {
  private shown = false;
  private details: CpuDetails | null = null;
  private pending = false;
  private timer: ReturnType<typeof setInterval> | undefined;
  private el: HTMLElement;
  /** What it shows now. */
  private html = "";

  constructor(
    host: HTMLElement,
    private ctx: CpuPopoverContext,
  ) {
    this.el = document.createElement("div");
    this.el.className = "up-host";
    this.el.hidden = true;
    host.append(this.el);
    this.el.addEventListener("click", (e) => {
      const target = e.target as HTMLElement;
      const key = target.closest<HTMLElement>("[data-key]")?.dataset.key;
      if (key) {
        this.close();
        return this.ctx.focus(key);
      }
      const k = target.closest<HTMLElement>("[data-k]")?.dataset.k;
      if (k === "cpu-options") {
        this.close();
        this.ctx.options();
      }
      if (k === "cpu-resume") this.ctx.resume();
    });
    // The line over the chart says what the bar under the cursor holds.
    const tip = (e: Event) => this.showTip(e.target instanceof Element ? e.target.closest("[data-bar]") : null);
    this.el.addEventListener("mouseover", tip);
    this.el.addEventListener("mouseleave", () => this.showTip(null));
    const leave = (e: Event) => {
      const target = e.target instanceof Element ? e.target : null;
      if (this.shown && leftBy(target, target !== null && this.el.contains(target))) this.close();
    };
    document.addEventListener("mousedown", leave, true);
    document.addEventListener("focusin", leave, true);
    window.addEventListener(
      "keydown",
      (e) => {
        if (this.shown && e.key === "Escape") {
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
    this.details = null;
    this.fetch();
    this.timer = setInterval(() => this.fetch(), EVERY_MS);
    this.refresh();
  }

  close(): void {
    if (!this.shown) return;
    this.shown = false;
    clearInterval(this.timer);
    this.el.hidden = true;
    this.el.innerHTML = this.html = "";
    this.chip()?.removeAttribute("aria-expanded");
  }

  /** Draws it again from the latest numbers, keeping its scroll; closes when the chip is gone. */
  refresh(): void {
    if (!this.shown) return;
    const chip = this.chip();
    if (!chip) return this.close();
    chip.setAttribute("aria-expanded", "true");
    const html = renderCpu({
      details: this.details,
      status: this.ctx.status(),
      colors: this.ctx.colors(),
      nowMs: Date.now(),
      hidden: this.ctx.hidden(),
    });
    // Rebuilt only when something shows differently (a click between
    // mousedown and mouseup would otherwise be lost).
    if (html !== this.html || this.el.hidden) {
      const body = this.el.querySelector(".up-body");
      const scroll = body?.scrollTop ?? 0;
      const hovered = this.el.querySelector<HTMLElement>('[data-k="cpu-tip"]')?.textContent ?? null;
      this.el.innerHTML = this.html = html;
      this.el.hidden = false;
      const fresh = this.el.querySelector(".up-body");
      if (fresh) fresh.scrollTop = scroll;
      // Keep what the line over the chart said while the cursor stays on a bar.
      const line = this.el.querySelector<HTMLElement>('[data-k="cpu-tip"]');
      if (line && hovered !== null && this.el.matches(":hover")) line.textContent = hovered;
    }
    this.place(chip);
  }

  private chip(): HTMLElement | null {
    return document.querySelector<HTMLElement>(CHIP);
  }

  /** One request at a time. */
  private fetch(): void {
    if (this.pending) return;
    this.pending = true;
    this.ctx
      .details(showsProcesses(this.ctx.hidden()))
      .then((d) => {
        if (this.shown) this.details = d;
      })
      // Shown as still loading; asked again in 2 s.
      .catch(() => {})
      .finally(() => {
        this.pending = false;
        this.refresh();
      });
  }

  private showTip(bar: Element | null): void {
    const line = this.el.querySelector<HTMLElement>('[data-k="cpu-tip"]');
    if (line) line.textContent = bar?.getAttribute("aria-label") ?? line.dataset.idle ?? "";
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
