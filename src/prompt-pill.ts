// The prompt pill (BETA) on a Claude tile, after the CRM's spelling bubble.
// Above Claude Code's prompt box it offers the Ctrl+G rewrite (prompt_ai.rs)
// once something is typed, then says how the rewrite goes (the wrapper's
// phases, prompt_status.rs) and lets you take it back. One bubble in every
// state: the star, the label and BETA stay put, only the label and the action
// at the end change.
import type { IBuffer, IBufferCell, IBufferLine } from "@xterm/xterm";
import { t } from "./i18n";
import { PLATFORM } from "./platform";

export type PromptPhase = "checking" | "vpn" | "applied" | "clean" | "restored" | "error";

/** The `prompt-ai` event: how the rewrite in session `slug` goes. */
export interface PromptAiStatus {
  slug: string;
  phase: PromptPhase;
  message: string | null;
  /** Unix milliseconds. */
  ts: number;
}

let enabled = false;

/** Options → Poprawianie promptu is on: Ctrl+G rewrites, the pill offers it. */
export function setPromptAiOn(on: boolean): void {
  enabled = on;
}

export function promptAiOn(): boolean {
  return enabled;
}

/** Claude Code's prompt box on screen: the rules above and below it, rows from the top. */
export interface PromptBox {
  top: number;
  bottom: number;
}

/** A horizontal rule, as Claude frames its prompt with (corners allowed). */
function isRule(row: string): boolean {
  const marks = row.replace(/[\s╭╮╰╯]/g, "");
  return marks.length >= 10 && /^[─━]+$/.test(marks);
}

const PROMPT_MARK = /^[\s│]*[❯>]/;

/** The prompt box: between the last two rules on screen, its first row starting with ❯. */
export function findPromptBox(rows: readonly string[]): PromptBox | null {
  let bottom = rows.length - 1;
  while (bottom >= 0 && !isRule(rows[bottom])) bottom--;
  let top = bottom - 1;
  while (top >= 0 && !isRule(rows[top])) top--;
  if (top < 0 || bottom - top < 2 || !PROMPT_MARK.test(rows[top + 1])) return null;
  return { top, bottom };
}

/** What is typed in the box's rows: without the ❯ and the frame. */
export function draftText(rows: readonly string[]): string {
  return rows
    .map((r, i) => (i === 0 ? r.replace(PROMPT_MARK, "") : r).replace(/^[\s│]+|[\s│]+$/g, ""))
    .filter(Boolean)
    .join("\n");
}

/** Where the pill goes: on the top rule (its bottom edge there), or centered on a row of the box. */
export interface PillSpot {
  row: number;
  col: number;
  centered: boolean;
}

/**
 * Where the pill covers nothing. First choice, as the CRM: on the top rule at
 * the prompt's text, over the row above the box. Claude puts notices on that
 * row ("You've used 93% of your weekly limit"), so when the stretch is taken
 * the pill goes into the box, at the right end of its last row; then to the
 * right end of the rule; when all three are taken, back to the first choice.
 * `width` is the pill's, in columns.
 */
export function pillSpot(rows: readonly string[], box: PromptBox, width: number): PillSpot {
  const free = (row: number, from: number) => row >= 0 && (rows[row] ?? "").slice(from, from + width).trim() === "";
  const left = 2;
  const right = Math.max(left, rows[box.top].trimEnd().length - width - 1);
  const above = box.top - 1;
  const last = box.bottom - 1;
  if (free(above, left)) return { row: box.top, col: left, centered: false };
  if (free(last, right)) return { row: last, col: right, centered: true };
  if (free(above, right)) return { row: box.top, col: right, centered: false };
  return { row: box.top, col: left, centered: false };
}

/**
 * A row's text without its faded cells: Claude's placeholder ("Try …") and
 * the prompt faded during a rewrite are not something you typed.
 */
function liveText(line: IBufferLine | undefined, cell: IBufferCell): string {
  if (!line) return "";
  let out = "";
  for (let x = 0; x < line.length; x++) {
    const c = line.getCell(x, cell);
    if (!c || c.getWidth() === 0) continue;
    out += c.isDim() ? " " : c.getChars() || " ";
  }
  return out;
}

/** The terminal's visible rows, Claude's prompt box among them and what you typed in it. */
export function readPrompt(buf: IBuffer, height: number): { rows: string[]; box: PromptBox | null; draft: string } {
  const rows: string[] = [];
  for (let y = 0; y < height; y++) rows.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? "");
  const box = findPromptBox(rows);
  if (!box) return { rows, box, draft: "" };
  const cell = buf.getNullCell();
  const lines: string[] = [];
  for (let y = box.top + 1; y < box.bottom; y++) lines.push(liveText(buf.getLine(buf.viewportY + y), cell));
  return { rows, box, draft: draftText(lines) };
}

/** Worth offering a rewrite: three letters at least, as the CRM's bubble. */
export function hasDraft(text: string): boolean {
  return (text.match(/\p{L}/gu) ?? []).length >= 3;
}

/** How long each phase stays up without news, ms (a wrapper that died says nothing more). */
export const LIFETIME: Record<PromptPhase, number> = {
  checking: 60_000,
  vpn: 60_000,
  applied: 15_000,
  clean: 2_500,
  restored: 2_500,
  error: 8_000,
};

/** How long the tile waits for the wrapper's first news, and for Claude to finish drawing itself again, ms. */
export const HOLD = { firstNews: 1_500, quiet: 200, finish: 1_500 };

/**
 * Keeps the tile's last frame while a rewrite runs. Claude Code clears its
 * screen before it hands the prompt to `$VISUAL` and draws it again after,
 * so the tile would go blank for the seconds the model takes. From Ctrl+G the
 * session's output is held and written all at once when the rewrite is over:
 * the final news came and Claude's redraw has gone quiet (HOLD.quiet), or
 * HOLD.finish passed (a working Claude never goes quiet). Without news in
 * HOLD.firstNews, Ctrl+G started nothing (an empty prompt) and it lets go.
 */
export class ScreenHold {
  private chunks: Uint8Array[] | null = null;
  private news = false;
  private finishing = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private deadline: ReturnType<typeof setTimeout> | undefined;

  /** `changed` hears when holding starts and stops, and whether the wrapper said anything. */
  constructor(
    private write: (data: Uint8Array) => void,
    private changed: (held: boolean, news: boolean) => void,
  ) {}

  get held(): boolean {
    return this.chunks !== null;
  }

  start(): void {
    if (this.chunks) return;
    this.chunks = [];
    this.news = false;
    this.finishing = false;
    this.arm(HOLD.firstNews);
    this.changed(true, false);
  }

  /** The session's output: held, or written as it comes. */
  data(chunk: Uint8Array): void {
    if (!this.chunks) return this.write(chunk);
    this.chunks.push(chunk);
    if (this.finishing) this.arm(HOLD.quiet);
  }

  status(phase: PromptPhase): void {
    if (!this.chunks) return;
    this.news = true;
    if (phase === "checking" || phase === "vpn") return this.arm(LIFETIME[phase]);
    if (this.finishing) return;
    this.finishing = true;
    this.arm(HOLD.quiet);
    this.deadline = setTimeout(() => this.release(), HOLD.finish);
  }

  /** Writes what was held, in order. */
  release(): void {
    const chunks = this.stop();
    if (!chunks) return;
    for (const c of chunks) this.write(c);
    this.changed(false, this.news);
  }

  /** Stops without writing (the terminal is going away). */
  cancel(): void {
    this.stop();
  }

  private stop(): Uint8Array[] | null {
    clearTimeout(this.timer);
    clearTimeout(this.deadline);
    const chunks = this.chunks;
    this.chunks = null;
    this.finishing = false;
    return chunks;
  }

  private arm(ms: number): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.release(), ms);
  }
}

export type PillView =
  | { kind: "offer" }
  | { kind: "busy"; label: string }
  | { kind: "applied" }
  | { kind: "clean" }
  | { kind: "restored" }
  | { kind: "error"; reason: string };

/** What the pill shows: the rewrite's phase first, else the offer, else nothing. */
export function pillView(phase: PromptPhase | null, message: string | null, offer: boolean): PillView | null {
  switch (phase) {
    case "checking":
      return { kind: "busy", label: t("promptPill.checking") };
    case "vpn":
      return { kind: "busy", label: t("promptPill.vpn") };
    case "applied":
      return { kind: "applied" };
    case "clean":
      return { kind: "clean" };
    case "restored":
      return { kind: "restored" };
    case "error":
      return { kind: "error", reason: message ?? "" };
    default:
      return offer ? { kind: "offer" } : null;
  }
}

/** The key that starts a rewrite: ⌘G on macOS (the tile sends Ctrl+G), Ctrl+G elsewhere. */
export function rewriteKey(platform = PLATFORM): string {
  return platform === "mac" ? "⌘G" : "Ctrl+G";
}

const STAR = `<span class="star" aria-hidden="true"><svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor"><path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/></svg></span>`;
const CLOSE = `<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18M6 6l12 12"/></svg>`;

/** The reason without curl's details in brackets: those stay in the tooltip. */
export function shortReason(reason: string): string {
  const i = reason.indexOf(" (");
  return i > 0 ? reason.slice(0, i) : reason;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function pillHtml(view: PillView): string {
  const beta = `<span class="beta" title="${esc(t("promptPill.betaHint"))}">${esc(t("promptPill.beta"))}</span>`;
  const dismiss = `<button class="x" data-pill="dismiss" title="${esc(t("promptPill.dismiss"))}" aria-label="${esc(t("promptPill.dismiss"))}">${CLOSE}</button>`;
  switch (view.kind) {
    case "offer":
      return `<button class="go" data-pill="rewrite" title="${esc(t("promptPill.offerHint"))}">${STAR}<span class="label">${esc(t("promptPill.offer"))}</span>${beta}<kbd>${esc(rewriteKey())}</kbd></button>`;
    case "busy":
      return `${STAR}<span class="label" role="status">${esc(view.label)}</span>${beta}`;
    case "applied":
      return `${STAR}<span class="label ok" role="status">${esc(t("promptPill.applied"))}</span>${beta}<button class="act" data-pill="undo" title="${esc(t("promptPill.undoHint"))}">${esc(t("promptPill.undo"))}</button>${dismiss}`;
    case "clean":
      return `${STAR}<span class="label ok" role="status">${esc(t("promptPill.clean"))}</span>${beta}`;
    case "restored":
      return `${STAR}<span class="label" role="status">${esc(t("promptPill.restored"))}</span>${beta}`;
    case "error": {
      const full = t("promptPill.failed", { reason: view.reason });
      const text = t("promptPill.failed", { reason: shortReason(view.reason) });
      return `${STAR}<span class="label bad" role="alert" title="${esc(full)}">${esc(text)}</span>${beta}${dismiss}`;
    }
  }
}

/** The pill's element and its state; the tile places it and feeds it what it sees. */
export class PromptPill {
  readonly el: HTMLElement = document.createElement("div");
  private phase: PromptPhase | null = null;
  private message: string | null = null;
  private lastTs = 0;
  private offer = false;
  private timer = 0;
  private shown = "";
  /** Placed over a prompt box at least once (else it waits at the bottom). */
  placed = false;

  constructor(private act: { rewrite: () => void; undo: () => void }) {
    this.el.className = "prompt-pill";
    this.el.hidden = true;
    // A click here is for the pill: no terminal selection, the terminal keeps focus.
    this.el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    this.el.addEventListener("click", (e) => {
      e.stopPropagation();
      const a = (e.target as HTMLElement).closest<HTMLElement>("[data-pill]")?.dataset.pill;
      if (a === "rewrite") this.act.rewrite();
      else if (a === "undo") this.act.undo();
      else if (a === "dismiss") this.clear();
    });
  }

  /** A rewrite's phase is up (the tile looks for the box even when not active). */
  get busy(): boolean {
    return this.phase !== null;
  }

  status(s: Pick<PromptAiStatus, "phase" | "message" | "ts">): void {
    if (s.ts && s.ts === this.lastTs) return; // the watcher saw the same write twice
    this.lastTs = s.ts;
    this.phase = s.phase;
    this.message = s.message;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.clear(), LIFETIME[s.phase]);
    this.render();
  }

  /** You typed in the tile: news of a finished rewrite is old now. */
  typed(): void {
    if (this.phase && this.phase !== "checking" && this.phase !== "vpn") this.clear();
  }

  setOffer(on: boolean): void {
    if (on === this.offer) return;
    this.offer = on;
    this.render();
  }

  /** Its bottom edge at `y`, from `x`, in the terminal's pixels. */
  place(x: number, y: number): void {
    this.el.style.left = `${Math.round(x)}px`;
    this.el.style.top = `${Math.round(y)}px`;
  }

  clear(): void {
    window.clearTimeout(this.timer);
    this.phase = null;
    this.message = null;
    this.render();
  }

  dispose(): void {
    window.clearTimeout(this.timer);
    this.el.remove();
  }

  private render(): void {
    const view = pillView(this.phase, this.message, this.offer);
    const html = view ? pillHtml(view) : "";
    // Not rebuilt under the cursor when nothing changed.
    if (html === this.shown) return;
    this.shown = html;
    this.el.innerHTML = html;
    this.el.className = view ? `prompt-pill ${view.kind}` : "prompt-pill";
    this.el.hidden = !view;
  }
}
