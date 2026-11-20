// ⌘O options: lane count, notifications, which projects start with the app,
// hand-added folders.
import { getVersion } from "@tauri-apps/api/app";
import { DEFAULT_THEME, THEMES } from "./themes";
import { TILE_ICON_SCALES, UI_SCALES, tileIconScale, uiScale } from "./ui-scale";
import {
  api,
  type AccountInfo,
  type AgentInfo,
  type ClaudeAccount,
  type CoffeeStatus,
  type DockerHost,
  type FanInfo,
  type FanStep,
  type Layout,
  type Project,
  type PromptAi,
  type ThermalColors,
  type ThermalMode,
  type ThermalStatus,
  type UsageLayout,
  type UploadHost,
  type UploadMethod,
  type UsageShare,
} from "./api";
import { accountColor, withAccount, withoutAccount } from "./accounts";
import type { LinkClick } from "./links";
import { partsHtml, withPart } from "./cpu-parts";
import { checkHosts, draftAdd, draftRemove, draftRows, draftSet } from "./docker-view";
import { PLATFORM, shortcut } from "./platform";
import { checkUploadHosts, methodOf, uploadDraftAdd, uploadDraftRemove, uploadDraftRows, uploadDraftSet } from "./upload-view";
import { rows, shortPath } from "./projects";
import { search, type SearchItem } from "./settings-search";
import { escapeHtml } from "./tile";
import { editorChoice } from "./find-view";
import { acceleratorFor, DEFAULT_HOTKEY, hotkeyLabel } from "./hotkey";
import { LANGUAGES, language, t, type Language, type MessageKey } from "./i18n";
import { bindingLabel, BINDINGS, clashWith, defaultsOf, FIXED, groupLabel, GROUPS, keyText } from "./keys";
import {
  addStep,
  autoColors,
  clampColors,
  clampEmergency,
  CORES_HOLD,
  DEFAULT_EMERGENCY,
  emergencyLines,
  clampFanMargin,
  clampLimit,
  DEFAULT_STEPS,
  FAN_LEVELS,
  FAN_PRESETS,
  FAN_WAITS,
  fanChart,
  MAX_COLOR,
  MAX_EMERGENCY,
  MAX_FAN_MARGIN,
  MAX_LIMIT,
  MAX_STEPS,
  MIN_COLOR,
  MIN_EMERGENCY,
  MIN_FAN_MARGIN,
  MIN_LIMIT,
  MODE_LABELS,
  modeOptions,
  RESUME_MARGIN,
  slows,
  stepRpm,
  stepsProblem,
  usesFans,
} from "./thermal";
import { toast } from "./ui";
import { UPDATE_EVERY_MS, updateStatusHtml, type UpdateStatus } from "./updates";

export interface SettingsContext {
  home: () => string;
  /** Where layout.json is on this system, shown in the footer. */
  layoutPath: () => string;
  layout: () => Layout;
  projects: () => Promise<Project[]>;
  setLaneCount: (n: number) => void;
  setAutoLayout: (on: boolean) => void;
  /** The files panel at the side (false) or in a window of its own (true); switched at once. */
  setFilesWindow: (on: boolean) => void;
  /** The file tree on the left of the files panel instead of the right. */
  setTreeLeft: (left: boolean) => void;
  setTheme: (id: string) => void;
  setBrowser: (id: string) => void;
  /** What a plain click on a terminal link does (links.ts). */
  setLinkClick: (mode: LinkClick) => void;
  /** The program that opens files at a line ("" = the built-in editor); checked before it gets here. */
  setFileEditor: (cmd: string) => void;
  /** The usage popover's layout (Options, AI stats). */
  setUsageLayout: (v: UsageLayout) => void;
  /** The size of the window's own text and bars (ui-scale.ts). */
  setUiScale: (v: number) => void;
  /** The size of the buttons in a tile's header (ui-scale.ts). */
  setTileIconScale: (v: number) => void;
  /** How a session's share of the 5-hour window is worked out. */
  setUsageShare: (v: UsageShare) => void;
  setFontSize: (px: number) => void;
  setLanguage: (id: Language) => void;
  setDropdown: (
    change: Partial<Pick<Layout, "dropdown" | "dropdownHeight" | "dropdownAutohide" | "dropdownHotkey" | "dropdownAnimation">>,
  ) => Promise<void>;
  /** A desk shortcut set in Options, removed (""), or back to its default (null). */
  setKey: (id: string, accelerator: string | null) => void;
  /** Ask GitHub for a newer desk now. */
  checkUpdate: () => Promise<void>;
  /** A newer desk found, and how the last check went (updates.ts). */
  updates: () => UpdateStatus;
  /** Install the newer desk, or open its release page. */
  installUpdate: () => Promise<void>;
  setNotifications: (on: boolean) => void;
  setTmuxMenu: (on: boolean) => void;
  setPromptAi: (change: Partial<PromptAi>) => void;
  toggleAutostart: (path: string) => void;
  addFolder: () => Promise<void>;
  removeFolder: (path: string) => void;
  /** What desk does when hot, and its limits (thermal.ts); saved at once. */
  setThermal: (
    change: Partial<
      Pick<Layout, "thermalMode" | "thermalLimit" | "fanSteps" | "fanMargin" | "fanWait" | "emergencyOn" | "emergencyAt" | "thermalColors">
    >,
  ) => void;
  /** Parts of the temperature chip's panel to hide (cpu-view.ts); saved at once. */
  setCpuHidden: (hidden: string[]) => void;
  /** The last temperature reading and fan step (thermal.rs); null before the first. */
  thermal: () => ThermalStatus | null;
  /** Can desk drive the fans here, and is the permission installed; null: unknown. */
  fans: () => FanInfo | null;
  /** The one admin password prompt for the fans; false: cancelled or failed (a toast says why). */
  installFans: () => Promise<boolean>;
  uninstallFans: () => Promise<void>;
  coffee: () => CoffeeStatus;
  uninstallCoffee: () => Promise<void>;
  agents: () => AgentInfo[];
  addAgent: (id: string, command: string) => Promise<void>;
  removeAgent: (id: string) => Promise<void>;
  /** Claude accounts changed (accounts.ts): saved at once, Rust reads them. */
  setAccounts: (change: Pick<Layout, "claudeAccounts" | "tileAccounts" | "projectAccounts">) => Promise<void>;
  /** Docker servers changed in Options: saved at once, the 🐳 chip follows. Never contacts them. */
  setDockerHosts: (hosts: DockerHost[]) => Promise<void>;
  /** Upload servers changed in Options: saved at once. Never contacts them. */
  setUploadHosts: (hosts: UploadHost[]) => Promise<void>;
}

/** The groups of Options, in the sidebar's order. */
export type Group = "general" | "look" | "window" | "terminal" | "projects" | "claude" | "stats" | "power" | "docker" | "upload" | "keys";

const GROUP_NAMES: Record<Group, MessageKey> = {
  general: "settings.general",
  look: "settings.look",
  window: "settings.window",
  terminal: "settings.terminal",
  projects: "settings.projects",
  claude: "settings.claude",
  stats: "settings.stats",
  power: "settings.power",
  docker: "settings.docker",
  upload: "settings.upload",
  keys: "settings.keys",
};

/** The text of an element as words: its pieces apart, not glued ("w desk" + "w przeglądarce"). */
function words(el: HTMLElement): string {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  while (walker.nextNode()) parts.push(walker.currentNode.textContent ?? "");
  return parts.join(" ");
}

/** A folder for an account: in the home folder (~/...) or a full path. */
const ACCOUNT_DIR = /^(~[\\/]|\/|[a-z]:[\\/]|\\\\)/i;

/** A fan step's wait as Options shows it: "30 s", "2 min". */
function waitLabel(seconds: number): string {
  return seconds < 60 ? t("settings.fanWaitSeconds", { n: seconds }) : t("settings.fanWaitMinutes", { n: seconds / 60 });
}

export class Settings {
  /** Docker rows typed but not saved: they outlive a re-render (another tab); null once saved or untouched. */
  private dockerDraft: DockerHost[] | null = null;

  private dockerRowHtml(h: DockerHost): string {
    return `<div class="line docker-host"><input type="text" data-k="docker-name" value="${escapeHtml(h.name)}" placeholder="${t("settings.dockerName")}" spellcheck="false" /><input type="text" data-k="docker-url" value="${escapeHtml(h.url)}" placeholder="${t("settings.dockerUrl")}" spellcheck="false" /><button data-k="docker-rm" title="${t("settings.dockerRemove")}">✕</button></div>`;
  }

  /** Docker servers: rows live in the DOM; Zapisz saves only what checkHosts accepts. */
  private bindDocker(box: HTMLElement): void {
    const rows = box.querySelector<HTMLElement>('[data-k="docker-rows"]')!;
    const error = box.querySelector<HTMLElement>('[data-k="docker-error"]')!;
    const index = (row: Element) => [...rows.children].indexOf(row);
    const current = () => draftRows(this.dockerDraft, this.ctx.layout().dockerHosts ?? []);
    rows.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".docker-host");
      if (!row || !(e.target as HTMLElement).closest('[data-k="docker-rm"]')) return;
      this.dockerDraft = draftRemove(current(), index(row));
      row.remove();
    });
    rows.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement;
      const row = input.closest(".docker-host");
      const field = input.dataset.k === "docker-name" ? "name" : input.dataset.k === "docker-url" ? "url" : null;
      if (row && field) this.dockerDraft = draftSet(current(), index(row), field, input.value);
    });
    box.querySelector('[data-k="docker-add"]')!.addEventListener("click", () => {
      this.dockerDraft = draftAdd(current());
      rows.insertAdjacentHTML("beforeend", this.dockerRowHtml({ name: "", url: "" }));
      rows.querySelector<HTMLInputElement>(".docker-host:last-child [data-k=docker-name]")?.focus();
    });
    box.querySelector('[data-k="docker-save"]')!.addEventListener("click", () => {
      const hosts = [...rows.querySelectorAll<HTMLElement>(".docker-host")].map((r) => ({
        name: r.querySelector<HTMLInputElement>('[data-k="docker-name"]')!.value.trim(),
        url: r.querySelector<HTMLInputElement>('[data-k="docker-url"]')!.value.trim(),
      }));
      const problem = checkHosts(hosts);
      error.textContent = problem ?? "";
      if (problem) return;
      void this.ctx
        .setDockerHosts(hosts)
        .then(() => {
          this.dockerDraft = null;
          toast(t("settings.dockerSaved"), { kind: "ok" });
        })
        .catch((err) => {
          error.textContent = String(err);
        });
    });
  }

  /** Upload rows typed but not saved: they outlive a re-render; null once saved or untouched. */
  private uploadDraft: UploadHost[] | null = null;
  /** Known hosts for the datalist (/etc/hosts): asked once, the first time the group renders. */
  private uploadSuggested: string[] | null = null;

  private uploadRowHtml(h: UploadHost): string {
    return `<div class="line upload-host"><input type="text" data-k="upload-host" list="upload-hosts" value="${escapeHtml(h.host)}" placeholder="${t("settings.uploadHost")}" spellcheck="false" /><input type="text" data-k="upload-user" value="${escapeHtml(h.user)}" placeholder="${t("settings.uploadUser")}" spellcheck="false" /><input type="text" data-k="upload-key" value="${escapeHtml(h.key)}" placeholder="${t("settings.uploadKey")}" spellcheck="false" /><select data-k="upload-method" title="${t("settings.uploadMethod")}">${(["rsync", "scp"] as const).map((m) => `<option value="${m}"${methodOf(h) === m ? " selected" : ""}>${m}</option>`).join("")}</select><button data-k="upload-rm" title="${t("settings.uploadRemove")}">✕</button></div>`;
  }

  private uploadOptionsHtml(): string {
    return (this.uploadSuggested ?? []).map((h) => `<option value="${escapeHtml(h)}"></option>`).join("");
  }

  /** Upload servers: rows live in the DOM; Zapisz saves only what checkUploadHosts accepts. */
  private bindUpload(box: HTMLElement): void {
    const rows = box.querySelector<HTMLElement>('[data-k="upload-rows"]')!;
    const error = box.querySelector<HTMLElement>('[data-k="upload-error"]')!;
    const list = box.querySelector<HTMLElement>("#upload-hosts")!;
    if (this.uploadSuggested === null) {
      this.uploadSuggested = [];
      void api
        .uploadSuggestions()
        .then((hosts) => {
          this.uploadSuggested = hosts;
          list.innerHTML = this.uploadOptionsHtml();
        })
        .catch(() => {});
    }
    const index = (row: Element) => [...rows.children].indexOf(row);
    const current = () => uploadDraftRows(this.uploadDraft, this.ctx.layout().uploadHosts ?? []);
    rows.addEventListener("click", (e) => {
      const row = (e.target as HTMLElement).closest(".upload-host");
      if (!row || !(e.target as HTMLElement).closest('[data-k="upload-rm"]')) return;
      this.uploadDraft = uploadDraftRemove(current(), index(row));
      row.remove();
    });
    rows.addEventListener("input", (e) => {
      const input = e.target as HTMLInputElement | HTMLSelectElement;
      const row = input.closest(".upload-host");
      const fields = { "upload-host": "host", "upload-user": "user", "upload-key": "key", "upload-method": "method" } as const;
      const field = fields[input.dataset.k as keyof typeof fields] ?? null;
      if (row && field) this.uploadDraft = uploadDraftSet(current(), index(row), field, input.value);
    });
    box.querySelector('[data-k="upload-add"]')!.addEventListener("click", () => {
      this.uploadDraft = uploadDraftAdd(current());
      rows.insertAdjacentHTML("beforeend", this.uploadRowHtml({ host: "", user: "", key: "" }));
      rows.querySelector<HTMLInputElement>(".upload-host:last-child [data-k=upload-host]")?.focus();
    });
    box.querySelector('[data-k="upload-save"]')!.addEventListener("click", () => {
      const hosts = [...rows.querySelectorAll<HTMLElement>(".upload-host")].map((r) => ({
        host: r.querySelector<HTMLInputElement>('[data-k="upload-host"]')!.value.trim(),
        user: r.querySelector<HTMLInputElement>('[data-k="upload-user"]')!.value.trim(),
        key: r.querySelector<HTMLInputElement>('[data-k="upload-key"]')!.value.trim(),
        method: methodOf({ host: "", user: "", key: "", method: r.querySelector<HTMLSelectElement>('[data-k="upload-method"]')!.value as UploadMethod }),
      }));
      const problem = checkUploadHosts(hosts);
      error.textContent = problem ?? "";
      if (problem) return;
      void this.ctx
        .setUploadHosts(hosts)
        .then(() => {
          this.uploadDraft = null;
          toast(t("settings.uploadSaved"), { kind: "ok" });
        })
        .catch((err) => {
          error.textContent = String(err);
        });
    });
  }

  /** Pasted WireGuard config for prompt rewriting: saved by Rust to an
   *  owner-only file; the field is emptied after saving, only the server shows. */
  private bindVpn(box: HTMLElement): void {
    const area = box.querySelector<HTMLTextAreaElement>('[data-k="prompt-ai-vpn"]')!;
    const status = box.querySelector<HTMLElement>('[data-k="prompt-ai-vpn-status"]')!;
    const rm = box.querySelector<HTMLButtonElement>('[data-k="prompt-ai-vpn-rm"]')!;
    const saveBtn = box.querySelector<HTMLButtonElement>('[data-k="prompt-ai-vpn-save"]')!;
    const error = box.querySelector<HTMLElement>('[data-k="prompt-ai-vpn-error"]')!;
    // A paste saves at once and clears the field (the private key is not left
    // on screen), so an empty field with a saved config is not an error.
    let saved: string | null = null;
    const show = (server: string | null) => {
      saved = server;
      status.textContent = server ? t("settings.promptAiVpnSaved", { server }) : t("settings.promptAiVpnNone");
      rm.hidden = !server;
    };
    // The error stays under the field until the next try: a toast was missed.
    const save = (conf: string) => {
      error.textContent = "";
      return api
        .setPromptAiVpn(conf)
        .then((server) => {
          area.value = "";
          show(server);
          if (server) toast(t("settings.promptAiVpnSaved", { server }), { kind: "ok" });
        })
        .catch((err) => {
          error.textContent = String(err);
        });
    };
    void api.promptAiVpn().then(show).catch(() => show(null));
    // Saved right after a paste (the value is there on the next tick), on
    // leaving the field, or with the button.
    area.addEventListener("paste", () => setTimeout(() => area.value.trim() && void save(area.value)));
    area.addEventListener("change", () => {
      if (area.value.trim()) void save(area.value);
    });
    saveBtn.addEventListener("click", () => {
      if (area.value.trim()) void save(area.value);
      else if (saved) toast(t("settings.promptAiVpnSaved", { server: saved }), { kind: "ok" });
      else error.textContent = t("settings.promptAiVpnEmpty");
    });
    rm.addEventListener("click", () => void save(""));
  }

  /** The accounts as Options lists them: with none set, the default one alone. */
  private accountRows(layout: Layout): ClaudeAccount[] {
    return layout.claudeAccounts?.length ? layout.claudeAccounts : [{ id: "main", name: t("settings.accountMain"), dir: "" }];
  }

  /** Names, removal, a new account, and who is logged in on each. */
  /** Options → Heat and coffee → Temperature: what desk does when hot. */
  private thermalHtml(layout: Layout): string {
    const mode = layout.thermalMode;
    const info = this.ctx.fans();
    const seg = modeOptions(info)
      .map(
        ({ mode: m, why }) =>
          `<button class="${m === mode ? "sel" : ""}" data-thermal-mode="${m}"${why ? ` disabled title="${escapeHtml(why)}"` : ""}>${t(MODE_LABELS[m])}</button>`,
      )
      .join("");
    let html = `<div class="line" data-row><span>${t("settings.thermalMode")}</span><span class="seg wrap">${seg}</span></div>`;
    if (slows(mode)) {
      html += `<label class="line" data-row>${t("settings.thermalLimit")} <input type="number" min="${MIN_LIMIT}" max="${MAX_LIMIT}" step="1" value="${layout.thermalLimit}" data-k="thermal-limit"/> °C</label>`;
    }
    if (usesFans(mode)) html += this.fanStepsHtml(layout, info);
    if (info && !info.unsupported) {
      const consent =
        info.consent === "installed"
          ? `${t("settings.fansInstalled")} <button data-k="fans-rm">${t("settings.fansRemove")}</button>`
          : info.consent === "outdated"
            ? `${t("settings.fansOutdated")} <button data-k="fans-update">${t("settings.fansUpdate")}</button>`
            : t("settings.fansAsk");
      html += `<div class="line dim" data-row>${consent}</div>`;
    }
    html += this.thermalColorsHtml(layout) + this.emergencyHtml(layout);
    const about: MessageKey[] =
      mode === "off"
        ? ["settings.thermalAboutOff"]
        : [...(slows(mode) ? (["settings.thermalAbout"] as const) : []), ...(usesFans(mode) ? (["settings.thermalAboutFans"] as const) : [])];
    return html + about.map((k) => `<p class="dim small" data-row>${t(k)}</p>`).join("");
  }

  /** desk's own chip colours for this mode: from the slowing limit or the first fan step. */
  private autoColors(layout: Layout): ThermalColors {
    const mode = layout.thermalMode;
    return autoColors([slows(mode) ? layout.thermalLimit : 0, usesFans(mode) ? (layout.fanSteps[0]?.celsius ?? 0) : 0]);
  }

  /** The temperature chip's colours: yellow from, red from, and the chip as it looks in each. */
  private thermalColorsHtml(layout: Layout): string {
    const c = layout.thermalColors ?? this.autoColors(layout);
    const input = (k: keyof ThermalColors, label: MessageKey) =>
      `<input type="number" min="${MIN_COLOR}" max="${MAX_COLOR}" step="1" value="${c[k]}" data-k="color-${k}" aria-label="${escapeHtml(t(label))}"/>`;
    const follow = layout.thermalColors
      ? `<button class="reset" data-k="colors-auto" title="${escapeHtml(t("settings.thermalColorsAuto"))}">↺</button>`
      : `<span class="dim">${t("settings.thermalColorsFollow")}</span>`;
    const chip = (level: string, celsius: number) => `<span class="top-btn thermal${level}">${celsius}°</span>`;
    const samples = [chip("", c.warm - 1), ...(c.warm < c.hot ? [chip(" warm", c.warm)] : []), chip(" hot", c.hot)].join("");
    return `<div class="line wrap" data-row><span>${t("settings.thermalColors")}</span>
      ${t("settings.thermalColorsWarm")} ${input("warm", "settings.thermalColorsWarm")} °C
      ${t("settings.thermalColorsHot")} ${input("hot", "settings.thermalColorsHot")} °C ${follow}
      <span class="thermal-sample" aria-hidden="true">${samples}</span></div>`;
  }

  /** Options → Heat and coffee → CPU panel: a box per part, ticked = shown (cpu-parts.ts). */
  private bindCpuPanel(box: HTMLElement): void {
    box.querySelectorAll<HTMLInputElement>("[data-cpu-part]").forEach((input) =>
      input.addEventListener("change", () =>
        this.ctx.setCpuHidden(withPart(this.ctx.layout().cpuHidden, input.dataset.cpuPart!, input.checked)),
      ),
    );
  }

  /** The emergency stop: on or off, and from where. */
  private emergencyHtml(layout: Layout): string {
    const on = layout.emergencyOn;
    // While on: what it watches here, or a warning when it sees less (thermal.ts emergencyLines).
    const watches = (on ? emergencyLines(this.ctx.thermal()?.sees ?? null, layout.emergencyAt) : [])
      .map(
        (k) =>
          `<p class="${k === "settings.emergencyWatchesCores" ? "dim small" : "error"}" data-row>${t(k, { hold: CORES_HOLD, suggested: DEFAULT_EMERGENCY })}</p>`,
      )
      .join("");
    return `<label class="line" data-row><input type="checkbox" data-k="emergency-on" ${on ? "checked" : ""}/> ${t("settings.emergencyOn")}</label>
      <label class="line" data-row>${t("settings.emergencyAt")} <input type="number" min="${MIN_EMERGENCY}" max="${MAX_EMERGENCY}" step="1" value="${layout.emergencyAt}" data-k="emergency-at" ${on ? "" : "disabled"}/> °C</label>
      ${watches}<p class="dim small" data-row>${t("settings.emergencyAbout", { margin: RESUME_MARGIN })}</p>`;
  }

  /** The fan steps: a row per step, add, presets, the reason a table is not saved, and the chart. */
  private fanStepsHtml(layout: Layout, info: FanInfo | null): string {
    const steps = layout.fanSteps.length ? layout.fanSteps : DEFAULT_STEPS;
    const thermal = this.ctx.thermal();
    // The step desk holds now: only once it has set the fans.
    const held = (thermal?.fans?.percent ?? null) !== null ? thermal?.fanStep : null;
    const rows = steps
      .map((s, i) => {
        const rpm = stepRpm(s.percent, info?.maxRpm ?? null);
        const levels = FAN_LEVELS.map((p) => `<option value="${p}"${p === s.percent ? " selected" : ""}>${p}%</option>`).join("");
        return `<div class="fan-step${i === held ? " now" : ""}">
          <label class="line">${t("settings.fanStepFrom")} <input type="number" min="${MIN_LIMIT}" max="${MAX_LIMIT}" step="1" value="${s.celsius}" data-step-c="${i}" aria-label="${escapeHtml(t("settings.fanStepCelsius", { n: i + 1 }))}"/> °C</label>
          <span class="dim">→</span>
          <select data-step-p="${i}" aria-label="${escapeHtml(t("settings.fanStepPercent", { n: i + 1 }))}">${levels}</select>
          ${rpm === null ? "" : `<span class="dim">${t("settings.fanStepRpm", { rpm })}</span>`}
          ${i === held ? `<span class="step-now">${t("settings.fanStepNow")}</span>` : ""}
          <button class="step-rm" data-step-rm="${i}" aria-label="${escapeHtml(t("settings.fanStepRemove", { n: i + 1 }))}"${steps.length <= 1 ? " disabled" : ""}>✕</button>
        </div>`;
      })
      .join("");
    const presets = FAN_PRESETS.map((p, i) => `<button data-preset="${i}">${t(p.key)}</button>`).join("");
    const waits = FAN_WAITS.map(
      (w) => `<option value="${w}"${w === layout.fanWait ? " selected" : ""}>${waitLabel(w)}</option>`,
    ).join("");
    const down = `<div class="line wrap">${t("settings.fanDown")} <input type="number" min="${MIN_FAN_MARGIN}" max="${MAX_FAN_MARGIN}" step="1" value="${layout.fanMargin}" data-k="fan-margin" aria-label="${escapeHtml(t("settings.fanMargin"))}" title="${escapeHtml(t("settings.fanMarginHint"))}"/> ${t("settings.fanDownMargin")} <select data-k="fan-wait" aria-label="${escapeHtml(t("settings.fanWait"))}">${waits}</select></div>`;
    // The lines across the chart, each with its label; fanChart keeps the labels apart.
    const chart = this.fanChartSvg(steps, layout, {
      now: thermal?.celsius ?? null,
      slow: slows(layout.thermalMode) ? layout.thermalLimit : 0,
      emergency: layout.emergencyOn ? layout.emergencyAt : 0,
    });
    return `<div class="fan-steps" data-row>
      <span>${t("settings.fanSteps")}</span>
      <div class="fan-step-rows">${rows}</div>
      <p class="error" data-k="steps-error" hidden></p>
      <div class="line wrap"><button data-k="step-add"${steps.length >= MAX_STEPS ? " disabled" : ""}>${t("settings.fanStepAdd")}</button><span class="dim">${t("settings.fanPresets")}</span>${presets}</div>
      ${down}
      ${chart}
    </div>`;
  }

  /** The steps over 35–100°C (thermal.ts fanChart): auto before the first, the way up and down,
   * and the lines across it with their labels in rows above, never on top of each other. */
  private fanChartSvg(steps: FanStep[], layout: Layout, lines: Parameters<typeof fanChart>[2]): string {
    const c = fanChart(steps, layout.fanMargin, lines);
    const { top, bottom } = c;
    const ticks = c.degrees
      .map((d) => `<text class="tick" x="${d.x}" y="${bottom + 16}" text-anchor="middle">${d.celsius}°</text>`)
      .join("");
    const pct = c.ticks.map((g) => `<text class="tick" x="34" y="${g.y + 3}" text-anchor="end">${g.percent}%</text>`).join("");
    const grid = c.ticks.map((g) => `<line class="grid" x1="40" y1="${g.y}" x2="548" y2="${g.y}"/>`).join("");
    const wait = waitLabel(layout.fanWait);
    const ly = bottom + 31;
    // No margin: the way down is the way up, one line for both.
    const legend =
      layout.fanMargin > 0
        ? `<line class="steps" x1="40" y1="${ly}" x2="60" y2="${ly}"/><text class="tick" x="66" y="${ly + 3}">${t("settings.fanChartUp")}</text>
      <line class="down" x1="140" y1="${ly}" x2="160" y2="${ly}"/><text class="tick" x="166" y="${ly + 3}">${t("settings.fanChartDown", { m: layout.fanMargin, wait })}</text>`
        : `<line class="steps" x1="40" y1="${ly}" x2="60" y2="${ly}"/><text class="tick" x="66" y="${ly + 3}">${t("settings.fanChartBoth", { wait })}</text>`;
    const down = layout.fanMargin > 0 ? `<path class="down" d="${c.down}"/>` : "";
    // Each line runs from just under its label to the axis; the labels go last, each on a patch of
    // the panel's colour, so a line from a label higher up never runs through one lower down.
    const marks = c.marks
      .map((m) => `<line class="mark ${m.kind}" x1="${m.x}" y1="${m.labelY + 3}" x2="${m.x}" y2="${bottom}"/>`)
      .join("");
    const labels = c.marks
      .map(
        (m) =>
          `<rect class="mark-bg" x="${m.labelX - m.labelWidth / 2 - 2}" y="${m.labelY - 9}" width="${m.labelWidth + 4}" height="12"/><text class="mark ${m.kind}" x="${m.labelX}" y="${m.labelY}" text-anchor="middle">${escapeHtml(m.text)}</text>`,
      )
      .join("");
    const auto =
      c.autoWidth > 80
        ? `<text class="tick" x="${40 + c.autoWidth / 2}" y="${top + 26}" text-anchor="middle">${t("settings.fanChartAuto")}</text>`
        : "";
    return `<svg class="fan-chart" viewBox="0 0 560 ${c.height}" role="img" aria-label="${escapeHtml(t("settings.fanSteps"))}">
      <rect class="auto" x="40" y="${top}" width="${c.autoWidth}" height="${bottom - top}"/>${auto}
      ${grid}<line class="axis" x1="40" y1="${bottom}" x2="548" y2="${bottom}"/>
      ${pct}<path class="area" d="${c.area}"/>${down}<path class="steps" d="${c.line}"/>${marks}${ticks}${labels}
      ${legend}
    </svg>`;
  }

  private bindThermal(box: HTMLElement): void {
    box.querySelectorAll<HTMLButtonElement>("[data-thermal-mode]").forEach((b) =>
      b.addEventListener("click", async () => {
        const mode = b.dataset.thermalMode as ThermalMode;
        // The fans only ever after the user's own pick, behind the password.
        if (usesFans(mode) && this.ctx.fans()?.consent !== "installed" && !(await this.ctx.installFans())) {
          this.render();
          return;
        }
        this.ctx.setThermal({ thermalMode: mode });
        this.render();
      }),
    );
    const limit = box.querySelector<HTMLInputElement>('[data-k="thermal-limit"]');
    limit?.addEventListener("change", () => {
      const celsius = clampLimit(Number(limit.value));
      limit.value = String(celsius);
      this.ctx.setThermal({ thermalLimit: celsius });
      this.render();
    });
    // A table is saved only whole and valid; otherwise the reason shows and nothing changes.
    const save = (fanSteps: FanStep[]) => {
      const why = stepsProblem(fanSteps);
      const error = box.querySelector<HTMLElement>('[data-k="steps-error"]');
      if (why) {
        if (error) {
          error.textContent = t(why);
          error.hidden = false;
        }
        return;
      }
      this.ctx.setThermal({ fanSteps });
      this.render();
    };
    const typed = (): FanStep[] =>
      [...box.querySelectorAll<HTMLInputElement>("[data-step-c]")].map((input) => ({
        celsius: Number(input.value),
        percent: Number(box.querySelector<HTMLSelectElement>(`[data-step-p="${input.dataset.stepC}"]`)?.value),
      }));
    box.querySelectorAll("[data-step-c], [data-step-p]").forEach((el) => el.addEventListener("change", () => save(typed())));
    box.querySelectorAll<HTMLButtonElement>("[data-step-rm]").forEach((b) =>
      b.addEventListener("click", () => save(typed().filter((_, i) => i !== Number(b.dataset.stepRm)))),
    );
    box.querySelector<HTMLButtonElement>('[data-k="step-add"]')?.addEventListener("click", () => save(addStep(typed())));
    const margin = box.querySelector<HTMLInputElement>('[data-k="fan-margin"]');
    margin?.addEventListener("change", () => {
      const c = clampFanMargin(margin.value === "" ? Number.NaN : Number(margin.value));
      margin.value = String(c);
      this.ctx.setThermal({ fanMargin: c });
      this.render();
    });
    const wait = box.querySelector<HTMLSelectElement>('[data-k="fan-wait"]');
    wait?.addEventListener("change", () => {
      this.ctx.setThermal({ fanWait: Number(wait.value) });
      this.render();
    });
    box.querySelectorAll<HTMLButtonElement>("[data-preset]").forEach((b) =>
      b.addEventListener("click", () => save(FAN_PRESETS[Number(b.dataset.preset)].steps.map((s) => ({ ...s })))),
    );
    // Colours: whole degrees, yellow never above red (the one just typed wins); an empty box keeps its value.
    const colors = (keep: keyof ThermalColors) => {
      const layout = this.ctx.layout();
      const was = layout.thermalColors ?? this.autoColors(layout);
      const typed = (k: keyof ThermalColors) => {
        const v = box.querySelector<HTMLInputElement>(`[data-k="color-${k}"]`)?.value ?? "";
        return v === "" || !Number.isFinite(Number(v)) ? was[k] : Number(v);
      };
      this.ctx.setThermal({ thermalColors: clampColors({ warm: typed("warm"), hot: typed("hot") }, keep) });
      this.render();
    };
    box.querySelector('[data-k="color-warm"]')?.addEventListener("change", () => colors("warm"));
    box.querySelector('[data-k="color-hot"]')?.addEventListener("change", () => colors("hot"));
    box.querySelector('[data-k="colors-auto"]')?.addEventListener("click", () => {
      this.ctx.setThermal({ thermalColors: null });
      this.render();
    });
    box.querySelector<HTMLInputElement>('[data-k="emergency-on"]')?.addEventListener("change", (e) => {
      this.ctx.setThermal({ emergencyOn: (e.target as HTMLInputElement).checked });
      this.render();
    });
    const emergency = box.querySelector<HTMLInputElement>('[data-k="emergency-at"]');
    emergency?.addEventListener("change", () => {
      const celsius = clampEmergency(emergency.value === "" ? this.ctx.layout().emergencyAt : Number(emergency.value));
      emergency.value = String(celsius);
      this.ctx.setThermal({ emergencyAt: celsius });
      this.render();
    });
    box.querySelector<HTMLButtonElement>('[data-k="fans-rm"]')?.addEventListener("click", async () => {
      await this.ctx.uninstallFans();
      this.render();
    });
    box.querySelector<HTMLButtonElement>('[data-k="fans-update"]')?.addEventListener("click", async () => {
      await this.ctx.installFans();
      this.render();
    });
  }

  private bindAccounts(box: HTMLElement): void {
    const layout = this.ctx.layout();
    const rows = this.accountRows(layout);
    const change = (claudeAccounts: ClaudeAccount[]) =>
      this.ctx.setAccounts({ claudeAccounts, tileAccounts: layout.tileAccounts, projectAccounts: layout.projectAccounts }).then(() => this.render());
    box.querySelectorAll<HTMLInputElement>("[data-acct-name]").forEach((input) =>
      input.addEventListener("change", () => {
        const name = input.value.trim();
        const id = input.dataset.acctName!;
        if (!name || rows.some((a) => a.id !== id && a.name.toLowerCase() === name.toLowerCase())) {
          if (name) toast(t("settings.accountExists"), { kind: "warn" });
          input.value = rows.find((a) => a.id === id)?.name ?? "";
          return;
        }
        void change(rows.map((a) => (a.id === id ? { ...a, name } : a)));
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-rm-acct]").forEach((b) =>
      b.addEventListener("click", () => {
        void this.ctx.setAccounts(withoutAccount(layout, b.dataset.rmAcct!)).then(() => this.render());
      }),
    );
    box.querySelector<HTMLButtonElement>('[data-k="acct-add"]')!.addEventListener("click", () => {
      const name = box.querySelector<HTMLInputElement>('[data-k="acct-name"]')!.value.trim();
      const dir = box.querySelector<HTMLInputElement>('[data-k="acct-dir"]')!.value.trim();
      if (!name) return;
      if (rows.some((a) => a.name.toLowerCase() === name.toLowerCase())) return toast(t("settings.accountExists"), { kind: "warn" });
      if (dir && !ACCOUNT_DIR.test(dir)) return toast(t("settings.accountDirBad"), { kind: "warn" });
      void change(withAccount(layout.claudeAccounts ?? [], name, dir, t("settings.accountMain")));
    });
    // Who is logged in, read from each account's own Claude config.
    void api
      .claudeAccounts()
      .then((infos: AccountInfo[]) => {
        for (const a of rows) {
          const el = this.el?.querySelector<HTMLElement>(`[data-acct-email="${CSS.escape(a.id)}"]`);
          const info = infos.find((i) => i.id === a.id) ?? (rows.length === 1 ? infos[0] : undefined);
          if (el) el.textContent = info?.email ? `· ${info.email}` : `· ${t("settings.accountNoLogin")}`;
        }
      })
      .catch(() => {});
  }

  private el: HTMLElement | null = null;
  private projects: Project[] = [];
  private filter = "";
  /** Waiting for a new shortcut: "dropdown" or a binding id (keys.ts). */
  private recording: string | null = null;
  private tab: Group = "general";
  /** What is typed in the search field; "" shows the chosen group. */
  private query = "";
  /** "program" chosen for the file editor while no command is saved yet. */
  private fileEditorProgram = false;

  constructor(private ctx: SettingsContext) {}

  get isOpen(): boolean {
    return this.el !== null;
  }

  /** Keys go to the shortcut field, not to desk's shortcuts. */
  get isRecording(): boolean {
    return this.recording !== null;
  }

  /** Open on `group`, or on the group seen last; close when open. */
  async toggle(group?: Group): Promise<void> {
    if (this.el) return this.close();
    if (group) this.tab = group;
    this.el = document.createElement("div");
    this.el.className = "overlay";
    this.el.innerHTML = `<div class="dialog settings"></div>`;
    this.el.addEventListener("mousedown", (e) => {
      if (e.target === this.el) this.close();
    });
    // On the window: the focus usually stays in the terminal behind.
    window.addEventListener("keydown", this.onKey, true);
    document.body.appendChild(this.el);
    this.render();
    this.el.querySelector<HTMLInputElement>('[data-k="search"]')?.focus();
    this.projects = await this.ctx.projects();
    this.render();
  }

  /** Check the program first; save it only when it is found, else say why under the field. */
  private async saveFileEditor(input: HTMLInputElement, box: HTMLElement): Promise<void> {
    const cmd = input.value.trim();
    const err = box.querySelector<HTMLElement>('[data-k="file-editor-err"]');
    const show = (msg: string) => {
      if (!err) return;
      err.textContent = msg;
      err.hidden = !msg;
    };
    if (cmd) {
      try {
        await api.checkFileEditor(cmd);
      } catch (e) {
        show(String(e));
        return;
      }
    }
    show("");
    this.ctx.setFileEditor(cmd);
  }

  /** The line about a newer desk again, alone: a check every half hour must
   *  not rebuild Options under what you type. */
  showUpdate(): void {
    const line = this.el?.querySelector<HTMLElement>('[data-k="update-status"]');
    if (!line) return;
    line.innerHTML = updateStatusHtml(this.ctx.updates());
    this.bindUpdate(line);
  }

  private bindUpdate(box: HTMLElement): void {
    box.querySelector<HTMLButtonElement>('[data-k="update-install"]')?.addEventListener("click", () => void this.ctx.installUpdate());
  }

  close(): void {
    window.removeEventListener("keydown", this.onKey, true);
    this.recording = null;
    this.query = "";
    this.el?.remove();
    this.el = null;
  }

  private onKey = (e: KeyboardEvent): void => {
    if (this.recording) {
      e.preventDefault();
      e.stopPropagation();
      if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
        this.recording = null;
        this.render();
        return;
      }
      const accelerator = acceleratorFor(e);
      if (!accelerator) return; // a modifier alone: wait for the key
      const id = this.recording;
      this.recording = null;
      this.record(id, accelerator);
      return;
    }
    if (e.key !== "Escape" || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    e.stopPropagation();
    // Esc first empties the search, then closes.
    if (this.query) {
      this.query = "";
      const field = this.el?.querySelector<HTMLInputElement>('[data-k="search"]');
      if (field) field.value = "";
      this.applySearch();
      return;
    }
    this.close();
  };

  /**
   * Show what the search field asks for, without building the page again
   * (typing keeps its focus, half-filled fields keep their text): the rows
   * that match in every group, or with no query the chosen group whole.
   */
  private applySearch(): void {
    const box = this.el?.querySelector<HTMLElement>(".dialog");
    if (!box) return;
    const found = [...box.querySelectorAll<HTMLElement>("[data-row]")];
    const items: SearchItem[] = found.map((row) => ({
      group: row.closest<HTMLElement>("[data-pane]")?.dataset.pane ?? "",
      section: row.closest("[data-section]")?.querySelector(":scope > h3")?.textContent ?? "",
      // "header": found by its section's header alone (the projects have their own filter).
      text: row.dataset.row === "header" ? "" : words(row),
    }));
    const names = Object.fromEntries(Object.entries(GROUP_NAMES).map(([id, key]) => [id, t(key)]));
    const result = search(items, names, this.query);
    const searching = result.query !== "";
    found.forEach((row, i) => (row.hidden = !result.show[i]));
    box.querySelectorAll<HTMLElement>("[data-section]:not([data-row])").forEach((section) => {
      section.hidden = searching && !section.querySelector("[data-row]:not([hidden])");
    });
    box.querySelectorAll<HTMLElement>("[data-pane]").forEach((pane) => {
      pane.hidden = searching ? !result.counts[pane.dataset.pane!] : pane.dataset.pane !== this.tab;
    });
    box.querySelectorAll<HTMLElement>("[data-tab]").forEach((tab) => {
      const hits = result.counts[tab.dataset.tab!] ?? 0;
      tab.querySelector(".count")!.textContent = searching ? String(hits) : "";
      tab.classList.toggle("dim", searching && !hits);
      tab.classList.toggle("sel", !searching && tab.dataset.tab === this.tab);
    });
    box.querySelector<HTMLElement>('[data-k="search-none"]')!.hidden = !searching || Object.keys(result.counts).length > 0;
  }

  /** A new shortcut was pressed for `id`: taken keys are refused. */
  private record(id: string, accelerator: string): void {
    const layout = this.ctx.layout();
    const dropdown = layout.dropdown ? layout.dropdownHotkey || DEFAULT_HOTKEY() : "";
    const clash = id !== "dropdown" && accelerator === dropdown ? "dropdown" : clashWith(id, accelerator);
    if (clash) {
      toast(t("settings.taken", { key: hotkeyLabel(accelerator), what: clash }), { kind: "warn" });
      this.render();
      return;
    }
    if (id === "dropdown") {
      void this.ctx.setDropdown({ dropdownHotkey: accelerator }).then(() => this.render());
      return;
    }
    const b = BINDINGS.find((x) => x.id === id)!;
    // Its default again: nothing to keep in layout.keys.
    const own = defaultsOf(b);
    this.ctx.setKey(id, own.length === 1 && own[0] === accelerator ? null : accelerator);
    this.render();
  }

  private keyButton(id: string, label: string, disabled = ""): string {
    const on = this.recording === id;
    return `<button class="key ${on ? "recording" : ""}" data-record="${escapeHtml(id)}" ${disabled}>${
      on ? t("settings.press") : escapeHtml(label)
    }</button>`;
  }

  async reload(): Promise<void> {
    this.projects = await this.ctx.projects();
    this.render();
  }

  render(): void {
    const box = this.el?.querySelector<HTMLElement>(".dialog");
    if (!box) return;
    // Building the page again must not move what you look at or type in.
    const before = box.querySelector<HTMLInputElement>('[data-k="search"]');
    const caret = before && document.activeElement === before ? before.selectionStart : null;
    const scroll = box.querySelector(".settings-panes")?.scrollTop ?? 0;
    const layout = this.ctx.layout();
    const auto = new Set(layout.autostart);
    const list = rows(this.projects, this.filter);
    // Autostart entries first so the current choice is visible without scrolling.
    list.sort((a, b) => Number(auto.has(b.project.path)) - Number(auto.has(a.project.path)));

    const hotkey = hotkeyLabel(layout.dropdownHotkey || DEFAULT_HOTKEY());
    const off = layout.dropdown ? "" : "disabled";
    const linkClick: LinkClick = layout.linkClick === "browser" || layout.linkClick === "none" ? layout.linkClick : "desk";
    const program = this.fileEditorProgram || editorChoice(layout.fileEditor) === "program";
    const uiScaleNow = uiScale(layout.uiScale);
    const tileIconNow = tileIconScale(layout.tileIconScale);
    const usageLayout: UsageLayout = layout.usageLayout === "all" ? "all" : "tabs";
    const usageShare: UsageShare = layout.usageShare === "transcripts" ? "transcripts" : "cost";
    const linkHint = t(
      linkClick === "browser" ? "settings.linkClickHintBrowser" : linkClick === "none" ? "settings.linkClickHintNone" : "settings.linkClickHintDesk",
    );
    // A section of a group. `row`: the whole section is one search hit
    // ("header": found by its header alone); otherwise its lines are.
    const section = (head: string, body: string, row: "" | "row" | "header" = ""): string =>
      `<section data-section${row === "header" ? ' data-row="header"' : row ? " data-row" : ""}>${head ? `<h3>${head}</h3>` : ""}${body}</section>`;
    const panes: [Group, string][] = [
      [
        "general",
        section(
          "",
          `<label class="line" data-row>${t("settings.language")} <select data-k="language">${LANGUAGES.map(
            (l) => `<option value="${l.id}" ${language() === l.id ? "selected" : ""}>${l.name}</option>`,
          ).join("")}</select></label>
      <label class="line" data-row><input type="checkbox" data-k="notify" ${layout.notifications ? "checked" : ""}/> ${t("settings.notify")}</label>`,
        ) +
          section(
            t("settings.updates"),
            `<div class="line" data-row><span class="dim">desk <span data-k="version"></span> · ${t("settings.updatesHow", { minutes: UPDATE_EVERY_MS / 60_000 })}</span> <button data-k="update">${t("settings.checkNow")}</button></div>
      <div class="line" data-row data-k="update-status">${updateStatusHtml(this.ctx.updates())}</div>`,
          ),
      ],
      [
        "look",
        section(
          t("settings.uiScale"),
          `<div class="line" data-row><span class="seg">${UI_SCALES.map(
            (v) => `<button class="${uiScaleNow === v ? "sel" : ""}" data-ui-scale="${v}">${Math.round(v * 100)}%</button>`,
          ).join("")}</span> <span class="dim">${t("settings.uiScaleHint")}</span></div>`,
        ) +
          section(
            t("settings.tileIconScale"),
            `<div class="line" data-row><span class="seg">${TILE_ICON_SCALES.map(
              (v) => `<button class="${tileIconNow === v ? "sel" : ""}" data-tile-icon-scale="${v}">${Math.round(v * 100)}%</button>`,
            ).join("")}</span> <span class="dim">${t("settings.tileIconScaleHint")}</span></div>`,
          ) +
          section(
          t("settings.theme"),
          `<div class="themes">${THEMES.map(
            (t) => `<button class="theme ${t.id === (layout.theme || DEFAULT_THEME) ? "sel" : ""}" data-theme="${t.id}" style="background:${t.bg};color:${t.fg}">
          <span class="swatches">${[1, 2, 3, 4, 5].map((i) => `<i style="background:${t.ansi[i]}"></i>`).join("")}</span>${escapeHtml(t.name)}</button>`,
          ).join("")}</div>`,
          "row",
        ) +
          section(
            t("settings.terminalSection"),
            `<label class="line" data-row>${t("settings.font")} <input type="number" min="8" max="24" step="0.5" value="${layout.fontSize}" data-k="font" /> px <span class="dim">(${t("settings.fontHint")})</span></label>`,
          ),
      ],
      [
        "window",
        section(
          "",
          `<label class="line" data-row><input type="checkbox" data-k="auto-layout" ${layout.autoLayout ? "checked" : ""}/> ${t("settings.autoLayout")} <span class="dim">${t("settings.autoLayoutHint")}</span></label>
      <label class="line" data-row>${t("settings.lanes")} <input type="number" min="1" max="8" value="${layout.lanes.length}" data-k="lanes" ${layout.autoLayout ? "disabled" : ""}/></label>
      <div class="line" data-row><span>${t("settings.filesPanel")}</span><span class="seg">${(
        [
          ["side", t("settings.filesPanelSide")],
          ["window", t("settings.filesPanelWindow")],
        ] as const
      )
        .map(([v, label]) => `<button class="${(layout.filesWindow ? "window" : "side") === v ? "sel" : ""}" data-files-window="${v}">${label}</button>`)
        .join("")}</span></div>
      <div class="line" data-row><span>${t("settings.treeSide")}</span><span class="seg">${(
        [
          ["left", t("settings.treeSideLeft")],
          ["right", t("settings.treeSideRight")],
        ] as const
      )
        .map(([v, label]) => `<button class="${(layout.treeLeft ? "left" : "right") === v ? "sel" : ""}" data-tree-side="${v}">${label}</button>`)
        .join("")}</span></div>`,
        ) +
          section(
            t("settings.dropdown"),
            `<label class="line" data-row><input type="checkbox" data-k="dropdown" ${layout.dropdown ? "checked" : ""}/> ${t("settings.dropdownOn", { hotkey: escapeHtml(hotkey) })}</label>
      <p class="dim small" data-row>${t("settings.dropdownAbout", { hotkey: escapeHtml(hotkey) })}</p>
      <label class="line" data-row>${t("settings.height")} <input type="number" min="20" max="100" step="5" value="${layout.dropdownHeight}" data-k="dropdown-height" ${off}/> ${t("settings.heightUnit")} <span class="dim">${t("settings.heightHint")}</span></label>
      <label class="line" data-row>${t("settings.animation")} <input type="number" min="0" max="1000" step="50" value="${layout.dropdownAnimation}" data-k="dropdown-animation" ${off}/> ms <span class="dim">${t("settings.animationHint")}</span></label>
      <label class="line" data-row><input type="checkbox" data-k="dropdown-autohide" ${layout.dropdownAutohide ? "checked" : ""} ${off}/> ${t("settings.autohide")}</label>`,
          ),
      ],
      [
        "terminal",
        section(
          t("settings.links"),
          `<div class="line" data-row><span>${t("settings.linkClick")}</span><span class="seg">${(
            [
              ["desk", t("settings.linkClickDesk")],
              ["browser", t("settings.linkClickBrowser")],
              ["none", t("settings.linkClickNone")],
            ] as const
          )
            .map(([v, label]) => `<button class="${linkClick === v ? "sel" : ""}" data-link-click="${v}">${label}</button>`)
            .join("")}</span><span class="dim">${linkHint}</span></div>
      <label class="line" data-row>${t("settings.browser")} <select data-k="browser">${[
        ["auto", t("settings.browserAuto")],
        ["brave", "Brave"],
        ["chrome", "Chrome"],
        ["system", t("settings.browserSystem")],
      ]
        .map(([v, label]) => `<option value="${v}" ${(layout.browser || "auto") === v ? "selected" : ""}>${label}</option>`)
        .join("")}</select></label>
      <div class="line wrap" data-row><span>${t("settings.fileEditor")}</span><span class="seg">${(
        [
          ["builtin", t("settings.fileEditorBuiltin")],
          ["program", t("settings.fileEditorProgram")],
        ] as const
      )
        .map(([v, label]) => `<button class="${program ? (v === "program" ? "sel" : "") : v === "builtin" ? "sel" : ""}" data-file-editor="${v}">${label}</button>`)
        .join("")}</span>${
        program
          ? `<input type="text" data-k="file-editor" value="${escapeHtml(layout.fileEditor)}" placeholder="subl" spellcheck="false" />`
          : ""
      }<span class="dim">${t("settings.fileEditorHint")}</span><div class="field-err" data-k="file-editor-err" hidden></div></div>`,
        ) +
          section(
            t("settings.terminalSection"),
            `<label class="line" data-row><input type="checkbox" data-k="tmux-menu" ${layout.tmuxMenu ? "checked" : ""}/> ${t("settings.tmuxMenu")} <span class="dim">${t("settings.tmuxMenuHint")}</span></label>`,
          ),
      ],
      [
        "projects",
        section(
          `${t("settings.autostart")} <span class="dim">(${auto.size})</span>`,
          `<input type="text" class="filter" placeholder="${t("settings.filter")}" value="${escapeHtml(this.filter)}" data-k="filter" spellcheck="false" />
      <div class="checks">${
        list.length
          ? list
              .map(
                (r) => `<label class="${r.parent ? "child" : ""}"><input type="checkbox" data-auto="${escapeHtml(r.project.path)}" ${
                  auto.has(r.project.path) ? "checked" : ""
                }/> <b>${escapeHtml(r.project.name)}</b> <span class="dim">${escapeHtml(shortPath(r.project.path, this.ctx.home()))}</span></label>`,
              )
              .join("")
          : `<div class="dim">${t("common.searchingProjects")}</div>`
      }</div>`,
          "header",
        ) +
          section(
            t("settings.folders"),
            `<div class="folders">${layout.extraFolders
              .map(
                (f) => `<div class="folder"><span>${escapeHtml(shortPath(f, this.ctx.home()))}</span><button data-rm="${escapeHtml(f)}">${t("common.remove")}</button></div>`,
              )
              .join("")}<button data-k="add">${t("settings.addFolder")}</button></div>`,
            "row",
          ),
      ],
      [
        "claude",
        section(
          `${t("settings.accounts")} <span class="dim">${t("settings.accountsHint")}</span>`,
          `<p class="dim small">${t("settings.accountsAbout")}</p>
      <div class="accounts">${this.accountRows(layout)
        .map(
          (a, i) => `<div class="account-row"><i class="acct" style="background:${accountColor(layout, a.id)}"></i><input type="text" data-acct-name="${escapeHtml(
            a.id,
          )}" value="${escapeHtml(a.name)}" spellcheck="false" /> <span class="dim">${escapeHtml(a.dir || t("settings.accountDefaultDir"))}</span> <span class="dim" data-acct-email="${escapeHtml(
            a.id,
          )}"></span>${i > 0 ? ` <button data-rm-acct="${escapeHtml(a.id)}">${t("common.remove")}</button>` : ""}</div>`,
        )
        .join("")}
        <div class="line"><input type="text" data-k="acct-name" placeholder="${t("settings.accountName")}" spellcheck="false" /><input type="text" data-k="acct-dir" placeholder="${t(
          "settings.accountDir",
        )}" spellcheck="false" /><button data-k="acct-add">${t("settings.accountAdd")}</button></div>
      </div>`,
          "row",
        ) +
          section(
            `${t("settings.agents")} <span class="dim">${t("settings.agentsHint")}</span>`,
            `<div class="agents">${this.ctx
              .agents()
              .map(
                (a) => `<div class="agent-row"><b>${escapeHtml(a.id)}</b> <span class="dim">${escapeHtml(a.command || "login shell")}</span> ${
                  a.installed
                    ? `<span class="tag open">${t("settings.agentInstalled")}</span>`
                    : a.installable
                      ? `<span class="tag">${t("common.installsOnOpen")}</span>`
                      : `<span class="tag">${t("settings.agentMissing")}</span>`
                }${a.builtin ? "" : ` <button data-rm-agent="${escapeHtml(a.id)}">${t("common.remove")}</button>`}</div>`,
              )
              .join("")}
        <div class="line"><input type="text" data-k="agent-id" placeholder="${t("settings.agentId")}" spellcheck="false" /><input type="text" data-k="agent-cmd" placeholder="${t("settings.agentCommand")}" spellcheck="false" /><button data-k="agent-add">${t("settings.addAgent")}</button></div>
      </div>`,
            "row",
          ) +
          section(
            `${t("settings.promptAi")} <span class="dim">${t("settings.promptAiHint")}</span>`,
            `<div class="prompt-ai">
      <label class="line"><input type="checkbox" data-k="prompt-ai-on" ${layout.promptAi?.enabled ? "checked" : ""}/> ${t("settings.promptAiOn")}</label>
      <label class="line">${t("settings.promptAiUrl")} <input type="text" data-k="prompt-ai-url" value="${escapeHtml(layout.promptAi?.url ?? "")}" placeholder="http://host:port/v1" spellcheck="false" /></label>
      <label class="line">${t("settings.promptAiModel")} <input type="text" data-k="prompt-ai-model" value="${escapeHtml(layout.promptAi?.model ?? "")}" spellcheck="false" /></label>
      <label class="line col">${t("settings.promptAiVpn")} <span class="dim" data-k="prompt-ai-vpn-status"></span>
        <textarea data-k="prompt-ai-vpn" rows="3" spellcheck="false" placeholder="${t("settings.promptAiVpnHint")}"></textarea></label>
      <div class="line"><button data-k="prompt-ai-vpn-save">${t("settings.promptAiVpnSave")}</button><button data-k="prompt-ai-vpn-rm" hidden>${t("settings.promptAiVpnRemove")}</button><span class="vpn-error" data-k="prompt-ai-vpn-error"></span></div>
      </div>`,
            "row",
          ),
      ],
      [
        "stats",
        section(
          "",
          `<p class="dim small">${t("settings.statsAbout")}</p>
      <div class="line" data-row><span>${t("settings.usageLayout")}</span><span class="seg">${(
        [
          ["tabs", t("settings.usageLayoutTabs")],
          ["all", t("settings.usageLayoutAll")],
        ] as const
      )
        .map(([v, label]) => `<button class="${usageLayout === v ? "sel" : ""}" data-usage-layout="${v}">${label}</button>`)
        .join("")}</span></div>
      <div class="line" data-row><span>${t("settings.usageShare")}</span><span class="seg">${(
        [
          ["cost", t("settings.usageShareCost")],
          ["transcripts", t("settings.usageShareTranscripts")],
        ] as const
      )
        .map(([v, label]) => `<button class="${usageShare === v ? "sel" : ""}" data-usage-share="${v}">${label}</button>`)
        .join("")}</span><span class="dim">${t(usageShare === "transcripts" ? "settings.usageShareHintTranscripts" : "settings.usageShareHintCost")}</span></div>`,
        ),
      ],
      [
        "power",
        section(
          `${t("settings.coffee")} <span class="dim">(${escapeHtml(keyText("coffee"))})</span>`,
          `<div class="line dim" data-row>${t("settings.coffeeGuard")} ${
            this.ctx.coffee().helperInstalled
              ? `${t("settings.coffeeHelper")} <button data-k="coffee-rm">${t("settings.coffeeRemove")}</button>`
              : t("settings.coffeeAsk")
          }</div>`,
        ) +
          section(t("settings.thermal"), this.thermalHtml(layout)) +
          section(t("settings.cpuPanel"), partsHtml(layout.cpuHidden, PLATFORM)),
      ],
      [
        "docker",
        section(
          "",
          `<p class="dim small" data-row>${t("settings.dockerAbout")}</p>
      <div class="docker-hosts">
        <div data-k="docker-rows">${draftRows(this.dockerDraft, layout.dockerHosts ?? []).map((h) => this.dockerRowHtml(h)).join("")}</div>
        <div class="line"><button data-k="docker-add">${t("settings.dockerAdd")}</button><button data-k="docker-save">${t("settings.dockerSave")}</button><span class="vpn-error" data-k="docker-error"></span></div>
      </div>`,
          "row",
        ),
      ],
      ...(PLATFORM === "windows"
        ? []
        : [
            [
              "upload",
              section(
                "",
                `<p class="dim small" data-row>${t("settings.uploadAbout")}</p>
      <div class="docker-hosts upload-hosts">
        <div data-k="upload-rows">${uploadDraftRows(this.uploadDraft, layout.uploadHosts ?? []).map((h) => this.uploadRowHtml(h)).join("")}</div>
        <datalist id="upload-hosts">${this.uploadOptionsHtml()}</datalist>
        <div class="line"><button data-k="upload-add">${t("settings.uploadAdd")}</button><button data-k="upload-save">${t("settings.uploadSave")}</button><span class="vpn-error" data-k="upload-error"></span></div>
      </div>`,
                "row",
              ),
            ] as [Group, string],
          ]),
      [
        "keys",
        section("", `<p class="dim small" data-row>${t("settings.keysAbout")}</p>`) +
          `<div class="shortcut-list">${section(
            "Dropdown",
            `<div class="shortcut" data-row>${this.keyButton("dropdown", hotkey, off)}<span>${t("settings.dropdownKey")}${
              layout.dropdown ? "" : ` <span class="dim">${t("settings.dropdownKeyOff")}</span>`
            }${
              layout.dropdownHotkey && layout.dropdownHotkey !== DEFAULT_HOTKEY()
                ? ` <button class="reset" data-unbind="dropdown" title="${t("settings.default")}">↺</button>`
                : ""
            }</span></div>`,
          )}${GROUPS.map((group) =>
            section(
              escapeHtml(groupLabel(group)),
              BINDINGS.filter((b) => b.group === group && !(b.id === "upload" && PLATFORM === "windows"))
                .map(
                  (b) =>
                    `<div class="shortcut" data-row>${this.keyButton(b.id, keyText(b.id) || t("settings.noKey"))}<span>${escapeHtml(bindingLabel(b.id))}${
                      keyText(b.id) ? ` <button class="reset" data-remove="${b.id}" title="${t("settings.removeKey")}">×</button>` : ""
                    }${
                      b.id in layout.keys ? ` <button class="reset" data-unbind="${b.id}" title="${t("settings.default")}">↺</button>` : ""
                    }</span></div>`,
                )
                .join("") +
                FIXED.filter((f) => f.group === group)
                  .map(
                    (f) =>
                      `<div class="shortcut" data-row><kbd>${escapeHtml(shortcut(f.keys))}</kbd><span>${escapeHtml(t(f.label))} <span class="dim">${t("settings.fixed")}</span></span></div>`,
                  )
                  .join(""),
            ),
          ).join("")}</div>` +
          section("", `<p class="dim small" data-row>${t("settings.escNote")}</p>`),
      ],
    ];
    // Every group is in the page (the hidden ones too), so every field keeps its listener.
    box.innerHTML = `
      <div class="settings-head"><h2>${t("settings.title")}</h2><input type="text" class="search" data-k="search" placeholder="${t(
        "settings.search",
      )}" value="${escapeHtml(this.query)}" spellcheck="false" /></div>
      <div class="settings-body">
      <nav class="settings-nav">${panes
        .map(
          ([id]) =>
            `<button class="tab ${this.tab === id ? "sel" : ""}" data-tab="${id}"><span>${t(GROUP_NAMES[id])}</span><span class="count"></span></button>`,
        )
        .join("")}</nav>
      <div class="settings-panes"><p class="dim" data-k="search-none" hidden>${t("settings.searchNone")}</p>${panes
        .map(
          ([id, html]) =>
            `<div class="pane" data-pane="${id}" ${this.tab === id ? "" : "hidden"}><h2 class="pane-title">${t(GROUP_NAMES[id])}</h2>${html}</div>`,
        )
        .join("")}</div>
      </div>
      <p class="dim small settings-foot">${t("settings.where", { path: escapeHtml(shortPath(this.ctx.layoutPath(), this.ctx.home())), sessions: "tmux -L desk ls" })}</p>`;

    box.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((b) =>
      b.addEventListener("click", () => {
        this.tab = b.dataset.tab as Group;
        this.recording = null;
        this.query = "";
        this.render();
        box.querySelector(".settings-panes")!.scrollTop = 0;
      }),
    );

    const panesEl = box.querySelector<HTMLElement>(".settings-panes")!;
    const field = box.querySelector<HTMLInputElement>('[data-k="search"]')!;
    field.addEventListener("input", () => {
      this.query = field.value;
      this.applySearch();
      panesEl.scrollTop = 0;
    });
    if (caret !== null) {
      field.focus();
      field.setSelectionRange(caret, caret);
    }
    this.applySearch();
    panesEl.scrollTop = scroll;

    const filter = box.querySelector<HTMLInputElement>('[data-k="filter"]')!;
    filter.addEventListener("input", () => {
      this.filter = filter.value;
      const pos = filter.selectionStart;
      this.render();
      const again = this.el?.querySelector<HTMLInputElement>('[data-k="filter"]');
      again?.focus();
      again?.setSelectionRange(pos, pos);
    });
    box.querySelector<HTMLInputElement>('[data-k="lanes"]')!.addEventListener("change", (e) => {
      this.ctx.setLaneCount(Number((e.target as HTMLInputElement).value));
      this.render();
    });
    box.querySelectorAll<HTMLButtonElement>("[data-theme]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setTheme(b.dataset.theme!);
        this.render();
      }),
    );
    void getVersion().then((v) => {
      const el = this.el?.querySelector('[data-k="version"]');
      if (el) el.textContent = v;
    });
    box.querySelector<HTMLButtonElement>('[data-k="update"]')!.addEventListener("click", async (e) => {
      const b = e.target as HTMLButtonElement;
      b.disabled = true;
      b.textContent = t("settings.checking");
      await this.ctx.checkUpdate();
      b.disabled = false;
      b.textContent = t("settings.checkNow");
    });
    this.bindUpdate(box);
    box.querySelector<HTMLInputElement>('[data-k="font"]')!.addEventListener("change", (e) => {
      const px = Number((e.target as HTMLInputElement).value);
      if (px > 0) this.ctx.setFontSize(px);
    });
    box.querySelector<HTMLInputElement>('[data-k="dropdown"]')!.addEventListener("change", async (e) => {
      await this.ctx.setDropdown({ dropdown: (e.target as HTMLInputElement).checked });
      this.render();
    });
    box.querySelector<HTMLInputElement>('[data-k="dropdown-height"]')!.addEventListener("change", (e) => {
      const pct = Number((e.target as HTMLInputElement).value);
      if (pct >= 20 && pct <= 100) void this.ctx.setDropdown({ dropdownHeight: Math.round(pct) });
    });
    box.querySelectorAll<HTMLButtonElement>("[data-record]").forEach((b) =>
      b.addEventListener("click", () => {
        this.recording = this.recording === b.dataset.record ? null : b.dataset.record!;
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach((b) =>
      b.addEventListener("click", () => {
        this.recording = null;
        this.ctx.setKey(b.dataset.remove!, ""); // no key at all, until ↺ or a new one
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-unbind]").forEach((b) =>
      b.addEventListener("click", async () => {
        this.recording = null;
        const id = b.dataset.unbind!;
        if (id === "dropdown") await this.ctx.setDropdown({ dropdownHotkey: DEFAULT_HOTKEY() });
        else this.ctx.setKey(id, null);
        this.render();
      }),
    );
    box.querySelector<HTMLInputElement>('[data-k="dropdown-animation"]')!.addEventListener("change", (e) => {
      const ms = Number((e.target as HTMLInputElement).value);
      if (ms >= 0 && ms <= 1000) void this.ctx.setDropdown({ dropdownAnimation: Math.round(ms) });
    });
    box.querySelector<HTMLInputElement>('[data-k="dropdown-autohide"]')!.addEventListener("change", (e) => {
      void this.ctx.setDropdown({ dropdownAutohide: (e.target as HTMLInputElement).checked });
    });
    box.querySelector<HTMLSelectElement>('[data-k="language"]')!.addEventListener("change", (e) => {
      this.ctx.setLanguage((e.target as HTMLSelectElement).value as Language);
      this.render();
    });
    box.querySelectorAll<HTMLButtonElement>("[data-tile-icon-scale]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setTileIconScale(tileIconScale(Number(b.dataset.tileIconScale)));
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-ui-scale]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setUiScale(uiScale(Number(b.dataset.uiScale)));
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-usage-layout]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setUsageLayout(b.dataset.usageLayout === "all" ? "all" : "tabs");
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-usage-share]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setUsageShare(b.dataset.usageShare === "transcripts" ? "transcripts" : "cost");
        this.render();
      }),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-link-click]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setLinkClick(b.dataset.linkClick as LinkClick);
        this.render();
      }),
    );
    box.querySelector<HTMLSelectElement>('[data-k="browser"]')!.addEventListener("change", (e) => {
      this.ctx.setBrowser((e.target as HTMLSelectElement).value);
    });
    box.querySelectorAll<HTMLButtonElement>("[data-file-editor]").forEach((b) =>
      b.addEventListener("click", () => {
        this.fileEditorProgram = b.dataset.fileEditor === "program";
        if (!this.fileEditorProgram) this.ctx.setFileEditor("");
        this.render();
      }),
    );
    const fileEditor = box.querySelector<HTMLInputElement>('[data-k="file-editor"]');
    fileEditor?.addEventListener("change", () => void this.saveFileEditor(fileEditor, box));
    // desk redraws Options once the switch is done (a file that does not save keeps the old place).
    box.querySelectorAll<HTMLButtonElement>("[data-files-window]").forEach((b) =>
      b.addEventListener("click", () => this.ctx.setFilesWindow(b.dataset.filesWindow === "window")),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-tree-side]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.setTreeLeft(b.dataset.treeSide === "left");
        this.render();
      }),
    );
    box.querySelector<HTMLInputElement>('[data-k="auto-layout"]')!.addEventListener("change", (e) => {
      this.ctx.setAutoLayout((e.target as HTMLInputElement).checked);
      this.render();
    });
    box.querySelector<HTMLInputElement>('[data-k="notify"]')!.addEventListener("change", (e) => {
      this.ctx.setNotifications((e.target as HTMLInputElement).checked);
    });
    this.bindThermal(box);
    this.bindCpuPanel(box);
    box.querySelector<HTMLInputElement>('[data-k="tmux-menu"]')!.addEventListener("change", (e) => {
      this.ctx.setTmuxMenu((e.target as HTMLInputElement).checked);
    });
    box.querySelector<HTMLInputElement>('[data-k="prompt-ai-on"]')!.addEventListener("change", (e) => {
      this.ctx.setPromptAi({ enabled: (e.target as HTMLInputElement).checked });
    });
    for (const [k, field] of [
      ["prompt-ai-url", "url"],
      ["prompt-ai-model", "model"],
    ] as const) {
      box.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[data-k="${k}"]`)!.addEventListener("change", (e) => {
        this.ctx.setPromptAi({ [field]: (e.target as HTMLInputElement).value.trim() });
      });
    }
    this.bindVpn(box);
    this.bindDocker(box);
    if (box.querySelector('[data-k="upload-rows"]')) this.bindUpload(box);
    box.querySelectorAll<HTMLInputElement>("[data-auto]").forEach((cb) =>
      cb.addEventListener("change", () => this.ctx.toggleAutostart(cb.dataset.auto!)),
    );
    box.querySelectorAll<HTMLButtonElement>("[data-rm]").forEach((b) =>
      b.addEventListener("click", () => {
        this.ctx.removeFolder(b.dataset.rm!);
        void this.reload();
      }),
    );
    box.querySelector<HTMLButtonElement>('[data-k="coffee-rm"]')?.addEventListener("click", async () => {
      await this.ctx.uninstallCoffee();
      this.render();
    });
    this.bindAccounts(box);
    box.querySelectorAll<HTMLButtonElement>("[data-rm-agent]").forEach((b) =>
      b.addEventListener("click", async () => {
        await this.ctx.removeAgent(b.dataset.rmAgent!);
        this.render();
      }),
    );
    box.querySelector<HTMLButtonElement>('[data-k="agent-add"]')!.addEventListener("click", async () => {
      const id = box.querySelector<HTMLInputElement>('[data-k="agent-id"]')!.value.trim().toLowerCase();
      const cmd = box.querySelector<HTMLInputElement>('[data-k="agent-cmd"]')!.value.trim();
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || !cmd) return;
      await this.ctx.addAgent(id, cmd);
      this.render();
    });
    box.querySelector<HTMLButtonElement>('[data-k="add"]')!.addEventListener("click", async () => {
      await this.ctx.addFolder();
      await this.reload();
    });
  }
}
