import { beforeEach, describe, expect, it } from "vitest";
import type { FanStatus, ThermalStatus } from "./api";
import { setLanguage, t } from "./i18n";
import {
  addStep,
  autoColors,
  clampColors,
  clampEmergency,
  clampFanMargin,
  clampLimit,
  emergencyLines,
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
    // 0: a step comes down as soon as the average is below its own limit.
    expect([clampFanMargin(0), clampFanMargin(-3), clampFanMargin(40), clampFanMargin(Number.NaN), clampFanMargin(4.6)]).toEqual([
      0, 0, 15, 7, 5,
    ]);
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
      "W dół: poniżej 68°C → 50%, auto poniżej 60°C.",
    );
    // The margin from Options, not a fixed 7°C.
    expect(thermalTitle(at(76, { fanSteps: wide, fanStep: 1, fanMargin: 3, fans: fan({ percent: 80 }) }))).toContain(
      "W dół: poniżej 72°C → 50%, auto poniżej 60°C.",
    );
    // No margin: down as soon as it is below the step's own limit.
    expect(thermalTitle(at(76, { fanSteps: wide, fanStep: 1, fanMargin: 0, fans: fan({ percent: 80 }) }))).toContain(
      "W dół: poniżej 75°C → 50%, auto poniżej 60°C.",
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
    const c = fanChart(S3, 7, { slow: 85, now: 74 });
    // 35–100°C across, 0–100% up: idle temperatures show left of the first step.
    expect(c.line).toBe("M 274.5 108 V 63 H 329.2 V 45 H 391.7 V 18 H 548");
    expect(c.ticks).toEqual([
      { percent: 100, y: 18 },
      { percent: 50, y: 63 },
      { percent: 0, y: 108 },
    ]);
    expect(c.degrees.map((d) => d.celsius)).toEqual([40, 50, 60, 70, 80, 90, 100]);
    expect(c.degrees[0].x).toBe(79.1);
    expect(c.autoWidth).toBe(234.5);
    expect([c.top, c.bottom, c.height]).toEqual([18, 108, 148]);
  });

  it("labels each line above the chart, with its temperature", () => {
    // Apart: both labels in the one row above the chart, centred on their lines.
    expect(fanChart(S3, 7, { slow: 85, now: 74 }).marks).toEqual([
      { kind: "now", x: 344.8, text: "teraz 74°", labelX: 344.8, labelY: 10, labelWidth: 54.9 },
      { kind: "slow", x: 430.8, text: "zwalnianie 85°", labelX: 430.8, labelY: 10, labelWidth: 85.4 },
    ]);
    expect(fanChart(S3, 7, { now: 48 }).marks.map((m) => [m.kind, m.x])).toEqual([["now", 141.6]]);
    expect(fanChart(S3, 7, { slow: 0, emergency: 0, now: null }).marks).toEqual([]);
    expect(fanChart(S3, 7, {}).marks).toEqual([]);
  });

  it("never lets two labels overlap: the second moves a row down and the chart grows", () => {
    const c = fanChart(S3, 7, { slow: 90, emergency: 95, now: 48 });
    expect(c.marks.map((m) => [m.kind, m.text, m.labelY])).toEqual([
      ["now", "teraz 48°", 10],
      ["slow", "zwalnianie 90°", 10],
      ["emergency", "zatrzymanie 95°", 22],
    ]);
    // One more row: everything below moves 12 down.
    expect([c.top, c.bottom, c.height]).toEqual([30, 120, 160]);
    expect(c.ticks[0]).toEqual({ percent: 100, y: 30 });
    expect(c.line).toBe("M 274.5 120 V 75 H 329.2 V 57 H 391.7 V 30 H 548");
    // The same reading as slowing: two rows, never one label on another.
    expect(fanChart(S3, 7, { slow: 80, now: 80 }).marks.map((m) => m.labelY)).toEqual([10, 22]);
    // Labels in one row keep a gap between them.
    for (const set of [
      { slow: 85, emergency: 95, now: 90 },
      { slow: 60, emergency: 62, now: 64 },
      { slow: 100, emergency: 100, now: 100 },
    ]) {
      const marks = fanChart(S3, 7, set).marks;
      for (const a of marks)
        for (const b of marks) {
          if (a === b || a.labelY !== b.labelY) continue;
          expect(Math.abs(a.labelX - b.labelX)).toBeGreaterThanOrEqual((a.labelWidth + b.labelWidth) / 2 + 6);
        }
    }
  });

  it("keeps labels inside the chart, and a stop above 100°C at the edge with its real value", () => {
    const [stop] = fanChart(S3, 7, { emergency: 105 }).marks;
    expect(stop).toMatchObject({ kind: "emergency", x: 548, text: "zatrzymanie 105°" });
    // Centred as far right as the label fits.
    expect(stop.labelX + stop.labelWidth / 2).toBeLessThanOrEqual(558);
    const [now] = fanChart(S3, 7, { now: 30 }).marks;
    expect(now.x).toBe(40);
    expect(now.labelX - now.labelWidth / 2).toBeGreaterThanOrEqual(2);
  });

  it("draws the way down: each step the margin lower, never below the first limit", () => {
    // 72 − 7 meets the first limit (65): from step 2 straight to auto.
    expect(fanChart(S3, 7, {}).down).toBe("M 274.5 108 V 63 H 274.5 V 45 H 337 V 18 H 548");
    expect(fanChart(S3, 3, {}).down).toBe("M 274.5 108 V 63 H 305.7 V 45 H 368.2 V 18 H 548");
    // No margin: the way down is the way up.
    expect(fanChart(S3, 0, {}).down).toBe(fanChart(S3, 0, {}).line);
  });
});

describe("temperature toasts", () => {
  beforeEach(() => setLanguage("pl"));
  const cool = at(70, { fanSteps: ONE, fans: fan() });
  const hotFans = at(72, { fanSteps: ONE, fanStep: 0, fans: forced });
  const hotBoth = at(80, { fanSteps: ONE, fanStep: 0, fans: forced, slowed: true, processes: 3 });

  it("fans on, fans off, and the two together", () => {
    expect(thermalToast(cool, hotFans)?.text).toBe(t("thermal.fansOn", { c: 72, percent: 100 }));
    expect(thermalToast(cool, hotBoth)?.text).toBe(t("thermal.slowingFans", { c: 80, percent: 100 }));
    expect(thermalToast(hotFans, at(62, { fanSteps: ONE, fans: fan() }))?.text).toBe(t("thermal.fansOff", { c: 62 }));
    expect(thermalToast(hotBoth, at(62, { fanSteps: ONE, fans: fan() }))?.text).toBe(t("thermal.cooledFans", { c: 62 }));
  });

  it("toasts when the fans start and stop, not on every step", () => {
    const a = at(72, { fanSteps: S3, fanStep: 1, fans: fan({ percent: 70 }) });
    const b = at(81, { fanSteps: S3, fanStep: 2, fans: fan({ percent: 100 }) });
    expect(thermalToast(at(60, { fanSteps: S3, fans: fan() }), a)?.text).toBe(t("thermal.fansOn", { c: 72, percent: 70 }));
    expect(thermalToast(a, b)).toBeNull();
    expect(thermalToast(b, at(57, { fanSteps: S3, fans: fan() }))?.text).toBe(t("thermal.fansOff", { c: 57 }));
  });

  it("no toast when the fans stop because the mode dropped them", () => {
    expect(thermalToast(hotFans, at(72, { fanSteps: [], fans: null }))).toBeNull();
  });

  it("a new problem once", () => {
    const stuck = at(72, { fanSteps: ONE, fanStep: 0, fans: fan({ problem: "brak zgody" }) });
    expect(thermalToast(cool, stuck)?.text).toBe(t("thermal.fansProblem", { why: "brak zgody" }));
    expect(thermalToast(stuck, stuck)).toBeNull();
  });

  it("says how much each one matters", () => {
    expect(thermalToast(cool, hotFans)?.kind).toBe("warn");
    expect(thermalToast(cool, hotBoth)?.kind).toBe("warn");
    expect(thermalToast(at(70), at(80, { slowed: true, processes: 2 }))?.kind).toBe("warn");
    expect(thermalToast(cool, at(72, { fanSteps: ONE, fanStep: 0, fans: fan({ problem: "brak zgody" }) }))?.kind).toBe("warn");
    expect(thermalToast(hotFans, at(62, { fanSteps: ONE, fans: fan() }))?.kind).toBe("ok");
    expect(thermalToast(hotBoth, at(62, { fanSteps: ONE, fans: fan() }))?.kind).toBe("ok");
    expect(thermalToast(at(80, { slowed: true, processes: 2 }), at(66))?.kind).toBe("ok");
  });

  it("slowing alone as before", () => {
    expect(thermalToast(at(70), at(80, { slowed: true, processes: 2 }))?.text).toBe(t("thermal.slowing", { c: 80 }));
    expect(thermalToast(at(80, { slowed: true, processes: 2 }), at(66))?.text).toBe(t("thermal.cooled", { c: 66 }));
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

describe("chip colours", () => {
  beforeEach(() => setLanguage("pl"));

  it("desk's own: red from the lowest limit it acts at, yellow 10°C before", () => {
    expect(autoColors([75, 0])).toEqual({ warm: 65, hot: 75 });
    expect(autoColors([85, 70])).toEqual({ warm: 60, hot: 70 });
    expect(autoColors([0, 0])).toEqual({ warm: 65, hot: 75 });
  });

  it("chosen in Options: only the temperature counts", () => {
    const colors = { warm: 80, hot: 90 };
    expect(thermalLevel(at(79), colors)).toBe("");
    expect(thermalLevel(at(80), colors)).toBe("warm");
    expect(thermalLevel(at(90), colors)).toBe("hot");
    // Slowing or the fans no longer turn it red below the chosen range.
    expect(thermalLevel(at(78, { slowed: true, processes: 3 }), colors)).toBe("");
    expect(thermalLevel(at(78, { fanSteps: ONE, fanStep: 0, fans: forced }), colors)).toBe("");
    expect(thermalHtml(at(85), colors)).toContain('class="top-btn thermal warm"');
    // Equal limits: no yellow at all.
    expect(thermalLevel(at(69), { warm: 70, hot: 70 })).toBe("");
    expect(thermalLevel(at(70), { warm: 70, hot: 70 })).toBe("hot");
  });

  it("typed colours stay whole, within range, and yellow never above red", () => {
    expect(clampColors({ warm: 64.6, hot: 300 }, "hot")).toEqual({ warm: 65, hot: 110 });
    expect(clampColors({ warm: 10, hot: 50 }, "warm")).toEqual({ warm: 30, hot: 50 });
    // The one just typed stays, the other follows it.
    expect(clampColors({ warm: 90, hot: 80 }, "warm")).toEqual({ warm: 90, hot: 90 });
    expect(clampColors({ warm: 90, hot: 80 }, "hot")).toEqual({ warm: 80, hot: 80 });
  });
});

describe("emergency stop", () => {
  beforeEach(() => setLanguage("pl"));
  const halted = at(97, { emergency: 95, halted: true, frozen: 12 });

  it("limits typed in Options stay sensible", () => {
    expect([0, 59.4, 60, 95, 110, 300, NaN].map(clampEmergency)).toEqual([60, 60, 60, 95, 110, 110, 90]);
  });

  it("the chip pauses, turns red and gets a resume button", () => {
    const html = thermalHtml(halted, { warm: 100, hot: 105 });
    expect(html).toContain(">97° ⏸</button>");
    expect(html).toContain('class="top-btn thermal hot halted"');
    expect(html).toContain('data-top="thermal-resume"');
    expect(html).toContain("▶ Wznów");
    expect(html).toContain("90°C");
    // Not stopped: no button.
    expect(thermalHtml(at(97, { emergency: 95 }))).not.toContain("thermal-resume");
    // Even without a sensor the stop shows.
    expect(thermalHtml(at(null, { emergency: 95, halted: true }))).toContain(">🌡 ⏸</button>");
  });

  it("the title says where it stops, what it froze and what still runs", () => {
    expect(thermalTitle(at(60, { emergency: 95 }))).toContain("Od 95°C desk awaryjnie zatrzyma");
    const title = thermalTitle({ ...halted, jobs: 2 });
    expect(title).toContain("stoi 12 procesów");
    expect(title).toContain("od 90°C");
    expect(title).toContain("2 programy wpisane w powłoce działają dalej");
    // Mode off but the stop on: not "desk does nothing".
    expect(thermalTitle(at(60, { limit: 0, emergency: 95 }))).not.toContain("nic nie robi");
    expect(thermalTitle(at(60))).not.toContain("awaryjnie");
  });

  it("every title says what a click does", () => {
    for (const s of [at(60), at(60, { limit: 0 }), halted]) expect(thermalTitle(s)).toContain(t("thermal.clickHint"));
  });

  it("a toast when it stops, before anything else that changed, and when it resumes", () => {
    const before = at(94, { emergency: 95, slowed: true, processes: 3 });
    expect(thermalToast(before, { ...halted, slowed: true, processes: 3 })?.text).toBe(
      "Procesor ma 97°C: desk awaryjnie zatrzymał pracę w kartach (12 procesów). Wznów przyciskiem ▶ w górnym pasku.",
    );
    expect(thermalToast(halted, halted)).toBeNull();
    expect(thermalToast(halted, at(88, { emergency: 95 }))?.text).toBe(t("thermal.resumed"));
    // The stop is an error that stays; resuming is good news.
    expect(thermalToast(before, { ...halted, slowed: true, processes: 3 })?.kind).toBe("error");
    expect(thermalToast(halted, at(88, { emergency: 95 }))?.kind).toBe("ok");
  });
  it("the title shows the cores and desk's sensor, or the CPU alone", () => {
    expect(thermalTitle(at(54, { emergency: 90, hottest: 68, cores: 68, sees: "cores" }))).toContain(
      "Awaryjne zatrzymanie od 90°C: rdzenie 68°C, czujnik desk 54°C.",
    );
    expect(thermalTitle(at(54, { emergency: 90, hottest: 54, sees: "cpu" }))).toContain("Awaryjne zatrzymanie od 90°C: procesor 54°C.");
    expect(thermalTitle(at(54, { hottest: null, cores: null }))).not.toContain("Awaryjne");
  });

  it("the toast names the hottest reading, or macOS", () => {
    const hot = at(56, { emergency: 90, halted: true, frozen: 12, hottest: 91, cores: 91, haltedBy: "temperature" });
    expect(thermalToast(at(56, { emergency: 90 }), hot)?.text).toBe(
      "Procesor ma 91°C: desk awaryjnie zatrzymał pracę w kartach (12 procesów). Wznów przyciskiem ▶ w górnym pasku.",
    );
    const sys = { ...hot, haltedBy: "system" as const };
    expect(thermalToast(at(56, { emergency: 90 }), sys)?.text).toBe(
      "macOS zgłosił krytyczną temperaturę: desk awaryjnie zatrzymał pracę w kartach (12 procesów). Wznów przyciskiem ▶ w górnym pasku.",
    );
    expect(thermalToast(at(56, { emergency: 90 }), sys)?.kind).toBe("error");
    expect(thermalTitle(sys)).toContain("Wywołał je macOS");
  });

  it("Options says what the stop watches, and warns when it sees less", () => {
    expect(emergencyLines("cores")).toEqual(["settings.emergencyWatchesCores"]);
    expect(emergencyLines("sensor")).toEqual(["settings.emergencySensorOnly"]);
    expect(emergencyLines("system")).toEqual(["settings.emergencySystemOnly"]);
    expect(emergencyLines("nothing")).toEqual(["settings.emergencyNothing"]);
    expect(emergencyLines("cpu")).toEqual([]);
    expect(emergencyLines(null)).toEqual([]);
  });
});
