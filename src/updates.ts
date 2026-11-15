// When desk asks GitHub for a newer desk, and what Options say about it.
// Plain data and HTML, tested without a window; app.ts does the asking.
import type { Update } from "./api";
import { t } from "./i18n";
import { clock, escapeHtml } from "./notices";

/** desk asks GitHub for a newer release this often (Options can ask at once). */
export const UPDATE_EVERY_MS = 30 * 60 * 1000;

/** What this window knows about updates. */
export interface UpdateStatus {
  /** A newer release than this desk; null: none found, or not asked yet. */
  update: Update | null;
  /** When GitHub last answered; null: not yet. */
  checkedAt: number | null;
  /** Why the last check failed (no gh, offline); null: it did not. */
  error: string | null;
  /** A check is under way. */
  checking: boolean;
}

/** Time to ask again: never asked, the last try is UPDATE_EVERY_MS old (a
 *  laptop that slept catches up on its next look), or the clock went back. */
export function updateDue(lastTry: number | null, now: number): boolean {
  return lastTry === null || now - lastTry >= UPDATE_EVERY_MS || now < lastTry;
}

/** The notice about `update` is due: this version was not announced yet,
 *  remembered across restarts (the top bar and Options keep showing it). */
export function announce(update: Update | null, announced: string | null): boolean {
  return update !== null && update.version !== announced;
}

/** What a check came to: a version to announce, one announced before, this
 *  desk is the latest, or the check failed (the status says the same). */
export type UpdateOutcome =
  | { kind: "news"; update: Update }
  | { kind: "known"; update: Update }
  | { kind: "latest" }
  | { kind: "failed"; error: string };

/** What the checker needs from the window. */
export interface UpdateHost {
  /** Ask GitHub (update.rs, through gh): a newer release, or null. */
  ask: () => Promise<Update | null>;
  now: () => number;
  /** The version announced last, kept across restarts (localStorage). */
  load: () => string | null;
  save: (version: string) => void;
  /** The status changed: the top bar and Options follow. */
  changed: (s: UpdateStatus) => void;
}

/** Asks GitHub for a newer desk when due (`tick` each minute) or at once
 *  (`check`, Options), one question at a time, and keeps the status. */
export class UpdateChecker {
  readonly status: UpdateStatus = { update: null, checkedAt: null, error: null, checking: false };
  private triedAt: number | null = null;
  private asking: Promise<Update | null> | null = null;
  private announced: string | null;

  constructor(private host: UpdateHost) {
    this.announced = host.load();
  }

  /** The look at the clock: asks when due (updateDue); null when it did not. */
  tick(): Promise<UpdateOutcome | null> {
    if (this.asking || !updateDue(this.triedAt, this.host.now())) return Promise.resolve(null);
    return this.check();
  }

  /** Ask now. A check under way is waited for, not asked again. */
  async check(): Promise<UpdateOutcome> {
    this.triedAt = this.host.now();
    this.set({ checking: true });
    const asking = (this.asking ??= this.host.ask().finally(() => (this.asking = null)));
    let update: Update | null;
    try {
      update = await asking;
    } catch (err) {
      const error = String(err);
      this.set({ checking: false, error });
      return { kind: "failed", error };
    }
    this.set({ update, checkedAt: this.host.now(), error: null, checking: false });
    if (!update) return { kind: "latest" };
    if (!announce(update, this.announced)) return { kind: "known", update };
    this.announced = update.version;
    this.host.save(update.version);
    return { kind: "news", update };
  }

  private set(change: Partial<UpdateStatus>): void {
    Object.assign(this.status, change);
    this.host.changed(this.status);
  }
}

/** The line under Options → Updates. A found version stays while desk checks
 *  again or a later check fails: it is still there to install. */
export function updateStatusHtml(s: UpdateStatus): string {
  if (s.update) {
    const label = t(s.update.installable ? "update.install" : "update.openPage");
    return (
      `<span class="update-ready">${t("settings.updateReady", { version: escapeHtml(s.update.version) })}</span> ` +
      `<button data-k="update-install">${label}</button>`
    );
  }
  if (s.checking) return `<span class="dim">${t("settings.checking")}</span>`;
  if (s.error) return `<span class="error">${t("settings.updateFailed", { err: escapeHtml(s.error) })}</span>`;
  if (s.checkedAt !== null) return `<span class="dim">${t("settings.updateLatest", { time: clock(s.checkedAt) })}</span>`;
  return `<span class="dim">${t("settings.updateNotYet")}</span>`;
}
