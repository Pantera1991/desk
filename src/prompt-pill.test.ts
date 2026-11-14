import { afterEach, describe, expect, it, vi } from "vitest";
import { setLanguage } from "./i18n";
import { draftText, findPromptBox, HOLD, hasDraft, LIFETIME, pillHtml, pillSpot, pillView, rewriteKey, ScreenHold, shortReason } from "./prompt-pill";

const RULE = "─".repeat(60);

/** Claude Code's screen bottom as xterm gives it: the answer, the framed prompt, the mode line. */
function screen(prompt: string[]): string[] {
  return ["⏺ Gotowe, testy przechodzą.", "", RULE, ...prompt, RULE, "", "  ⏵⏵ auto mode on (shift+tab to cycle)"];
}

describe("prompt pill", () => {
  afterEach(() => setLanguage("pl"));

  it("finds Claude's prompt box between the last two rules", () => {
    expect(findPromptBox(screen(["❯ popraw to"]))).toEqual({ top: 2, bottom: 4 });
    expect(findPromptBox(screen(["❯ pierwsza", "  druga"]))).toEqual({ top: 2, bottom: 5 });
    // The older framed box.
    expect(findPromptBox(["╭────────────────────╮", "│ > zrob cos         │", "╰────────────────────╯"])).toEqual({ top: 0, bottom: 2 });
  });

  it("finds no box on screens without Claude's prompt", () => {
    expect(findPromptBox(screen(["  1. Yes", "  2. No"]))).toBeNull();
    expect(findPromptBox(["$ ls", "src  docs"])).toBeNull();
    expect(findPromptBox([RULE, RULE])).toBeNull();
    expect(findPromptBox(["── tytuł ────────────────", "❯ x", RULE])).toBeNull();
  });

  it("reads what is typed, without the marker and the frame", () => {
    expect(draftText(["❯ popraw to   "])).toBe("popraw to");
    expect(draftText(["❯ pierwsza", "  druga", "   "])).toBe("pierwsza\ndruga");
    expect(draftText(["│ > zrob cos         │"])).toBe("zrob cos");
    expect(draftText(["❯ "])).toBe("");
  });

  it("offers a rewrite from three letters, as the CRM", () => {
    expect(hasDraft("ok")).toBe(false);
    expect(hasDraft("12 3!")).toBe(false);
    expect(hasDraft("żół")).toBe(true);
    expect(hasDraft("fix")).toBe(true);
  });

  it("sits where it covers nothing: above the prompt, else inside the box at its right end", () => {
    const pill = 24;
    // The CRM's place: on the top rule at the prompt's text, over an empty row.
    expect(pillSpot(screen(["❯ popraw to"]), { top: 2, bottom: 4 }, pill)).toEqual({ row: 2, col: 2, centered: false });
    // A notice the whole width above the box: into the box, right end of its last row.
    const notice = ["  You've used 93% of your weekly limit · resets Nov 20 at 5am (Europe/Warsaw) · Run /x", RULE, "❯ popraw to", RULE];
    expect(pillSpot(notice, { top: 1, bottom: 3 }, pill)).toEqual({ row: 2, col: 60 - pill - 1, centered: true });
    // A long prompt there too: the right end of the rule, if the notice leaves it.
    const short = ["  Update available", RULE, "❯ " + "x".repeat(58), RULE];
    expect(pillSpot(short, { top: 1, bottom: 3 }, pill)).toEqual({ row: 1, col: 35, centered: false });
    // Everything taken: back to the first place.
    const full = ["y".repeat(60), RULE, "❯ " + "x".repeat(58), RULE];
    expect(pillSpot(full, { top: 1, bottom: 3 }, pill)).toEqual({ row: 1, col: 2, centered: false });
    // The box at the very top: nothing above, so inside the box.
    expect(pillSpot([RULE, "❯ abc", RULE], { top: 0, bottom: 2 }, pill)).toEqual({ row: 1, col: 35, centered: true });
  });

  it("shows the rewrite's phase over the offer", () => {
    expect(pillView(null, null, false)).toBeNull();
    expect(pillView(null, null, true)).toEqual({ kind: "offer" });
    expect(pillView("checking", null, true)).toEqual({ kind: "busy", label: "Poprawiam prompt" });
    expect(pillView("vpn", "vpn.example:51820", false)).toEqual({ kind: "busy", label: "Łączę przez VPN" });
    expect(pillView("applied", null, true)).toEqual({ kind: "applied" });
    expect(pillView("clean", null, true)).toEqual({ kind: "clean" });
    expect(pillView("error", "serwer LLM nie odpowiada", true)).toEqual({ kind: "error", reason: "serwer LLM nie odpowiada" });
    // Finished news goes away by itself; a rewrite that never reports back too.
    expect(LIFETIME.restored).toBeLessThan(LIFETIME.applied);
    expect(LIFETIME.clean).toBe(2_500); // as the CRM's "Bez błędów"
    expect(LIFETIME.checking).toBeGreaterThan(45_000);
  });

  it("draws the star, the label, BETA and the key or the action", () => {
    const offer = pillHtml({ kind: "offer" });
    expect(offer).toContain('data-pill="rewrite"');
    expect(offer).toContain("Popraw prompt");
    expect(offer).toContain(">Beta<");
    expect(offer).toContain(`<kbd>${rewriteKey()}</kbd>`);
    const applied = pillHtml({ kind: "applied" });
    expect(applied).toContain("Poprawiono prompt");
    expect(applied).toContain('data-pill="undo"');
    expect(applied).toContain('data-pill="dismiss"');
    expect(pillHtml({ kind: "busy", label: "Poprawiam prompt" })).not.toContain("<button");
    // Nothing changed: said in green, nothing to undo.
    const clean = pillHtml({ kind: "clean" });
    expect(clean).toContain('class="label ok"');
    expect(clean).toContain("Nic do poprawy");
    expect(clean).not.toContain('data-pill="undo"');
    setLanguage("en");
    expect(pillHtml({ kind: "offer" })).toContain("Rewrite prompt");
  });

  it("escapes the server's reason", () => {
    const html = pillHtml({ kind: "error", reason: '<img src=x onerror="alert(1)">' });
    expect(html).not.toContain("<img");
    expect(html).toContain("Prompt bez zmian: &#60;img");
  });

  it("keeps curl's details for the tooltip, the pill says the gist", () => {
    const reason = "serwer LLM nie odpowiada (curl: (7) Failed to connect to 10.0.0.5 port 8000)";
    expect(shortReason(reason)).toBe("serwer LLM nie odpowiada");
    expect(shortReason("model zgubił treść promptu")).toBe("model zgubił treść promptu");
    const html = pillHtml({ kind: "error", reason });
    expect(html).toContain(">Prompt bez zmian: serwer LLM nie odpowiada<");
    expect(html).toContain('title="Prompt bez zmian: serwer LLM nie odpowiada (curl: (7)');
  });

  it("names the key as the platform has it", () => {
    expect(rewriteKey("mac")).toBe("⌘G");
    expect(rewriteKey("linux")).toBe("Ctrl+G");
    expect(rewriteKey("windows")).toBe("Ctrl+G");
  });
});

describe("screen hold", () => {
  const bytes = (s: string) => new TextEncoder().encode(s);
  const text = (chunks: Uint8Array[]) => chunks.map((c) => new TextDecoder().decode(c)).join("");

  function setup() {
    const written: Uint8Array[] = [];
    const changes: [boolean, boolean][] = [];
    const hold = new ScreenHold(
      (d) => written.push(d),
      (held, news) => changes.push([held, news]),
    );
    return { hold, written, changes };
  }

  afterEach(() => vi.useRealTimers());

  it("passes output through when nothing is held", () => {
    const { hold, written } = setup();
    hold.data(bytes("abc"));
    expect(text(written)).toBe("abc");
  });

  it("keeps the frame through the rewrite and writes Claude's clear and redraw at once", () => {
    vi.useFakeTimers();
    const { hold, written, changes } = setup();
    hold.start();
    hold.data(bytes("\x1b[2J\x1b[H")); // Claude clears its screen for the editor
    hold.status("checking");
    vi.advanceTimersByTime(10_000); // the model takes its time: still held
    expect(written).toEqual([]);
    hold.status("vpn");
    hold.status("applied");
    hold.data(bytes("❯ Cel: Napraw zapis.")); // Claude draws itself again
    vi.advanceTimersByTime(HOLD.quiet - 1);
    expect(written).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(text(written)).toBe("\x1b[2J\x1b[H❯ Cel: Napraw zapis.");
    expect(changes).toEqual([
      [true, false],
      [false, true],
    ]);
  });

  it("lets go after a while when Claude keeps drawing (a spinner never goes quiet)", () => {
    vi.useFakeTimers();
    const { hold, written } = setup();
    hold.start();
    hold.status("error");
    for (let i = 0; i < 20; i++) {
      hold.data(bytes("."));
      vi.advanceTimersByTime(100);
    }
    expect(text(written).length).toBeGreaterThan(0);
    expect(hold.held).toBe(false);
  });

  it("lets go when Ctrl+G started nothing, and says no news came", () => {
    vi.useFakeTimers();
    const { hold, written, changes } = setup();
    hold.start();
    hold.data(bytes("redraw"));
    vi.advanceTimersByTime(HOLD.firstNews);
    expect(text(written)).toBe("redraw");
    expect(changes[changes.length - 1]).toEqual([false, false]);
  });

  it("drops what it held when the terminal goes away", () => {
    vi.useFakeTimers();
    const { hold, written } = setup();
    hold.start();
    hold.data(bytes("x"));
    hold.cancel();
    vi.advanceTimersByTime(HOLD.firstNews);
    expect(written).toEqual([]);
  });
});
