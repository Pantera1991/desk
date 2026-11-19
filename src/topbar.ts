// The top bar's name, and the tools at its end: the browser panel and coffee.
// The tools wear the frame of the usage and temperature chips, with line icons
// drawn in the text's color, so they follow the theme and the hover like the
// rest of the bar.
import type { CoffeeStatus } from "./api";
import { t } from "./i18n";
import type { Platform } from "./platform";

const GLOBE =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><circle cx="6" cy="6" r="4.8"/><path d="M1.2 6h9.6"/><path d="M6 1.2c-1.6 1.4-2.3 3-2.3 4.8s.7 3.4 2.3 4.8c1.6-1.4 2.3-3 2.3-4.8S7.6 2.6 6 1.2z"/></svg>';

const CUP =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M1.8 5.2h6.6v2.4a2.6 2.6 0 0 1-2.6 2.6H4.4a2.6 2.6 0 0 1-2.6-2.6z"/><path d="M8.4 5.9h.6a1.35 1.35 0 0 1 0 2.7h-.75"/><path d="M4.1 1.6c-.45.5.45 1 0 1.6M6.3 1.6c-.45.5.45 1 0 1.6"/></svg>';

const WHALE =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M.9 6.4h9.6c.4-.9 1-1.2 1.6-1.2-.2-.6-.9-.9-1.5-.7-.1-.6-.5-1-1-1.2-.2.5-.1.9.1 1.2"/><path d="M1.2 6.4c.2 2.2 1.8 3.6 4.4 3.6 2.6 0 4.1-1.3 4.9-3.6"/><path d="M2.6 4.7h1.5v1.7H2.6zM4.4 4.7h1.5v1.7H4.4zM6.2 4.7h1.5v1.7H6.2zM4.4 3h1.5v1.7H4.4z"/></svg>';

/** A server with an arrow going up: the rsync upload panel. */
export const RSYNC =
  '<svg viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="7.2" width="9" height="3.3" rx=".6"/><path d="M3.3 8.85h.6"/><path d="M6 1.3v4.4"/><path d="M4 3.3 6 1.3l2 2"/></svg>';

/** "desk" and, once the app said it, its version in small print. `drag` is
 *  the attribute that drags the window by them (none while docked). */
export function brandHtml(version: string | null, drag: string): string {
  const v = version ? `<span class="brand-version"${drag}>${escapeHtml(version)}</span>` : "";
  return `<span class="brand"${drag}>desk</span>${v}`;
}

/** 🌐 in the side panel: `keys` is the shortcut that opens it. */
export function browserHtml(keys: string): string {
  const title = escapeHtml(t("top.browserTitle", { keys }));
  return `<button class="top-btn icon" data-top="browser" title="${title}" aria-label="${escapeHtml(t("top.browser"))}">${GLOBE}</button>`;
}

/** The whale that opens the Docker panel; nothing while no server is set up. */
export function dockerHtml(show: boolean, pressed = false): string {
  if (!show) return "";
  return `<button class="top-btn icon" data-top="docker" aria-pressed="${pressed}" title="${escapeHtml(t("top.dockerTitle"))}" aria-label="${escapeHtml(t("top.docker"))}">${WHALE}</button>`;
}

/** The server icon that opens the rsync panel; nothing while no server is set up. */
export function uploadHtml(show: boolean, pressed = false): string {
  if (!show) return "";
  return `<button class="top-btn icon" data-top="upload" aria-pressed="${pressed}" title="${escapeHtml(t("top.uploadTitle"))}" aria-label="${escapeHtml(t("top.upload"))}">${RSYNC}</button>`;
}

/** Off: the cup alone. On: the cup and what it keeps awake. Sleep left disabled: a red chip before it. */
export function coffeeHtml(c: CoffeeStatus, platform: Platform): string {
  const title = {
    off: t("coffee.offTitle"),
    awake: platform === "mac" && !c.helperInstalled ? t("coffee.awakeTitleAsk") : t("coffee.awakeTitle"),
    lid: t("coffee.lidTitle"),
  }[c.level];
  const stray =
    c.sleepDisabled && c.level !== "lid"
      ? `<button class="top-btn coffee warn" data-coffee="restore" title="${escapeHtml(t("coffee.strayTitle"))}">${t("coffee.stray")}</button>`
      : "";
  const cycle = `data-coffee="cycle" title="${escapeHtml(title)}"`;
  if (c.level === "off") {
    return `${stray}<button class="top-btn coffee off icon" ${cycle} aria-label="${escapeHtml(t("coffee.name"))}">${CUP}</button>`;
  }
  const label = c.level === "awake" ? t("coffee.awake") : t("coffee.lid");
  return `${stray}<button class="top-btn coffee ${c.level} with-icon" ${cycle}>${CUP}${label}</button>`;
}

/** Same as tile.ts's (not imported: that pulls the terminal into tests). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
