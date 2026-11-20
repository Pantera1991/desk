// Find in Files: pure helpers of the panel (rows, header, selection, options).
import type { GrepHit, GrepOptions, GrepResult } from "./api";
import { tn, t } from "./i18n";
import { escapeHtml } from "./notices";

/** The text escaped, each range ([start, end) in UTF-16 units) in <mark>. Ranges out of bounds or overlapping are clamped. */
export function markHtml(text: string, marks: [number, number][]): string {
  let out = "";
  let pos = 0;
  for (const [a, b] of [...marks].sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    const start = Math.max(a, pos);
    const end = Math.min(b, text.length);
    if (end <= start) continue;
    out += escapeHtml(text.slice(pos, start)) + `<mark>${escapeHtml(text.slice(start, end))}</mark>`;
    pos = end;
  }
  return out + escapeHtml(text.slice(pos));
}

/** One result row: the line with its matches marked, then "name line" (the full path in the title). */
export function rowHtml(h: GrepHit, selected: boolean, index: number): string {
  const name = h.file.slice(h.file.lastIndexOf("/") + 1);
  return (
    `<div class="ff-row${selected ? " sel" : ""}" data-i="${index}">` +
    `<span class="ff-line">${markHtml(h.text, h.marks)}</span>` +
    `<span class="ff-where" title="${escapeHtml(h.file)}">${escapeHtml(name)} ${h.line}</span></div>`
  );
}

/**
 * "N trafień w M plikach" (+ the cap note); the error as it is; "" before any search.
 * The error string is raw and may span several lines: the caller must set it
 * with textContent (never innerHTML) and style it with CSS `white-space: pre-wrap`.
 */
export function headerText(r: GrepResult | null, error: string | null): string {
  if (error) return error;
  if (!r) return "";
  const head = `${tn("find.count", r.hits.length)} ${tn("find.inFiles", r.files)}`;
  return r.more ? `${head} ${t("find.more", { n: r.hits.length })}` : head;
}

/** The hit's marks as UTF-16 offsets in its whole line (for the preview), not in the cut `text`. */
export function lineMarks(h: GrepHit): [number, number][] {
  const lead = h.cut ? 1 : 0; // the "…" in front of a cut line
  return h.marks.map(([a, b]) => [a - lead + h.cut, b - lead + h.cut]);
}

/** What a selection puts in the Find input: trimmed, one line of at most 200 characters, else nothing. */
export function seedText(s: string | undefined): string | undefined {
  const text = s?.trim();
  return text && text.length <= 200 && !/[\r\n]/.test(text) ? text : undefined;
}

/** Which editor opens a result: the panel's own for an empty command, else the program. */
export function editorChoice(fileEditor: string): "builtin" | "program" {
  return fileEditor === "" ? "builtin" : "program";
}

/** The selected row after moving by `delta`, kept within the list; -1 when it is empty. */
export function moveSelection(i: number, delta: number, count: number): number {
  if (count <= 0) return -1;
  return Math.min(count - 1, Math.max(0, i + delta));
}

/** Hands out numbers to searches; only the newest one's answer is still wanted. */
export class Latest {
  private n = 0;
  next(): number {
    return ++this.n;
  }
  isLatest(n: number): boolean {
    return n === this.n;
  }
}

const OPTIONS_KEY = "desk.findOptions";

export function loadOptions(): GrepOptions {
  const o: GrepOptions = { case: false, word: false, regex: false };
  try {
    const p = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? "null");
    if (p && typeof p === "object") {
      o.case = p.case === true;
      o.word = p.word === true;
      o.regex = p.regex === true;
    }
  } catch {
    /* no storage or bad JSON: defaults */
  }
  return o;
}

export function saveOptions(o: GrepOptions): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(o));
  } catch {
    /* no storage: the options last until the panel closes */
  }
}
