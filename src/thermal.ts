// CPU temperature in the top bar ("72°", "84° ↓" while desk slows its
// sessions, "78° ≋ 70%" while the fans run at a step desk set). The readings,
// the slowing and the fans are Rust's (src-tauri/src/thermal.rs, fans.rs).
import type { FanInfo, FanStep, ThermalMode, ThermalStatus } from "./api";
import { t, tn, type MessageKey } from "./i18n";

export const DEFAULT_LIMIT = 75;
export const MIN_LIMIT = 50;
export const MAX_LIMIT = 100;
/** Full speed back this far below the limit (thermal.rs COOL_MARGIN). */
export const COOL_MARGIN = 7;
/** The chip turns yellow this close to the limit. */
const WARM_MARGIN = 10;
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
/** The chart's axes: 50–100°C across x 40–548, 0–100% up y 108–18 (viewBox 560×132). */
const chartX = (celsius: number) => tenth(40 + (Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, celsius)) - MIN_LIMIT) * 10.16);
const chartY = (percent: number) => tenth(108 - percent * 0.9);

/** The steps as SVG geometry: the stair line, the area under it, the auto band before the first
 * step, and where slowing (0: none) and the current reading (null: none) sit. */
export function fanChart(
  steps: FanStep[],
  slowLimit: number,
  celsius: number | null,
): { line: string; area: string; autoWidth: number; slowX: number | null; nowX: number | null } {
  const rows = steps.length ? steps : DEFAULT_STEPS;
  let line = `M ${chartX(rows[0].celsius)} ${chartY(0)}`;
  rows.forEach((s, i) => {
    line += ` V ${chartY(s.percent)} H ${chartX(i + 1 < rows.length ? rows[i + 1].celsius : MAX_LIMIT)}`;
  });
  return {
    line,
    area: `${line} V ${chartY(0)} Z`,
    autoWidth: tenth(chartX(rows[0].celsius) - 40),
    slowX: slowLimit > 0 ? chartX(slowLimit) : null,
    nowX: celsius === null ? null : chartX(celsius),
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

export function thermalLevel(s: ThermalStatus): "" | "warm" | "hot" {
  if (s.slowed || fanPercent(s) !== null) return "hot";
  const active = [s.limit, s.fanSteps[0]?.celsius ?? 0].filter((n) => n > 0);
  const limit = active.length ? Math.min(...active) : DEFAULT_LIMIT;
  if (s.celsius !== null && s.celsius >= limit) return "hot";
  if (s.celsius !== null && s.celsius >= limit - WARM_MARGIN) return "warm";
  return "";
}

export function thermalTitle(s: ThermalStatus): string {
  const c = s.celsius === null ? "?" : String(s.celsius);
  if (!s.limit && !s.fanSteps.length) return t("thermal.offTitle", { c });
  const lines = [slowTitle(s, c)];
  if (s.fanSteps.length) lines.push(...fanLines(s));
  return lines.join("\n");
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
  const at = steps[k].celsius - COOL_MARGIN;
  lines.push(
    k > 0 && at > auto
      ? t("thermal.fansDown", { c: at, percent: steps[k - 1].percent, auto })
      : t("thermal.fansDownAuto", { auto }),
  );
  return lines;
}

/** What changed between two readings, as one toast (or none). */
export function thermalToast(prev: ThermalStatus | null, next: ThermalStatus): string | null {
  const c = next.celsius ?? "?";
  const slowOn = slowing(next) && !slowing(prev);
  // Turned off in Options is not "cooled down".
  const slowOff = slowing(prev) && !next.slowed && next.limit > 0;
  const percent = fanPercent(next);
  const wasFans = fanPercent(prev) !== null;
  const isFans = percent !== null;
  // A new step while the fans are already desk's: no toast.
  const fansOn = isFans && !wasFans;
  const fansOff = wasFans && !isFans && next.fanSteps.length > 0;
  if (slowOn && fansOn) return t("thermal.slowingFans", { c, percent: percent ?? "?" });
  if (slowOff && fansOff) return t("thermal.cooledFans", { c });
  if (slowOn) return t("thermal.slowing", { c });
  if (fansOn) return t("thermal.fansOn", { c, percent: percent ?? "?" });
  if (slowOff) return t("thermal.cooled", { c });
  if (fansOff) return t("thermal.fansOff", { c });
  const why = next.fans?.problem;
  if (why && why !== prev?.fans?.problem) return t("thermal.fansProblem", { why });
  return null;
}

/** The chip; nothing on a computer without a readable sensor that is not slowing. */
export function thermalHtml(s: ThermalStatus | null): string {
  const percent = fanPercent(s);
  if (!s || (s.celsius === null && !s.slowed && percent === null)) return "";
  const text = `${s.celsius === null ? "🌡" : `${s.celsius}°`}${percent !== null ? ` ≋ ${percent}%` : ""}${slowing(s) ? " ↓" : ""}`;
  const cls = ["top-btn", "thermal", thermalLevel(s)].filter(Boolean).join(" ");
  return `<button class="${cls}" data-top="thermal" data-thermal title="${escapeHtml(thermalTitle(s))}">${text}</button>`;
}

/** Same as tile.ts's (not imported: that pulls the terminal into tests). */
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
