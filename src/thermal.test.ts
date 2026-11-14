import { beforeEach, describe, expect, it } from "vitest";
import type { FanStatus, ThermalStatus } from "./api";
import { setLanguage, t } from "./i18n";
import {
  addStep,
  clampFanMargin,
  clampLimit,
  FAN_WAITS,
  fanChart,
  modeOptions,
  slowing,
  stepRpm,
  stepsProblem,
  thermalHtml,
  thermalLevel,
  thermalTitle,
  thermalToast,
} from "./thermal";

const at = (celsius: number | null, more: Partial<ThermalStatus> = {}): ThermalStatus => ({
  celsius,
  limit: 75,
  slowed: false,
  processes: 0,
  cannotSlow: null,
  fanSteps: [],
  fanStep: null,
  fanMargin: 7,
  fans: null,
  ...more,
});

const fan = (more: Partial<FanStatus> = {}): FanStatus => ({ percent: null, rpm: 0, maxRpm: 6800, problem: null, ...more });
const forced = fan({ percent: 100, rpm: 6800 });
const ONE = [{ celsius: 70, percent: 100 }];
const S3 = [
  { celsius: 65, percent: 50 },
  { celsius: 72, percent: 70 },
  { celsius: 80, percent: 100 },
];

describe("the way down", () => {
  it("keeps the margin within what Options offers", () => {
    expect([clampFanMargin(0), clampFanMargin(40), clampFanMargin(Number.NaN), clampFanMargin(4.6)]).toEqual([2, 15, 7, 5]);
    expect(FAN_WAITS).toEqual([15, 30, 60, 120, 300]);
  });
});

describe("temperature chip", () => {
  beforeEach(() => setLanguage("pl"));

  it("shows degrees, yellow near the limit, red at it", () => {
    expect(thermalLevel(at(55))).toBe("");
    expect(thermalLevel(at(66))).toBe("warm");
    expect(thermalLevel(at(75))).toBe("hot");
    const html = thermalHtml(at(62));
    expect(html).toContain(">62°</button>");
    expect(html).toContain('class="top-btn thermal"');
    expect(html).toContain("Powyżej 75°C");
  });

  it("marks slowing with an arrow and says how many processes", () => {
    const s = at(82, { slowed: true, processes: 5 });
    expect(slowing(s)).toBe(true);
    const html = thermalHtml(s);
    expect(html).toContain(">82° ↓</button>");
    expect(html).toContain("thermal hot");
    expect(html).toContain("5 procesów");
    expect(html).toContain("68°C");
  });

  it("hot but nothing to slow, or slowing impossible: no arrow, the reason in the title", () => {
    expect(thermalHtml(at(82, { slowed: true }))).toContain(">82°</button>");
    const html = thermalHtml(at(82, { slowed: true, cannotSlow: "systemd (no bus)" }));
    expect(html).toContain("systemd (no bus)");
    expect(html).not.toContain("↓");
  });

  it("nothing without a sensor, unless the system says it is too hot", () => {
    expect(thermalHtml(null)).toBe("");
    expect(thermalHtml(at(null))).toBe("");
    expect(thermalHtml(at(null, { slowed: true, processes: 2 }))).toContain(">🌡 ↓</button>");
  });

  it("mode off: still shows the temperature, and says desk does nothing", () => {
    const html = thermalHtml(at(70, { limit: 0 }));
    expect(html).toContain(">70°</button>");
    expect(html).toContain("nic nie robi");
  });

  it("limits typed in Options stay sensible", () => {
    expect([10, 50, 72.6, 100, 300, NaN].map(clampLimit)).toEqual([50, 50, 73, 100, 100, 75]);
  });

  it("shows the percent desk set in the chip", () => {
    expect(thermalHtml(at(78, { fanSteps: ONE, fanStep: 0, fans: forced }))).toContain(">78° ≋ 100%</button>");
    const s = at(74, { fanSteps: S3, fanStep: 1, fans: fan({ percent: 70, rpm: 4800 }) });
    expect(thermalHtml(s)).toContain(">74° ≋ 70%</button>");
    const slowed = at(86, { fanSteps: S3, fanStep: 2, fans: fan({ percent: 100 }), slowed: true, processes: 2 });
    expect(thermalHtml(slowed)).toContain(">86° ≋ 100% ↓</button>");
    // Wanted but not set (no permission): no ≋.
    expect(thermalHtml(at(74, { fanSteps: S3, fanStep: 1, fans: fan({ problem: "x" }) }))).toContain(">74°</button>");
  });

  it("is hot with the fans on, and warms up relative to the lowest active limit", () => {
    expect(thermalLevel(at(61, { limit: 0, fanSteps: ONE, fans: fan() }))).toBe("warm");
    expect(thermalLevel(at(50, { fanSteps: ONE, fanStep: 0, fans: forced }))).toBe("hot");
    expect(thermalLevel(at(56, { limit: 85, fanSteps: S3, fans: fan() }))).toBe("warm");
    expect(thermalLevel(at(50, { limit: 85, fanSteps: S3, fans: fan({ percent: 50 }) }))).toBe("hot");
  });

  it("says the step, the speed, and when it changes", () => {
    const title = thermalTitle(at(74, { limit: 85, fanSteps: S3, fanStep: 1, fans: fan({ percent: 70, maxRpm: 6800 }) }));
    for (const part of ["2", "3", "70%", "4760", "80°C", "100%"]) expect(title).toContain(part);
    // Row 2's margin (65°C) meets the first limit: straight back to macOS.
    expect(title).toContain("W dół: auto poniżej 65°C.");
    const wide = [
      { celsius: 60, percent: 50 },
      { celsius: 75, percent: 80 },
    ];
    expect(thermalTitle(at(76, { fanSteps: wide, fanStep: 1, fans: fan({ percent: 80 }) }))).toContain(
      "W dół: przy 68°C → 50%, auto poniżej 60°C.",
    );
    // The margin from Options, not a fixed 7°C.
    expect(thermalTitle(at(76, { fanSteps: wide, fanStep: 1, fanMargin: 3, fans: fan({ percent: 80 }) }))).toContain(
      "W dół: przy 72°C → 50%, auto poniżej 60°C.",
    );
    const top = thermalTitle(at(78, { fanSteps: ONE, fanStep: 0, fans: forced }));
    expect(top).toContain("6800");
    expect(top).toContain("auto poniżej 70°C");
    expect(thermalTitle(at(74, { fanSteps: S3, fanStep: 1, fans: fan({ problem: "x-why" }) }))).toContain("x-why");
    const fansOnly = thermalTitle(at(60, { limit: 0, fanSteps: [{ celsius: 75, percent: 100 }], fans: fan() }));
    expect(fansOnly.startsWith("Procesor: 60°C.")).toBe(true);
    expect(fansOnly).toContain("75°C");
    expect(thermalTitle(at(70, { limit: 0 }))).toContain("nic nie robi");
  });
});

describe("fan steps", () => {
  beforeEach(() => setLanguage("pl"));

  it("checks a table before it is saved", () => {
    expect(stepsProblem(S3)).toBeNull();
    expect(
      stepsProblem([
        { celsius: 72, percent: 50 },
        { celsius: 65, percent: 70 },
      ]),
    ).toBe("settings.fanStepsOrder");
    expect(
      stepsProblem([
        { celsius: 65, percent: 70 },
        { celsius: 72, percent: 50 },
      ]),
    ).toBe("settings.fanStepsSpeed");
    expect(stepsProblem([{ celsius: 7, percent: 50 }])).toBe("settings.fanStepsRange");
    expect(stepsProblem([{ celsius: 70.5, percent: 50 }])).toBe("settings.fanStepsRange");
  });

  it("adds a step above the last one, at most four", () => {
    expect(addStep([{ celsius: 65, percent: 50 }])).toEqual([
      { celsius: 65, percent: 50 },
      { celsius: 71, percent: 60 },
    ]);
    expect(addStep([{ celsius: 98, percent: 100 }])[1]).toEqual({ celsius: 100, percent: 100 });
    const four = [...S3, { celsius: 90, percent: 100 }];
    expect(addStep(four)).toEqual(four);
  });

  it("turns a percent into rpm", () => {
    expect(stepRpm(70, 6800)).toBe(4760);
    expect(stepRpm(50, null)).toBeNull();
  });

  it("draws the steps", () => {
    const c = fanChart(S3, 85, 74, 7);
    // 35% at the bottom (y 108), 100% at the top (y 18).
    expect(c.line).toBe("M 192.4 108 V 87.2 H 263.5 V 59.5 H 344.8 V 18 H 548");
    expect(c.ticks).toEqual([
      { percent: 100, y: 18 },
      { percent: 70, y: 59.5 },
      { percent: 40, y: 101.1 },
    ]);
    expect(c.autoWidth).toBe(152.4);
    expect(c.slowX).toBe(395.6);
    expect(c.nowX).toBe(283.8);
    expect(fanChart(S3, 0, null, 7)).toMatchObject({ slowX: null, nowX: null });
  });

  it("draws the way down: each step the margin lower, never below the first limit", () => {
    // 72 − 7 meets the first limit (65): from step 2 straight to auto.
    expect(fanChart(S3, 0, null, 7).down).toBe("M 192.4 108 V 87.2 H 192.4 V 59.5 H 273.7 V 18 H 548");
    expect(fanChart(S3, 0, null, 3).down).toBe("M 192.4 108 V 87.2 H 233 V 59.5 H 314.3 V 18 H 548");
  });
});

describe("temperature toasts", () => {
  beforeEach(() => setLanguage("pl"));
  const cool = at(70, { fanSteps: ONE, fans: fan() });
  const hotFans = at(72, { fanSteps: ONE, fanStep: 0, fans: forced });
  const hotBoth = at(80, { fanSteps: ONE, fanStep: 0, fans: forced, slowed: true, processes: 3 });

  it("fans on, fans off, and the two together", () => {
    expect(thermalToast(cool, hotFans)).toBe(t("thermal.fansOn", { c: 72, percent: 100 }));
    expect(thermalToast(cool, hotBoth)).toBe(t("thermal.slowingFans", { c: 80, percent: 100 }));
    expect(thermalToast(hotFans, at(62, { fanSteps: ONE, fans: fan() }))).toBe(t("thermal.fansOff", { c: 62 }));
    expect(thermalToast(hotBoth, at(62, { fanSteps: ONE, fans: fan() }))).toBe(t("thermal.cooledFans", { c: 62 }));
  });

  it("toasts when the fans start and stop, not on every step", () => {
    const a = at(72, { fanSteps: S3, fanStep: 1, fans: fan({ percent: 70 }) });
    const b = at(81, { fanSteps: S3, fanStep: 2, fans: fan({ percent: 100 }) });
    expect(thermalToast(at(60, { fanSteps: S3, fans: fan() }), a)).toBe(t("thermal.fansOn", { c: 72, percent: 70 }));
    expect(thermalToast(a, b)).toBeNull();
    expect(thermalToast(b, at(57, { fanSteps: S3, fans: fan() }))).toBe(t("thermal.fansOff", { c: 57 }));
  });

  it("no toast when the fans stop because the mode dropped them", () => {
    expect(thermalToast(hotFans, at(72, { fanSteps: [], fans: null }))).toBeNull();
  });

  it("a new problem once", () => {
    const stuck = at(72, { fanSteps: ONE, fanStep: 0, fans: fan({ problem: "brak zgody" }) });
    expect(thermalToast(cool, stuck)).toBe(t("thermal.fansProblem", { why: "brak zgody" }));
    expect(thermalToast(stuck, stuck)).toBeNull();
  });

  it("slowing alone as before", () => {
    expect(thermalToast(at(70), at(80, { slowed: true, processes: 2 }))).toBe(t("thermal.slowing", { c: 80 }));
    expect(thermalToast(at(80, { slowed: true, processes: 2 }), at(66))).toBe(t("thermal.cooled", { c: 66 }));
  });
});

describe("modes in Options", () => {
  beforeEach(() => setLanguage("pl"));
  const why = (info: Parameters<typeof modeOptions>[0]) => modeOptions(info).map((o) => [o.mode, o.why]);

  it("fan modes are greyed out where desk cannot drive the fans", () => {
    expect(why({ unsupported: "u", consent: "missing", maxRpm: null })).toEqual([
      ["off", null],
      ["slow", null],
      ["together", "u"],
      ["fans", "u"],
    ]);
    expect(why(null).filter(([, w]) => w === t("fans.unknown")).length).toBe(2);
    expect(why({ unsupported: null, consent: "installed", maxRpm: 6800 }).every(([, w]) => w === null)).toBe(true);
  });
});
