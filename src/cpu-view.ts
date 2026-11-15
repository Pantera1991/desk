// The temperature chip's panel, as HTML: three rings (temperature, CPU use,
// load), what desk is doing about the heat, the last 10 minutes of CPU use,
// user / system / idle, the load average, and the processes using the most
// CPU, each desk session's with its tile. Each part can be hidden in Options.
// Data: cpu.rs; behaviour: cpu-popover.ts.
import type { Busiest, CpuDetails, CpuSample, SessionRef, ThermalColors, ThermalStatus, TopProcess } from "./api";
import type { CpuPart } from "./cpu-parts";
import { language, t, tn } from "./i18n";
import { agentLabel, keyOf } from "./sessions";
import { RESUME_MARGIN, thermalLevel, thermalTitle } from "./thermal";

/** History slots: 10 minutes at one point every 5 s (cpu.rs HISTORY). */
export const SLOTS = 120;

export interface CpuViewOptions {
  /** null: still loading. */
  details: CpuDetails | null;
  status: ThermalStatus | null;
  colors: ThermalColors | null;
  nowMs: number;
  /** Parts hidden in Options (cpu-parts.ts); ids this desk does not know are ignored. */
  hidden?: readonly string[];
}

/** A session's tile as people know it: "shop · claude #2". */
export function tileLabel(s: SessionRef): string {
  const name = s.path.split(/[\\/]/).filter(Boolean).pop() ?? s.path;
  return `${name} · ${agentLabel(s)}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const pct = (n: number) => `${Math.round(n)}%`;
const clock = (sec: number) =>
  new Date(sec * 1000).toLocaleTimeString(language(), { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const decimals = (n: number, d: number) => n.toLocaleString(language(), { minimumFractionDigits: d, maximumFractionDigits: d });

/** The latest point of history; null before the second reading. */
export function latest(d: CpuDetails | null): CpuSample | null {
  return d?.history.length ? d.history[d.history.length - 1] : null;
}

// ---- rings -----------------------------------------------------------------

const R = 26;
const C = 2 * Math.PI * R;
/** Between two segments of one ring, px along the circle. */
const GAP = 2;

/** One ring: segments (share 0–1 of the circle each, a class for its colour) end to end. */
function ring(parts: { share: number; cls: string }[], value: string, label: string, aria: string): string {
  let at = 0;
  const arcs = parts
    .filter((p) => p.share > 0)
    .map((p, i, all) => {
      const len = Math.max(0, Math.min(1, p.share) * C - (i < all.length - 1 ? GAP : 0));
      const arc = `<circle class="cpu-arc ${p.cls}" cx="32" cy="32" r="${R}" stroke-dasharray="${len.toFixed(2)} ${C.toFixed(2)}" stroke-dashoffset="${(-at).toFixed(2)}" transform="rotate(-90 32 32)"/>`;
      at += Math.min(1, p.share) * C;
      return arc;
    })
    .join("");
  return `<figure class="cpu-gauge"><svg viewBox="0 0 64 64" role="img" aria-label="${esc(aria)}"><circle class="cpu-track" cx="32" cy="32" r="${R}"/>${arcs}<text x="32" y="36" text-anchor="middle">${esc(value)}</text></svg><figcaption>${esc(label)}</figcaption></figure>`;
}

function gauges(o: CpuViewOptions): string {
  const s = o.status;
  const c = s?.celsius ?? null;
  const level = s ? thermalLevel(s, o.colors) || "cool" : "cool";
  const temp = ring(
    c === null ? [] : [{ share: c / 100, cls: level }],
    c === null ? "—" : `${c}°C`,
    t("cpu.temp"),
    c === null ? t("cpu.temp") : `${t("cpu.temp")}: ${c}°C`,
  );
  const now = latest(o.details);
  const use = ring(
    now ? [{ share: now.user / 100, cls: "user" }, { share: now.system / 100, cls: "system" }] : [],
    now ? pct(now.user + now.system) : "—",
    t("cpu.use"),
    now ? t("cpu.useAria", { all: pct(now.user + now.system), user: pct(now.user), system: pct(now.system) }) : t("cpu.use"),
  );
  const d = o.details;
  // Windows keeps no load average: two rings.
  const load =
    d && !d.load
      ? ""
      : ring(
          d?.load ? [{ share: d.load[0] / d.cores, cls: "load" }] : [],
          d?.load ? decimals(d.load[0], 2) : "—",
          t("cpu.load"),
          d?.load ? t("cpu.loadAria", { load: decimals(d.load[0], 2), cores: d.cores }) : t("cpu.load"),
        );
  return `<div class="cpu-gauges">${temp}${use}${load}</div>`;
}

// ---- sections --------------------------------------------------------------

const heading = (text: string) => `<h4 class="cpu-h"><span>${esc(text)}</span></h4>`;
const row = (label: string, value: string, dot = "") =>
  `<div class="cpu-row"><span>${dot ? `<i class="cpu-dot ${dot}"></i>` : ""}${esc(label)}</span><b>${esc(value)}</b></div>`;
const loading = () => `<p class="up-line up-dim">${t("usage.loading")}</p>`;

/** What desk does about the heat now (the chip's title without its click hint), and resume after a stop. */
function state(s: ThermalStatus | null): string {
  if (!s) return "";
  const lines = thermalTitle(s)
    .split("\n")
    .filter((l) => l !== t("thermal.clickHint"));
  // The line above already says from when.
  const resume = s.halted ? `<button class="cpu-resume" data-k="cpu-resume" title="${esc(t("thermal.resumeTitle", { resume: s.emergency - RESUME_MARGIN }))}">${t("thermal.resume")}</button>` : "";
  return `<div class="cpu-state${s.halted ? " halted" : ""}">${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${resume ? `<p>${resume}</p>` : ""}</div>`;
}

/** The last 10 minutes as thin bars, the latest on the right; hovering one says when and how busy. */
export function historyChart(history: CpuSample[]): string {
  const W = 372;
  const H = 64;
  const slot = W / SLOTS;
  const points = history.slice(-SLOTS);
  const first = SLOTS - points.length;
  const bars = points
    .map((p, i) => {
      const x = (first + i) * slot;
      const all = Math.min(100, p.user + p.system);
      const h = all > 0 ? Math.max(1, (H * all) / 100) : 0;
      const label = t("cpu.barAria", { time: clock(p.at), all: pct(all), user: pct(p.user), system: pct(p.system) });
      return `<rect class="cpu-hit" data-bar x="${x.toFixed(1)}" y="0" width="${slot.toFixed(2)}" height="${H}" aria-label="${esc(label)}"/><rect class="cpu-bar" x="${(x + 0.5).toFixed(1)}" y="${(H - h).toFixed(1)}" width="${Math.max(1, slot - 1).toFixed(2)}" height="${h.toFixed(1)}" rx="1"/>`;
    })
    .join("");
  const avg = points.length ? points.reduce((sum, p) => sum + p.user + p.system, 0) / points.length : 0;
  const idle = points.length ? t("cpu.historyIdle", { avg: pct(avg) }) : t("cpu.historyEmpty");
  return `<p class="cpu-tip up-dim" data-k="cpu-tip" data-idle="${esc(idle)}">${esc(idle)}</p>
    <svg class="cpu-chart" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="${esc(t("cpu.history"))}">
      <line class="cpu-grid" x1="0" y1="0.5" x2="${W}" y2="0.5"/><line class="cpu-grid" x1="0" y1="${H / 2}" x2="${W}" y2="${H / 2}"/>${bars}
    </svg>
    <div class="cpu-axis up-dim"><span>${t("cpu.ago")}</span><span>${t("cpu.now")}</span></div>`;
}

function details(d: CpuDetails | null): string {
  const now = latest(d);
  if (!now) return loading();
  return (
    row(t("cpu.user"), pct(now.user), "user") +
    row(t("cpu.system"), pct(now.system), "system") +
    row(t("cpu.idle"), pct(Math.max(0, 100 - now.user - now.system)), "idle")
  );
}

function loadRows(d: CpuDetails): string {
  if (!d.load) return "";
  const [one, five, fifteen] = d.load;
  return (
    heading(t("cpu.loadAverage")) +
    row(t("cpu.minutes1"), decimals(one, 2)) +
    row(t("cpu.minutes5"), decimals(five, 2)) +
    row(t("cpu.minutes15"), decimals(fifteen, 2))
  );
}

function top(list: TopProcess[], most: Busiest | null): string {
  const busiest = most
    ? `<button class="cpu-busiest" data-key="${esc(keyOf(most))}" title="${esc(t("cpu.openTile"))}">${t("cpu.busiest", {
        tile: `<b>${esc(tileLabel(most))}</b>`,
        program: esc(most.program),
        percent: most.percent,
      })}</button>`
    : `<p class="up-line up-dim">${t("cpu.noBusy")}</p>`;
  const rows = list
    .map((p) => {
      const tile = p.session
        ? `<button class="cpu-tile" data-key="${esc(keyOf(p.session))}" title="${esc(t("cpu.openTile"))}">${esc(tileLabel(p.session))}</button>`
        : "";
      return `<div class="cpu-row cpu-proc"><span class="cpu-name" title="${esc(`${p.name} (${p.pid})`)}">${esc(p.name)}</span>${tile}<b>${pct(p.percent)}</b></div>`;
    })
    .join("");
  return `${busiest}<div class="cpu-row cpu-proc head up-dim"><span>${t("cpu.process")}</span><span>${t("cpu.cpu")}</span></div>${rows}`;
}

export function renderCpu(o: CpuViewOptions): string {
  const d = o.details;
  const head = `<header class="up-head"><span class="up-title">${t("cpu.title")}</span><span class="up-dim">${
    d ? tn("cpu.cores", d.cores) : ""
  }</span></header>`;
  const hidden = new Set(o.hidden ?? []);
  const shows = (part: CpuPart) => !hidden.has(part);
  const parts =
    (shows("gauges") ? gauges(o) : "") +
    // After an emergency stop the resume button stays, hidden or not.
    (shows("state") || o.status?.halted ? state(o.status) : "") +
    (shows("history") ? heading(t("cpu.history")) + (d ? historyChart(d.history) : loading()) : "") +
    (shows("details") ? heading(t("cpu.details")) + details(d) : "") +
    (shows("load") && d ? loadRows(d) : "") +
    // top null: read without the processes, before they were shown.
    (shows("top") ? heading(t("cpu.top")) + (d?.top ? top(d.top, d.busiest) : loading()) : "");
  const body = parts || `<p class="up-line up-dim">${t("cpu.allHidden")}</p>`;
  const foot = `<footer class="up-foot"><span>${t("cpu.footer")}</span><button class="cpu-options" data-k="cpu-options">${t("cpu.options")}</button></footer>`;
  return `<div class="up cpu" role="dialog" aria-label="${t("cpu.title")}"><i class="up-nib"></i>${head}<div class="up-body">${body}</div>${foot}</div>`;
}
