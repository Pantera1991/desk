import { beforeEach, describe, expect, it } from "vitest";
import type { CpuDetails, ThermalStatus } from "./api";
import { CPU_PARTS, type CpuPart } from "./cpu-parts";
import { leftBy } from "./cpu-popover";
import { historyChart, renderCpu, SLOTS, tileLabel } from "./cpu-view";
import { setLanguage } from "./i18n";

const status = (more: Partial<ThermalStatus> = {}): ThermalStatus => ({
  celsius: 68,
  limit: 75,
  slowed: false,
  processes: 0,
  cannotSlow: null,
  fanSteps: [],
  fanStep: null,
  fanMargin: 7,
  fans: null,
  emergency: 0,
  halted: false,
  frozen: 0,
  jobs: 0,
  hottest: null,
  cores: null,
  haltedBy: null,
  sees: "cpu",
  ...more,
});

const T0 = Date.UTC(2026, 10, 15, 9, 0, 0) / 1000;
const details = (more: Partial<CpuDetails> = {}): CpuDetails => ({
  cores: 11,
  load: [3.34, 2.5, 1.25],
  history: [
    { at: T0, user: 10, system: 5 },
    { at: T0 + 5, user: 14, system: 85 },
  ],
  top: [
    { pid: 900, name: "yes", percent: 84.6, session: null },
    { pid: 910, name: "sh", percent: 78.3, session: { path: "/p/shop", agent: "claude", instance: 1 } },
  ],
  busiest: { path: "/p/shop", agent: "claude", instance: 1, percent: 78, program: "sh" },
  ...more,
});

const view = (more: Partial<Parameters<typeof renderCpu>[0]> = {}) =>
  renderCpu({ details: details(), status: status(), colors: null, nowMs: T0 * 1000, ...more });

describe("the temperature chip's panel", () => {
  beforeEach(() => setLanguage("pl"));

  it("opens with three rings: temperature, CPU use and load, as in the template", () => {
    const html = view();
    expect(html).toContain('class="up cpu"');
    expect(html).toContain("up-nib");
    expect(html.match(/class="cpu-gauge"/g)).toHaveLength(3);
    expect(html).toContain(">68°C</text>");
    expect(html).toContain(">99%</text>");
    expect(html).toContain(">3,34</text>");
    expect(html).toContain("Użycie procesora: 99% (użytkownik 14%, system 85%)");
    // The temperature ring follows the chip's colours: red at the limit.
    expect(view({ status: status({ celsius: 80 }) })).toContain('cpu-arc hot"');
    expect(view({ status: status({ celsius: 50 }), colors: { warm: 45, hot: 60 } })).toContain('cpu-arc warm"');
  });

  it("has the usage history, details, load average and top processes", () => {
    const html = view();
    for (const part of ["Historia użycia", "Szczegóły", "Średnie obciążenie", "Top procesy"]) expect(html).toContain(part);
    expect(html).toContain("Użytkownik</span><b>14%</b>");
    expect(html).toContain("System</span><b>85%</b>");
    expect(html).toContain("Bezczynny</span><b>1%</b>");
    expect(html).toContain("15 minut</span><b>1,25</b>");
    expect(html).toContain('<span class="cpu-name" title="yes (900)">yes</span><b>85%</b>');
    expect(html).toContain("11 rdzeni");
  });

  it("each desk process names its tile, a click away; the busiest tile comes first", () => {
    const html = view();
    expect(html).toContain('data-key="claude#1:/p/shop"');
    expect(html).toContain(">shop · claude #2</button>");
    expect(html).toContain("Najbardziej obciąża karta <b>shop · claude #2</b>: sh, 78%");
    expect(view({ details: details({ busiest: null }) })).toContain("Karty desk nie obciążają teraz procesora.");
    expect(tileLabel({ path: "C:\\work\\api", agent: "shell", instance: 0 })).toBe("api · shell");
  });

  it("without a load average (Windows): two rings and no load section", () => {
    const html = view({ details: details({ load: null }) });
    expect(html.match(/class="cpu-gauge"/g)).toHaveLength(2);
    expect(html).not.toContain("Średnie obciążenie");
  });

  it("still loading: the temperature already, the rest says so", () => {
    const html = view({ details: null });
    expect(html).toContain(">68°C</text>");
    expect(html).toContain(">—</text>");
    expect(html).toContain("wczytuję");
  });

  it("after an emergency stop: what is frozen and the resume button", () => {
    const html = view({ status: status({ celsius: 97, emergency: 95, halted: true, frozen: 4 }) });
    expect(html).toContain('class="cpu-state halted"');
    expect(html).toContain("stoją 4 procesy");
    expect(html).toContain('data-k="cpu-resume"');
    expect(html).toContain("od 90°C");
    // The chip's click hint is not repeated inside.
    expect(html).not.toContain("Kliknij:");
  });
});

describe("parts hidden in Options", () => {
  beforeEach(() => setLanguage("pl"));
  const head = (name: string) => `<span>${name}</span></h4>`;
  const marks: Record<CpuPart, string> = {
    gauges: 'class="cpu-gauges"',
    state: 'class="cpu-state',
    history: head("Historia użycia"),
    details: head("Szczegóły"),
    load: head("Średnie obciążenie"),
    top: head("Top procesy"),
  };

  it("details off: no details, everything else as before", () => {
    const html = view({ hidden: ["details"] });
    expect(html).not.toContain(marks.details);
    expect(html).not.toContain("Bezczynny");
    for (const part of CPU_PARTS.filter((p) => p !== "details")) expect(html, part).toContain(marks[part]);
  });

  it("each part goes on its own", () => {
    for (const part of CPU_PARTS) {
      const html = view({ hidden: [part] });
      expect(html, part).not.toContain(marks[part]);
      for (const other of CPU_PARTS.filter((p) => p !== part)) expect(html, `${part} hid ${other}`).toContain(marks[other]);
    }
    // The top processes take the busiest tile with them.
    expect(view({ hidden: ["top"] })).not.toContain("Najbardziej obciąża");
  });

  it("after an emergency stop the state and its resume button stay, hidden or not", () => {
    expect(view({ hidden: ["state"] })).not.toContain(marks.state);
    const halted = view({ hidden: ["state"], status: status({ celsius: 97, emergency: 95, halted: true, frozen: 4 }) });
    expect(halted).toContain('class="cpu-state halted"');
    expect(halted).toContain('data-k="cpu-resume"');
  });

  it("all hidden: it says so, and the way to Options stays", () => {
    const html = view({ hidden: [...CPU_PARTS] });
    expect(html).toContain("Części panelu są ukryte. Włączysz je w Opcjach.");
    expect(html).toContain('data-k="cpu-options"');
    for (const part of CPU_PARTS) expect(html, part).not.toContain(marks[part]);
  });

  it("ids it does not know change nothing", () => {
    expect(view({ hidden: ["sparkline"] })).toBe(view());
  });

  it("top processes shown again before they were read: loading, not 'no tile is busy'", () => {
    const html = view({ details: details({ top: null, busiest: null }) });
    expect(html).toContain(marks.top);
    expect(html).toContain("wczytuję");
    expect(html).not.toContain("Karty desk nie obciążają");
  });
});

describe("usage history", () => {
  beforeEach(() => setLanguage("pl"));

  it("the latest point on the right, each bar saying when and how busy", () => {
    const html = historyChart(details().history);
    const xs = [...html.matchAll(/class="cpu-hit" data-bar x="([\d.]+)"/g)].map((m) => Number(m[1]));
    expect(xs).toHaveLength(2);
    expect(xs[1]).toBeCloseTo((372 / SLOTS) * (SLOTS - 1), 1);
    expect(html).toContain("99% (użytkownik 14%, system 85%)");
    expect(html).toContain("Ostatnie 10 minut, średnio 57%");
    expect(html).toContain("10 min temu");
  });

  it("keeps only the last 10 minutes and says when it has nothing yet", () => {
    const long = Array.from({ length: SLOTS + 30 }, (_, i) => ({ at: T0 + i * 5, user: 1, system: 1 }));
    expect(historyChart(long).match(/cpu-hit/g)).toHaveLength(SLOTS);
    expect(historyChart([])).toContain("Zbieram dane: punkt co 5 s");
  });
});

describe("leaving the panel", () => {
  const el = (chip: boolean) => ({ closest: (sel: string) => (chip && sel.includes("thermal") ? {} : null) });

  it("a click elsewhere closes it; the chip toggles it itself", () => {
    expect(leftBy(el(false), false)).toBe(true);
    expect(leftBy(el(false), true)).toBe(false);
    expect(leftBy(el(true), false)).toBe(false);
    expect(leftBy(null, false)).toBe(false);
  });
});
