import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { bellHtml, clock, historyHtml, noticeHtml, Notices, NOTICE_MS, KEPT } from "./notices";

const AT = new Date(2026, 10, 15, 21, 14).getTime();

describe("notices", () => {
  beforeEach(() => setLanguage("pl"));

  it("keeps an error until it is closed, and lets the rest go after their kind's time", () => {
    const n = new Notices();
    expect(n.add("Nie udało się", { kind: "error", ms: 8000 }, AT).ms).toBeNull();
    expect(n.add("Skopiowano", { kind: "ok" }, AT).ms).toBe(NOTICE_MS.ok);
    expect(n.add("Procesor ma 84°C", { kind: "warn" }, AT).ms).toBe(NOTICE_MS.warn);
    expect(n.add("Klonuję…", undefined, AT)).toMatchObject({ kind: "info", ms: NOTICE_MS.info });
    // The old toast(message, ms) still works: an info that stays as long as asked.
    expect(n.add("Brak tmux", 15000, AT)).toMatchObject({ kind: "info", ms: 15000 });
    expect(NOTICE_MS.ok! < NOTICE_MS.info! && NOTICE_MS.info! < NOTICE_MS.warn!).toBe(true);
  });

  it("lists the newest first and keeps only the last ones", () => {
    const n = new Notices();
    for (let i = 0; i < KEPT + 5; i++) n.add(`m${i}`, undefined, AT + i);
    expect(n.all()).toHaveLength(KEPT);
    expect(n.all()[0].text).toBe(`m${KEPT + 4}`);
    expect(n.all()[KEPT - 1].text).toBe("m5");
  });

  it("counts the warnings and errors you may have missed, not your own confirmations", () => {
    const n = new Notices();
    n.add("Skopiowano", { kind: "ok" }, AT);
    n.add("Sesja zakończona", { kind: "info" }, AT);
    expect(n.state()).toEqual({ total: 2, count: 0, error: false });
    n.add("Procesor ma 84°C", { kind: "warn" }, AT);
    expect(n.state()).toEqual({ total: 3, count: 1, error: false });
    const err = n.add("Nie udało się", { kind: "error" }, AT);
    expect(n.state()).toEqual({ total: 4, count: 2, error: true });
    n.seen(err.id); // closed by hand: you saw it
    expect(n.state()).toEqual({ total: 4, count: 1, error: false });
    n.seenAll(); // the history opened
    expect(n.state()).toEqual({ total: 4, count: 0, error: false });
    n.clear();
    expect(n.state()).toEqual({ total: 0, count: 0, error: false });
  });

  it("tells its listeners about every change", () => {
    const n = new Notices();
    let calls = 0;
    const off = n.onChange(() => calls++);
    const a = n.add("x", { kind: "warn" }, AT);
    n.seen(a.id);
    n.seenAll();
    n.clear();
    off();
    n.add("y", undefined, AT);
    expect(calls).toBe(4);
  });

  it("draws an error card that stays, says it out loud and offers to copy it", () => {
    const n = new Notices().add('Dropdown: <tak> "nie"', { kind: "error" }, AT);
    const html = noticeHtml(n);
    expect(html).toMatch(new RegExp(`^<div class="notice error" data-notice="${n.id}" role="alert">`));
    expect(html).toContain("Dropdown: &#60;tak&#62; &#34;nie&#34;");
    expect(html).toContain("data-notice-copy>Kopiuj błąd</button>");
    expect(html).toContain('aria-label="Zamknij"');
    expect(html).not.toContain("notice-timer");
  });

  it("draws a timed card with its time left and its action", () => {
    const n = new Notices().add("Sesja aurora-shop zakończona", { kind: "info", action: { label: "Przywróć", run: () => {} } }, AT);
    const html = noticeHtml(n);
    expect(html).toContain('class="notice info"');
    expect(html).toContain('role="status"');
    expect(html).toContain("data-notice-act>Przywróć</button>");
    expect(html).not.toContain("data-notice-copy");
    expect(html).toContain(`<span class="notice-timer" style="animation-duration:${NOTICE_MS.info}ms"></span>`);
  });

  it("lists the history with the time, newest first, and what can still be done", () => {
    const n = new Notices();
    n.add("Skopiowano do schowka", { kind: "ok" }, AT - 12 * 60_000);
    n.add("Sesja aurora-shop zakończona", { kind: "info", action: { label: "Przywróć", run: () => {} } }, AT);
    n.add("tmux: no server running", { kind: "error" }, AT);
    const html = historyHtml(n.all());
    expect(html).toContain("<b>Komunikaty</b>");
    expect(html).toContain("data-notice-clear>Wyczyść</button>");
    const rows = [...html.matchAll(/<div class="notice-row (\w+)[^"]*" data-notice="\d+"><span class="notice-time">(\d\d:\d\d)<\/span>/g)].map((m) => `${m[1]} ${m[2]}`);
    expect(rows).toEqual(["error 21:14", "info 21:14", "ok 21:02"]);
    expect(html).toContain("data-notice-copy>Kopiuj błąd</button>");
    expect(html).toContain("data-notice-act>Przywróć</button>");
  });

  it("shows the bell only with a history, with what you missed and a dot for an error", () => {
    expect(bellHtml({ total: 0, count: 0, error: false })).toBe("");
    const calm = bellHtml({ total: 3, count: 0, error: false });
    expect(calm).toMatch(/^<button class="notice-bell" data-notices-open aria-haspopup="dialog" aria-label="Komunikaty"/);
    expect(calm).not.toContain("notice-dot");
    const missed = bellHtml({ total: 3, count: 2, error: true });
    expect(missed).toContain('class="notice-bell new"');
    expect(missed).toContain('aria-label="Komunikaty: 2"');
    expect(missed).toContain("<span>2</span>");
    expect(missed).toContain('<i class="notice-dot"></i>');
  });

  it("writes the time as hours and minutes", () => {
    expect(clock(new Date(2026, 0, 2, 7, 5).getTime())).toBe("07:05");
  });

  it("speaks English too", () => {
    setLanguage("en");
    const n = new Notices().add("boom", { kind: "error" }, AT);
    expect(noticeHtml(n)).toContain("data-notice-copy>Copy error</button>");
    expect(historyHtml([n])).toContain("<b>Messages</b>");
  });
});
