import { beforeEach, describe, expect, it } from "vitest";
import type { CoffeeStatus } from "./api";
import { setLanguage } from "./i18n";
import { brandHtml, browserHtml, coffeeHtml, settingsHtml } from "./topbar";

const coffee = (more: Partial<CoffeeStatus> = {}): CoffeeStatus => ({
  level: "off",
  helperInstalled: true,
  sleepDisabled: false,
  stoppedBecause: null,
  ...more,
});

const EMOJI = /\p{Extended_Pictographic}/u;
/** What the button shows: its text, without tags and their titles. */
const shown = (html: string) => html.replace(/<[^>]*>/g, "");

describe("top bar tools", () => {
  beforeEach(() => setLanguage("pl"));

  it("draws the browser button as a line icon in a chip, named for screen readers", () => {
    const html = browserHtml("⌘W");
    expect(html).toMatch(/^<button class="top-btn icon" data-top="browser"/);
    expect(html).toContain('aria-label="Przeglądarka"');
    expect(html).toContain("(⌘W)");
    expect(html).toContain('<svg viewBox="0 0 12 12" aria-hidden="true">');
    expect(shown(html)).not.toMatch(EMOJI);
  });

  it("draws the Options button as a gear icon with its shortcut", () => {
    const html = settingsHtml("⌘O");
    expect(html).toMatch(/^<button class="top-btn icon" data-top="settings"/);
    expect(html).toContain('aria-label="Opcje"');
    expect(html).toContain('title="Opcje (⌘O)"');
    expect(html).toContain('<svg viewBox="0 0 12 12" aria-hidden="true">');
    expect(shown(html)).not.toMatch(EMOJI);
    expect(settingsHtml("")).toContain('title="Opcje"');
  });

  it("shows coffee off as the cup alone, named for screen readers", () => {
    const html = coffeeHtml(coffee(), "mac");
    expect(html).toMatch(/^<button class="top-btn coffee off icon" data-coffee="cycle"/);
    expect(html).toContain('aria-label="Kawa"');
    expect(html).toContain("<svg");
    expect(shown(html)).not.toMatch(EMOJI);
  });

  it("says coffee is on with the cup and a word", () => {
    const awake = coffeeHtml(coffee({ level: "awake" }), "mac");
    expect(awake).toContain('class="top-btn coffee awake with-icon"');
    expect(awake).toMatch(/<\/svg>kawa<\/button>$/);
    const lid = coffeeHtml(coffee({ level: "lid" }), "mac");
    expect(lid).toContain('class="top-btn coffee lid with-icon"');
    expect(lid).toMatch(/<\/svg>kawa · klapka<\/button>$/);
    expect(shown(awake + lid)).not.toMatch(EMOJI);
  });

  it("warns on a Mac without the helper that the lid step asks for the password", () => {
    expect(coffeeHtml(coffee({ level: "awake", helperInstalled: false }), "mac")).toContain("macOS raz zapyta o hasło");
    expect(coffeeHtml(coffee({ level: "awake", helperInstalled: false }), "linux")).not.toContain("hasło");
  });

  it("offers to restore sleep left disabled, before the cup", () => {
    const html = coffeeHtml(coffee({ sleepDisabled: true }), "mac");
    expect(html).toMatch(/^<button class="top-btn coffee warn" data-coffee="restore"[^>]*>sen wyłączony · przywróć<\/button><button class="top-btn coffee off icon"/);
    expect(coffeeHtml(coffee({ level: "lid", sleepDisabled: true }), "mac")).not.toContain('data-coffee="restore"');
  });

  it("speaks English too", () => {
    setLanguage("en");
    expect(browserHtml("Ctrl+W")).toContain('aria-label="Browser"');
    expect(settingsHtml("")).toContain('aria-label="Options"');
    expect(coffeeHtml(coffee(), "linux")).toContain('aria-label="Coffee"');
    expect(coffeeHtml(coffee({ level: "lid" }), "linux")).toMatch(/<\/svg>coffee · lid<\/button>$/);
  });
});

describe("the name in the top bar", () => {
  it("shows the version next to it, in small print", () => {
    expect(brandHtml("0.2.4", "")).toBe('<span class="brand">desk</span><span class="brand-version">0.2.4</span>');
  });

  it("shows the name alone until the version is known", () => {
    expect(brandHtml(null, "")).toBe('<span class="brand">desk</span>');
  });

  it("drags the window by the version too, unless docked", () => {
    const drag = " data-tauri-drag-region";
    expect(brandHtml("0.2.4", drag)).toBe(
      `<span class="brand"${drag}>desk</span><span class="brand-version"${drag}>0.2.4</span>`,
    );
  });

  it("escapes the version", () => {
    expect(brandHtml("<1>", "")).toContain('<span class="brand-version">&#60;1&#62;</span>');
  });
});
