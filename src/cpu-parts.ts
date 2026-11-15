// Which parts of the temperature chip's panel show (Options → Heat and
// coffee → CPU panel). Saved as the hidden ones (layout cpuHidden), so a part
// added later shows until someone hides it. The panel: cpu-view.ts.
import { t, type MessageKey } from "./i18n";
import type { Platform } from "./platform";

/** The panel's parts, top to bottom. */
export const CPU_PARTS = ["gauges", "state", "history", "details", "load", "top"] as const;
export type CpuPart = (typeof CPU_PARTS)[number];

const LABELS: Record<CpuPart, MessageKey> = {
  gauges: "settings.cpuShowGauges",
  state: "settings.cpuShowState",
  history: "settings.cpuShowHistory",
  details: "settings.cpuShowDetails",
  load: "settings.cpuShowLoad",
  top: "settings.cpuShowTop",
};

/** desk reads the processes only while the panel shows its top processes. */
export const showsProcesses = (hidden: readonly string[]): boolean => !hidden.includes("top");

/** The parts Options offers: Windows keeps no load average, so its panel never has one. */
export function partsFor(platform: Platform): CpuPart[] {
  return CPU_PARTS.filter((p) => p !== "load" || platform !== "windows");
}

/** `hidden` with `part` shown or hidden; the other ids (a newer desk's parts too) stay as they were. */
export function withPart(hidden: readonly string[], part: string, shown: boolean): string[] {
  const rest = hidden.filter((h) => h !== part);
  return shown ? rest : [...rest, part];
}

/** Options' boxes, one per part, ticked = shown, with what the choice does. */
export function partsHtml(hidden: readonly string[], platform: Platform): string {
  const off = new Set(hidden);
  const boxes = partsFor(platform)
    .map(
      (p) =>
        `<label class="line" data-row><input type="checkbox" data-cpu-part="${p}" ${off.has(p) ? "" : "checked"}/> ${t(LABELS[p])}</label>`,
    )
    .join("");
  return `<p class="dim small" data-row>${t("settings.cpuPanelAbout")}</p>${boxes}<p class="dim small" data-row>${t("settings.cpuPanelHint")}</p>`;
}
