// CPU temperature in the top bar ("72°", "84° ↓" while desk slows its
// sessions, "78° ≋ 70%" while the fans run at a step desk set, "97° ⏸" and a
// resume button after an emergency stop). The readings, the slowing, the fans
// and the stop are Rust's (src-tauri/src/thermal.rs, fans.rs); clicking the
// chip opens the busiest session (busiest.rs).
import type { FanInfo, FanStep, StopSees, ThermalColors, ThermalMode, ThermalStatus } from "./api";
import { t, tn, type MessageKey } from "./i18n";
import type { NoticeKind } from "./notices";

export const DEFAULT_LIMIT = 75;
export const MIN_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Full speed back this far below the limit (thermal.rs COOL_MARGIN). */
export const COOL_MARGIN = 7;
/** A fan step comes down this far below its limit (thermal.rs StepDown), °C. */
export const DEFAULT_FAN_MARGIN = 7;
/** 0: a step comes down as soon as the average is below its own limit. */
export const MIN_FAN_MARGIN = 0;
export const MAX_FAN_MARGIN = 15;
/** How long a fan step waits before coming down: the choices in Options, s. */
export const FAN_WAITS = [15, 30, 60, 120, 300];
export const DEFAULT_FAN_WAIT = 60;

/** A typed margin, whole and within what Options offers. */
export function clampFanMargin(c: number): number {
  if (!Number.isFinite(c)) return DEFAULT_FAN_MARGIN;
  return Math.min(MAX_FAN_MARGIN, Math.max(MIN_FAN_MARGIN, Math.round(c)));
}
/** The chip turns yellow this close to the limit (unless Options chose its colours). */
const WARM_MARGIN = 10;
/** The colours Options accepts, °C. */
export const MIN_COLOR = 30;
export const MAX_COLOR = 110;
/** The emergency stop's limit (thermal.rs DEFAULT_EMERGENCY...), °C. */
export const DEFAULT_EMERGENCY = 90;
export const MIN_EMERGENCY = 60;
export const MAX_EMERGENCY = 110;
/** Resuming waits until the CPU is this far below it (thermal.rs RESUME_MARGIN). */
export const RESUME_MARGIN = 5;

/** An emergency limit typed in Options: whole degrees within MIN..MAX. */
export function clampEmergency(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_EMERGENCY;
  return Math.min(MAX_EMERGENCY, Math.max(MIN_EMERGENCY, Math.round(n)));
}

/** The colours desk picks itself: red from the lowest limit it acts at (slowing, the
 * first fan step; 75°C with neither), yellow 10°C before. 0 in `limits`: not in use. */
export function autoColors(limits: number[]): ThermalColors {
  const active = limits.filter((n) => n > 0);
  const hot = active.length ? Math.min(...active) : DEFAULT_LIMIT;
  return { warm: hot - WARM_MARGIN, hot };
}

/** Colours typed in Options: whole degrees within MIN..MAX_COLOR, and yellow never above
 * red: the one just typed (`keep`) stays, the other moves to it. */
export function clampColors(c: ThermalColors, keep: keyof ThermalColors): ThermalColors {
  const one = (n: number) => Math.min(MAX_COLOR, Math.max(MIN_COLOR, Math.round(n)));
  const warm = one(c.warm);
  const hot = one(c.hot);
  if (warm <= hot) return { warm, hot };
  return keep === "warm" ? { warm, hot: warm } : { warm: hot, hot };
}
/** One step, full speed from 70°C: what the fans did before steps (thermal.rs default_steps). */
export const DEFAULT_STEPS: FanStep[] = [{ celsius: 70, percent: 100 }];
/** The speeds a step can have, % of the maximum (fan_control.rs LEVELS). */
export const FAN_LEVELS = [40, 50, 60, 70, 80, 90, 100];
export const MAX_STEPS = 4;

/** Ready-made tables in Options. */
export const FAN_PRESETS: { key: MessageKey; steps: FanStep[] }[] = [
  { key: "settings.fanPresetOld", steps: DEFAULT_STEPS },
  {
    key: "settings.fanPresetQuiet",
    steps: [
      { celsius: 72, percent: 50 },
      { celsius: 80, percent: 70 },
      { celsius: 88, percent: 100 },
    ],
  },
  {
    key: "settings.fanPresetCool",
    steps: [
      { celsius: 60, percent: 60 },
      { celsius: 68, percent: 80 },
      { celsius: 75, percent: 100 },
    ],
  },
];

/** Options' order. */
export const THERMAL_MODES: ThermalMode[] = ["off", "slow", "together", "fans"];

export const MODE_LABELS: Record<ThermalMode, MessageKey> = {
  off: "settings.thermalModeOff",
  slow: "settings.thermalModeSlow",
  together: "settings.thermalModeTogether",
  fans: "settings.thermalModeFans",
};

export function usesFans(mode: ThermalMode): boolean {
  return mode === "together" || mode === "fans";
}

export function slows(mode: ThermalMode): boolean {
  return mode === "slow" || mode === "together";
}

/** A limit typed in Options: within MIN..MAX, whole degrees. */
export function clampLimit(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_LIMIT;
  return Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(n)));
}

/** Why a table typed in Options cannot be saved; null: it can. */
export function stepsProblem(steps: FanStep[]): MessageKey | null {
  const bad = (s: FanStep) =>
    !Number.isInteger(s.celsius) || s.celsius < MIN_LIMIT || s.celsius > MAX_LIMIT || !FAN_LEVELS.includes(s.percent);
  if (!steps.length || steps.length > MAX_STEPS || steps.some(bad)) return "settings.fanStepsRange";
  for (let i = 1; i < steps.length; i++) {
    if (steps[i].celsius <= steps[i - 1].celsius) return "settings.fanStepsOrder";
    if (steps[i].percent < steps[i - 1].percent) return "settings.fanStepsSpeed";
  }
  return null;
}

/** One more step above the last: 6°C higher, 10% faster (both capped); none past MAX_STEPS. */
export function addStep(steps: FanStep[]): FanStep[] {
  if (steps.length >= MAX_STEPS) return steps;
  const last = steps[steps.length - 1] ?? DEFAULT_STEPS[0];
  return [...steps, { celsius: Math.min(MAX_LIMIT, last.celsius + 6), percent: Math.min(100, last.percent + 10) }];
}

/** A step's target speed; null when the maximum is unknown. */
export function stepRpm(percent: number, maxRpm: number | null): number | null {
  return maxRpm === null ? null : Math.round((maxRpm * percent) / 100);
}

const tenth = (n: number) => Math.round(n * 10) / 10;
/** Where the chart starts: below the lowest limit, so idle temperatures show too, °C. */
const CHART_FROM = 35;
/** The plot's left and right edge, and the whole width (viewBox units). */
const CHART_LEFT = 40;
const CHART_RIGHT = 548;
const CHART_WIDTH = 560;
/** 35–100°C across x 40–548. */
const chartX = (celsius: number) =>
  tenth(
    CHART_LEFT +
      ((Math.min(MAX_LIMIT, Math.max(CHART_FROM, celsius)) - CHART_FROM) * (CHART_RIGHT - CHART_LEFT)) /
        (MAX_LIMIT - CHART_FROM),
  );
/** The labels of the lines sit in rows above the plot: the first row's baseline, and each row's height. */
const LABEL_FIRST = 10;
const LABEL_ROW = 12;
/** A label's width at the chart's 10px monospace, per character; and the least gap between two labels. */
const LABEL_CHAR = 6.1;
const LABEL_GAP = 6;
/** 0–100% takes 90 units up from the plot's bottom. */
const PLOT_HEIGHT = 90;

/** A line across the fan chart: the reading now, where slowing starts, or the emergency stop. */
export type ChartMarkKind = "now" | "slow" | "emergency";

export interface ChartMark {
  kind: ChartMarkKind;
  /** The line. */
  x: number;
  /** Its label: the text, its centre, baseline and width, above the plot. */
  text: string;
  labelX: number;
  labelY: number;
  labelWidth: number;
}

const MARK_TEXT: Record<ChartMarkKind, MessageKey> = {
  now: "settings.fanChartNow",
  slow: "settings.fanChartSlow",
  emergency: "settings.fanChartEmergency",
};

/** The lines' labels, each centred on its line as far as it fits in the chart, and a row lower
 * whenever it would touch a label already placed; also how many rows that took (at least one). */
function placeMarks(marks: { kind: ChartMarkKind; celsius: number }[]): { marks: ChartMark[]; rows: number } {
  const placed: { left: number; right: number; row: number }[] = [];
  const out = marks
    .map((m) => ({ ...m, x: chartX(m.celsius) }))
    .sort((a, b) => a.x - b.x)
    .map(({ kind, celsius, x }) => {
      const text = t(MARK_TEXT[kind], { c: celsius });
      const half = (text.length * LABEL_CHAR) / 2;
      const centre = Math.min(CHART_WIDTH - 2 - half, Math.max(2 + half, x));
      const [left, right] = [centre - half, centre + half];
      let row = 0;
      while (placed.some((p) => p.row === row && left < p.right + LABEL_GAP && p.left < right + LABEL_GAP)) row++;
      placed.push({ left, right, row });
      return { kind, x, text, labelX: tenth(centre), labelY: LABEL_FIRST + row * LABEL_ROW, labelWidth: tenth(half * 2) };
    });
  return { marks: out, rows: Math.max(1, ...placed.map((p) => p.row + 1)) };
}

/** The steps as SVG geometry: the stair line going up, the way down (each step `margin` lower,
 * never below the first limit, where macOS takes over; the same line when `margin` is 0), the
 * area under the way up, the percent grid, the auto band before the first step, and the lines
 * across it with their labels: the reading now (null: none), where slowing starts and the
 * emergency stop (0 or left out: none). The labels sit in rows above the plot, so the plot's
 * `top` and `bottom` and the chart's `height` grow with every extra row. */
export function fanChart(
  steps: FanStep[],
  margin: number,
  lines: { now?: number | null; slow?: number; emergency?: number },
): {
  line: string;
  down: string;
  area: string;
  ticks: { percent: number; y: number }[];
  degrees: { celsius: number; x: number }[];
  autoWidth: number;
  marks: ChartMark[];
  top: number;
  bottom: number;
  height: number;
} {
  const wanted: { kind: ChartMarkKind; celsius: number }[] = [];
  if (typeof lines.now === "number") wanted.push({ kind: "now", celsius: lines.now });
  if (lines.slow) wanted.push({ kind: "slow", celsius: lines.slow });
  if (lines.emergency) wanted.push({ kind: "emergency", celsius: lines.emergency });
  const { marks, rows } = placeMarks(wanted);
  const top = LABEL_FIRST + 8 + (rows - 1) * LABEL_ROW;
  const bottom = top + PLOT_HEIGHT;
  const chartY = (percent: number) => tenth(bottom - (percent * PLOT_HEIGHT) / 100);
  const table = steps.length ? steps : DEFAULT_STEPS;
  const first = table[0].celsius;
  const stairs = (from: (c: number) => number) => {
    let d = `M ${chartX(first)} ${chartY(0)}`;
    table.forEach((s, i) => {
      d += ` V ${chartY(s.percent)} H ${chartX(i + 1 < table.length ? from(table[i + 1].celsius) : MAX_LIMIT)}`;
    });
    return d;
  };
  const line = stairs((c) => c);
  return {
    line,
    down: stairs((c) => Math.max(first, c - margin)),
    area: `${line} V ${chartY(0)} Z`,
    ticks: [100, 50, 0].map((percent) => ({ percent, y: chartY(percent) })),
    degrees: [40, 50, 60, 70, 80, 90, 100].map((celsius) => ({ celsius, x: chartX(celsius) })),
    autoWidth: tenth(chartX(first) - CHART_LEFT),
    marks,
    top,
    bottom,
    height: bottom + 40,
  };
}

/** Options' modes; `why`: a fan mode greyed out, and the reason. */
export function modeOptions(info: FanInfo | null): { mode: ThermalMode; why: string | null }[] {
  const why = info ? info.unsupported : t("fans.unknown");
  return THERMAL_MODES.map((mode) => ({ mode, why: usesFans(mode) ? why : null }));
}

/** Slowing actually happens: hot, and some processes were slowed. */
export function slowing(s: ThermalStatus | null): boolean {
  return !!s && s.slowed && s.processes > 0;
}

/** The percent desk set on the fans; null: they are not desk's. */
function fanPercent(s: ThermalStatus | null): number | null {
  return s?.fans?.percent ?? null;
}

/** The chip's colour. `colors`: chosen in Options, and then only the temperature counts;
 * null: desk's own, red also while it slows or drives the fans. Red after an emergency stop. */
export function thermalLevel(s: ThermalStatus, colors: ThermalColors | null = null): "" | "warm" | "hot" {
  if (s.halted) return "hot";
  if (!colors && (s.slowed || fanPercent(s) !== null)) return "hot";
  const { warm, hot } = colors ?? autoColors([s.limit, s.fanSteps[0]?.celsius ?? 0]);
  if (s.celsius !== null && s.celsius >= hot) return "hot";
  if (s.celsius !== null && s.celsius >= warm) return "warm";
  return "";
}

export function thermalTitle(s: ThermalStatus): string {
  const c = s.celsius === null ? "?" : String(s.celsius);
  const lines =
    !s.limit && !s.fanSteps.length && !s.emergency
      ? [t("thermal.offTitle", { c })]
      : [slowTitle(s, c), ...(s.fanSteps.length ? fanLines(s) : [])];
  lines.push(...haltLines(s), t("thermal.clickHint"));
  return lines.join("\n");
}

/** The emergency stop: from where, or what it froze and when the work can resume. */
function haltLines(s: ThermalStatus): string[] {
  if (!s.emergency) return [];
  if (!s.halted) {
    if (s.cores !== null && s.celsius !== null)
      return [t("thermal.emergencyCores", { limit: s.emergency, cores: s.cores, c: s.celsius })];
    if (s.hottest !== null) return [t("thermal.emergencyCpu", { limit: s.emergency, c: s.hottest })];
    return [t("thermal.emergencyReady", { limit: s.emergency })];
  }
  const lines = [tn("thermal.haltedTitle", s.frozen, { limit: s.emergency, resume: s.emergency - RESUME_MARGIN })];
  if (s.haltedBy === "system") lines.push(t("thermal.haltedSystem"));
  if (s.jobs) lines.push(tn("thermal.jobsLeft", s.jobs));
  return lines;
}

/** Options' lines on what the emergency stop watches here: what it watches when that is the cores,
 * a warning when it sees less; nothing for a CPU sensor (Linux, Windows) or before the first reading. */
export function emergencyLines(sees: StopSees | null): MessageKey[] {
  switch (sees) {
    case "cores":
      return ["settings.emergencyWatchesCores"];
    case "sensor":
      return ["settings.emergencySensorOnly"];
    case "system":
      return ["settings.emergencySystemOnly"];
    case "nothing":
      return ["settings.emergencyNothing"];
    default:
      return [];
  }
}

function slowTitle(s: ThermalStatus, c: string): string {
  if (!s.limit) return t("thermal.cpu", { c });
  if (!s.slowed) return t("thermal.title", { c, limit: s.limit });
  if (s.cannotSlow) return t("thermal.cannotTitle", { c, limit: s.limit, why: s.cannotSlow });
  return tn("thermal.slowedTitle", s.processes, { c, limit: s.limit, cool: s.limit - COOL_MARGIN });
}

/** The step desk holds, how fast, and when it goes up or down; or why desk does not drive the fans. */
function fanLines(s: ThermalStatus): string[] {
  const steps = s.fanSteps;
  const k = s.fanStep === null ? null : Math.min(s.fanStep, steps.length - 1);
  const percent = fanPercent(s);
  if (s.fans?.problem && k !== null) {
    return [t("thermal.fansWant", { k: k + 1, percent: steps[k].percent, why: s.fans.problem })];
  }
  if (percent === null || k === null) {
    return [t("thermal.fansReady", { limit: steps[0].celsius, percent: steps[0].percent })];
  }
  const rpm = stepRpm(percent, s.fans?.maxRpm ?? null) ?? s.fans?.rpm ?? "?";
  const lines = [t("thermal.fansStep", { k: k + 1, n: steps.length, percent, rpm })];
  if (k + 1 < steps.length) lines.push(t("thermal.fansUp", { c: steps[k + 1].celsius, percent: steps[k + 1].percent }));
  // Below the first limit macOS has the fans (thermal.rs StepPolicy); the margin holds between steps.
  const auto = steps[0].celsius;
  const at = steps[k].celsius - s.fanMargin;
  lines.push(
    k > 0 && at > auto
      ? t("thermal.fansDown", { c: at, percent: steps[k - 1].percent, auto })
      : t("thermal.fansDownAuto", { auto }),
  );
  return lines;
}

/** What changed between two readings, as one toast (or none). */
export function thermalToast(prev: ThermalStatus | null, next: ThermalStatus): { text: string; kind: NoticeKind } | null {
  const c = next.celsius ?? "?";
  const warn = (text: string) => ({ text, kind: "warn" as const });
  const ok = (text: string) => ({ text, kind: "ok" as const });
  // The emergency stop comes before everything else that changed with it.
  if (next.halted && !prev?.halted) {
    const text =
      next.haltedBy === "system"
        ? tn("thermal.haltedSystemToast", next.frozen)
        : tn("thermal.halted", next.frozen, { c: next.hottest ?? c, limit: next.emergency });
    return { text, kind: "error" };
  }
  if (prev?.halted && !next.halted) return ok(t("thermal.resumed"));
  const slowOn = slowing(next) && !slowing(prev);
  // Turned off in Options is not "cooled down".
  const slowOff = slowing(prev) && !next.slowed && next.limit > 0;
  const percent = fanPercent(next);
  const wasFans = fanPercent(prev) !== null;
  const isFans = percent !== null;
  // A new step while the fans are already desk's: no toast.
  const fansOn = isFans && !wasFans;
  const fansOff = wasFans && !isFans && next.fanSteps.length > 0;
  if (slowOn && fansOn) return warn(t("thermal.slowingFans", { c, percent: percent ?? "?" }));
  if (slowOff && fansOff) return ok(t("thermal.cooledFans", { c }));
  if (slowOn) return warn(t("thermal.slowing", { c }));
  if (fansOn) return warn(t("thermal.fansOn", { c, percent: percent ?? "?" }));
  if (slowOff) return ok(t("thermal.cooled", { c }));
  if (fansOff) return ok(t("thermal.fansOff", { c }));
  const why = next.fans?.problem;
  if (why && why !== prev?.fans?.problem) return warn(t("thermal.fansProblem", { why }));
  return null;
}

/** The chip, and after an emergency stop the button that resumes the work; nothing on a
 * computer without a readable sensor where desk does nothing. `colors`: from Options. */
export function thermalHtml(s: ThermalStatus | null, colors: ThermalColors | null = null): string {
  const percent = fanPercent(s);
  if (!s || (s.celsius === null && !s.slowed && percent === null && !s.halted)) return "";
  const text = `${s.celsius === null ? "🌡" : `${s.celsius}°`}${percent !== null ? ` ≋ ${percent}%` : ""}${slowing(s) ? " ↓" : ""}${s.halted ? " ⏸" : ""}`;
  const cls = ["top-btn", "thermal", thermalLevel(s, colors), s.halted ? "halted" : ""].filter(Boolean).join(" ");
  const chip = `<button class="${cls}" data-top="thermal" title="${escapeHtml(thermalTitle(s))}">${text}</button>`;
  const resume = s.halted
    ? `<button class="top-btn thermal-resume" data-top="thermal-resume" title="${escapeHtml(t("thermal.resumeTitle", { resume: s.emergency - RESUME_MARGIN }))}">${t("thermal.resume")}</button>`
    : "";
  return `<span class="thermal-box" data-thermal>${chip}${resume}</span>`;
}

/** Same as tile.ts's (not imported: that pulls the terminal into tests). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
