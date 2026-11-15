import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import type { Update } from "./api";
import { UPDATE_EVERY_MS, UpdateChecker, announce, updateDue, updateStatusHtml, type UpdateStatus } from "./updates";

const NEW = { version: "0.2.4", url: "https://github.com/knehrybecki/desk/releases/tag/v0.2.4", installable: true };
const IDLE: UpdateStatus = { update: null, checkedAt: null, error: null, checking: false };
const AT = new Date(2026, 10, 15, 14, 5).getTime();
const MIN = 60_000;

describe("update checks", () => {
  it("ask GitHub right after start, then every 30 minutes", () => {
    expect(UPDATE_EVERY_MS).toBe(30 * MIN);
    expect(updateDue(null, AT)).toBe(true);
    expect(updateDue(AT, AT + 29 * MIN)).toBe(false);
    expect(updateDue(AT, AT + 30 * MIN)).toBe(true);
  });

  it("catch up after a laptop slept, and when the clock went back", () => {
    expect(updateDue(AT, AT + 5 * 60 * MIN)).toBe(true);
    expect(updateDue(AT, AT - MIN)).toBe(true);
  });

  it("announce each new version once, also across restarts", () => {
    expect(announce(null, null)).toBe(false);
    expect(announce(NEW, null)).toBe(true);
    expect(announce(NEW, "0.2.4")).toBe(false);
    expect(announce(NEW, "0.2.3")).toBe(true);
  });
});

describe("the Options line about updates", () => {
  beforeEach(() => setLanguage("pl"));

  it("offers a new version with its install button", () => {
    const html = updateStatusHtml({ ...IDLE, update: NEW, checkedAt: AT });
    expect(html).toContain("Dostępna nowa wersja desk 0.2.4");
    expect(html).toContain('<button data-k="update-install">Zainstaluj</button>');
  });

  it("opens the release page where desk cannot install it itself", () => {
    expect(updateStatusHtml({ ...IDLE, update: { ...NEW, installable: false } })).toContain(
      '<button data-k="update-install">Otwórz stronę</button>',
    );
  });

  it("keeps a found version while checking again or after a failed check", () => {
    expect(updateStatusHtml({ ...IDLE, update: NEW, checking: true })).toContain("Dostępna nowa wersja desk 0.2.4");
    expect(updateStatusHtml({ ...IDLE, update: NEW, error: "offline" })).toContain("Dostępna nowa wersja desk 0.2.4");
  });

  it("says this desk is the latest and when it checked", () => {
    expect(updateStatusHtml({ ...IDLE, checkedAt: AT })).toContain("Masz najnowszą wersję (sprawdzono o 14:05)");
  });

  it("says why it could not check", () => {
    const html = updateStatusHtml({ ...IDLE, checkedAt: AT, error: "brak gh (GitHub CLI) <x>" });
    expect(html).toContain('class="error"');
    expect(html).toContain("Nie udało się sprawdzić: brak gh (GitHub CLI) &#60;x&#62;");
  });

  it("shows a check under way, and none made yet", () => {
    expect(updateStatusHtml({ ...IDLE, checking: true })).toContain("sprawdzam…");
    expect(updateStatusHtml(IDLE)).toContain("Jeszcze nie sprawdzono");
  });

  it("speaks English too", () => {
    setLanguage("en");
    expect(updateStatusHtml({ ...IDLE, update: NEW })).toContain("New version available: desk 0.2.4");
    expect(updateStatusHtml({ ...IDLE, checkedAt: AT })).toContain("You have the latest version (checked at 14:05)");
  });
});

/** A checker over a fake GitHub and clock; `saved` is what localStorage would keep. */
function setup(saved: string | null = null) {
  const world = { now: AT, saved, asks: 0, answer: null as Update | null | Error, changes: [] as UpdateStatus[] };
  let release: () => void = () => undefined;
  let hold = false;
  const checker = new UpdateChecker({
    ask: () => {
      world.asks++;
      const answer = world.answer;
      const settle = () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer));
      if (!hold) return settle();
      return new Promise<void>((r) => (release = r)).then(settle);
    },
    now: () => world.now,
    load: () => world.saved,
    save: (v) => (world.saved = v),
    changed: (s) => world.changes.push({ ...s }),
  });
  return { world, checker, holdAnswers: () => (hold = true), release: () => release() };
}

describe("the update checker", () => {
  it("asks right after start, then not again for 30 minutes", async () => {
    const { world, checker } = setup();
    expect(await checker.tick()).toEqual({ kind: "latest" });
    world.now += 29 * MIN;
    expect(await checker.tick()).toBeNull();
    world.now += MIN;
    expect(await checker.tick()).toEqual({ kind: "latest" });
    expect(world.asks).toBe(2);
    expect(checker.status).toEqual({ update: null, checkedAt: AT + 30 * MIN, error: null, checking: false });
  });

  it("announces a new version once, then only knows it", async () => {
    const { world, checker } = setup();
    world.answer = NEW;
    expect(await checker.tick()).toEqual({ kind: "news", update: NEW });
    expect(world.saved).toBe("0.2.4");
    world.now += 30 * MIN;
    expect(await checker.tick()).toEqual({ kind: "known", update: NEW });
    expect(await checker.check()).toEqual({ kind: "known", update: NEW });
  });

  it("does not announce again after a restart, but still shows the version", async () => {
    const { world, checker } = setup("0.2.4");
    world.answer = NEW;
    expect(await checker.tick()).toEqual({ kind: "known", update: NEW });
    expect(checker.status.update).toEqual(NEW);
  });

  it("keeps a version found before when a later check fails, until one succeeds", async () => {
    const { world, checker } = setup();
    world.answer = NEW;
    await checker.tick();
    world.now += 30 * MIN;
    world.answer = new Error("offline");
    expect(await checker.tick()).toEqual({ kind: "failed", error: "Error: offline" });
    expect(checker.status).toMatchObject({ update: NEW, error: "Error: offline", checking: false, checkedAt: AT });
    world.now += 30 * MIN;
    world.answer = null;
    await checker.tick();
    expect(checker.status).toMatchObject({ update: null, error: null });
  });

  it("waits half an hour after a failed check too", async () => {
    const { world, checker } = setup();
    world.answer = new Error("brak gh (GitHub CLI)");
    await checker.tick();
    world.now += 10 * MIN;
    expect(await checker.tick()).toBeNull();
    expect(world.asks).toBe(1);
  });

  it("asks once when you click Check now during a check", async () => {
    const { world, checker, holdAnswers, release } = setup();
    world.answer = NEW;
    holdAnswers();
    const timed = checker.tick();
    const clicked = checker.check();
    expect(await checker.tick()).toBeNull(); // the minute's look skips a check under way
    release();
    expect(await timed).toEqual({ kind: "news", update: NEW });
    expect(await clicked).toEqual({ kind: "known", update: NEW });
    expect(world.asks).toBe(1);
  });

  it("tells about the check starting and ending", async () => {
    const { world, checker } = setup();
    world.answer = NEW;
    await checker.tick();
    expect(world.changes.map((s) => s.checking)).toEqual([true, false]);
    expect(world.changes[world.changes.length - 1]).toEqual({ update: NEW, checkedAt: AT, error: null, checking: false });
  });
});
