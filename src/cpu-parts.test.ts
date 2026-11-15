import { beforeEach, describe, expect, it } from "vitest";
import { CPU_PARTS, partsFor, partsHtml, showsProcesses, withPart } from "./cpu-parts";
import { setLanguage } from "./i18n";

describe("choosing the CPU panel's parts in Options", () => {
  beforeEach(() => setLanguage("pl"));

  it("a box per part, ticked unless hidden", () => {
    const html = partsHtml(["details"], "mac");
    expect(html.match(/data-cpu-part=/g)).toHaveLength(CPU_PARTS.length);
    expect(html).toContain('data-cpu-part="details" />');
    expect(html).toContain('data-cpu-part="top" checked/>');
    expect(html).toContain("Szczegóły: użytkownik, system, bezczynny");
    expect(html).toContain("Co widać po kliknięciu temperatury");
  });

  it("no load average box on Windows, which keeps none", () => {
    expect(partsFor("windows")).not.toContain("load");
    expect(partsFor("linux")).toContain("load");
    expect(partsHtml([], "windows")).not.toContain('data-cpu-part="load"');
  });

  it("a switch changes its own part only, a newer desk's ids too stay", () => {
    expect(withPart([], "details", false)).toEqual(["details"]);
    expect(withPart(["details", "sparkline"], "details", true)).toEqual(["sparkline"]);
    expect(withPart(["top"], "top", false)).toEqual(["top"]);
  });

  it("the processes are read only while the top processes show", () => {
    expect(showsProcesses([])).toBe(true);
    expect(showsProcesses(["details", "history"])).toBe(true);
    expect(showsProcesses(["top"])).toBe(false);
  });
});
