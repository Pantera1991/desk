// What desk tells you in its window: a card in the top right corner for each
// message (ui.ts toast), and the bell in the bottom bar with the ones you may
// have missed. Kinds: ok confirms what you did, info tells, warn asks for
// attention, error stays until you close it. Everything here is plain data and
// HTML, so it is tested without a window.
import { t } from "./i18n";

export type NoticeKind = "info" | "ok" | "warn" | "error";

export interface NoticeAction {
  label: string;
  run: () => void;
}

export interface NoticeOptions {
  kind?: NoticeKind;
  /** How long the card stays; errors stay until closed whatever this says. */
  ms?: number;
  /** One button on the card and in the history ("Przywróć", "Zainstaluj"). */
  action?: NoticeAction;
}

export interface Notice {
  id: number;
  kind: NoticeKind;
  text: string;
  at: number;
  /** null: stays until closed. */
  ms: number | null;
  action: NoticeAction | null;
  /** Counts on the bell until you close it or open the history. */
  seen: boolean;
}

export interface NoticeState {
  /** Notices in the history. */
  total: number;
  /** Warnings and errors not seen yet. */
  count: number;
  /** One of them is an error. */
  error: boolean;
}

/** How long a card stays, by kind; an error stays until closed. */
export const NOTICE_MS: Record<NoticeKind, number | null> = { ok: 2500, info: 4000, warn: 6000, error: null };

/** How many the history keeps. */
export const KEPT = 50;

export class Notices {
  private list: Notice[] = [];
  private next = 1;
  private listeners = new Set<() => void>();

  /** `opts` as a number: the old `toast(message, ms)`. */
  add(text: string, opts: number | NoticeOptions = {}, at = Date.now()): Notice {
    const o: NoticeOptions = typeof opts === "number" ? { ms: opts } : opts;
    const kind = o.kind ?? "info";
    const n: Notice = {
      id: this.next++,
      kind,
      text,
      at,
      ms: kind === "error" ? null : (o.ms ?? NOTICE_MS[kind]),
      action: o.action ?? null,
      // Your own confirmations and plain news are not something you missed.
      seen: kind === "ok" || kind === "info",
    };
    this.list = [n, ...this.list].slice(0, KEPT);
    this.changed();
    return n;
  }

  /** Newest first. */
  all(): readonly Notice[] {
    return this.list;
  }

  get(id: number): Notice | undefined {
    return this.list.find((n) => n.id === id);
  }

  state(): NoticeState {
    const missed = this.list.filter((n) => !n.seen);
    return { total: this.list.length, count: missed.length, error: missed.some((n) => n.kind === "error") };
  }

  /** Closed by hand: you saw it. */
  seen(id: number): void {
    const n = this.get(id);
    if (!n || n.seen) return;
    n.seen = true;
    this.changed();
  }

  /** The history opened. */
  seenAll(): void {
    for (const n of this.list) n.seen = true;
    this.changed();
  }

  clear(): void {
    this.list = [];
    this.changed();
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private changed(): void {
    for (const fn of this.listeners) fn();
  }
}

/** The one history of this window. */
export const notices = new Notices();

const svg = (paths: string) => `<svg class="notice-icon" viewBox="0 0 12 12" aria-hidden="true">${paths}</svg>`;

const ICON: Record<NoticeKind, string> = {
  info: svg('<circle cx="6" cy="6" r="4.8"/><path d="M6 5.6v2.8M6 3.7v.1"/>'),
  ok: svg('<path d="M2.4 6.3l2.4 2.4 4.8-5"/>'),
  warn: svg('<path d="M6 1.6 10.8 10H1.2Z"/><path d="M6 4.9v2.3M6 8.5v.1"/>'),
  error: svg('<circle cx="6" cy="6" r="4.8"/><path d="M4.3 4.3l3.4 3.4M7.7 4.3 4.3 7.7"/>'),
};

const CLOSE = svg('<path d="M3.5 3.5l5 5M8.5 3.5l-5 5"/>');
const BELL = svg('<path d="M3 8.4V5.6a3 3 0 0 1 6 0v2.8l1 1.1H2z"/><path d="M5 10.6a1 1 0 0 0 2 0"/>');

/** What can be done with a notice: its action, and copying an error. */
function buttons(n: Notice): string {
  const act = n.action ? `<button data-notice-act>${escapeHtml(n.action.label)}</button>` : "";
  const copy = n.kind === "error" ? `<button data-notice-copy>${t("notice.copy")}</button>` : "";
  return act + copy;
}

/** A card in the corner. A timed one shows its time left; hovering it waits. */
export function noticeHtml(n: Notice): string {
  const acts = buttons(n);
  const close = escapeHtml(t("notice.close"));
  return (
    `<div class="notice ${n.kind}" data-notice="${n.id}" role="${n.kind === "error" ? "alert" : "status"}">` +
    `${ICON[n.kind]}<div class="notice-body"><div class="notice-text">${escapeHtml(n.text)}</div>` +
    `${acts ? `<div class="notice-acts">${acts}</div>` : ""}</div>` +
    `<button class="notice-x" data-notice-close aria-label="${close}" title="${close}">${CLOSE}</button>` +
    `${n.ms === null ? "" : `<span class="notice-timer" style="animation-duration:${n.ms}ms"></span>`}</div>`
  );
}

/** The bell's list, newest first. */
export function historyHtml(list: readonly Notice[]): string {
  const rows = list
    .map(
      (n) =>
        `<div class="notice-row ${n.kind}${n.seen ? "" : " new"}" data-notice="${n.id}"><span class="notice-time">${clock(n.at)}</span>` +
        `${ICON[n.kind]}<div class="notice-text">${escapeHtml(n.text)}</div><span class="notice-acts">${buttons(n)}</span></div>`,
    )
    .join("");
  return `<div class="notice-history-head"><b>${t("notice.history")}</b><button data-notice-clear>${t("notice.clear")}</button></div><div class="notice-rows">${rows}</div>`;
}

/** The bell in the bottom bar: nothing before the first notice. */
export function bellHtml(s: NoticeState): string {
  if (!s.total) return "";
  const name = t("notice.history");
  const label = s.count ? `${name}: ${s.count}` : name;
  return (
    `<button class="notice-bell${s.count ? " new" : ""}" data-notices-open aria-haspopup="dialog" aria-label="${escapeHtml(label)}" title="${escapeHtml(name)}">` +
    `${BELL}${s.count ? `<span>${s.count}</span>` : ""}${s.error ? '<i class="notice-dot"></i>' : ""}</button>`
  );
}

/** "21:14". */
export function clock(at: number): string {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Same as tile.ts's (not imported: that pulls the terminal into tests). */
export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
