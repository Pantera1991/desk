import { beforeEach, describe, expect, it } from "vitest";
import { setLanguage } from "./i18n";
import { escapeHtml } from "./notices";
import { Latest, editorChoice, headerText, lineMarks, markHtml, moveSelection, rowHtml, seedText } from "./find-view";
import type { GrepHit } from "./api";

beforeEach(() => setLanguage("pl"));

describe("markHtml", () => {
  it("counts marks in UTF-16 units", () => {
    expect(markHtml("zażółć 😀 pre", [[10, 13]])).toBe("zażółć 😀 <mark>pre</mark>");
  });
  it("escapes the text", () => {
    expect(markHtml("<a>&", [[0, 3]])).toBe(`<mark>${escapeHtml("<a>")}</mark>${escapeHtml("&")}`);
  });
  it("clamps out-of-bounds and overlapping ranges", () => {
    expect(markHtml("abcd", [[2, 99]])).toBe("ab<mark>cd</mark>");
    expect(markHtml("abcd", [[0, 3], [2, 4]])).toBe("<mark>abc</mark><mark>d</mark>");
    expect(markHtml("abcd", [[3, 3], [9, 12]])).toBe("abcd");
  });
});

describe("rowHtml", () => {
  const hit: GrepHit = { file: "src/a.php", line: 2, text: "foo", marks: [[0, 3]], cut: 0 };
  it("shows name and line, the path in the title", () => {
    const h = rowHtml(hit, false, 0);
    expect(h).toContain('title="src/a.php"');
    expect(h).toContain(">a.php 2<");
    expect(h).toContain("<mark>foo</mark>");
    expect(h).not.toContain("ff-row sel");
  });
  it("marks the selected row", () => {
    expect(rowHtml(hit, true, 0)).toContain('class="ff-row sel"');
  });
  it("carries the row index", () => {
    expect(rowHtml(hit, false, 7)).toContain('data-i="7"');
  });
});

describe("headerText", () => {
  const res = (n: number, files: number, more = false) => ({
    hits: Array(n).fill({ file: "a", line: 1, text: "", marks: [], cut: 0 }),
    files,
    more,
  });
  it("uses plural forms of hits and files", () => {
    expect(headerText(res(1, 1), null)).toBe("1 trafienie w 1 pliku");
    expect(headerText(res(3, 2), null)).toBe("3 trafienia w 2 plikach");
    expect(headerText(res(5, 5), null)).toBe("5 trafień w 5 plikach");
  });
  it("speaks English", () => {
    setLanguage("en");
    expect(headerText(res(1, 1), null)).toBe("1 match in 1 file");
    expect(headerText(res(2, 3), null)).toBe("2 matches in 3 files");
  });
  it("adds the cap note with the number shown", () => {
    expect(headerText(res(500, 2, true), null)).toBe("500 trafień w 2 plikach (pokazano 500, jest ich więcej)");
    // A timeout may cut the list short of 500.
    expect(headerText(res(37, 2, true), null)).toBe("37 trafień w 2 plikach (pokazano 37, jest ich więcej)");
    expect(headerText(res(5, 2), null)).toBe("5 trafień w 2 plikach");
    setLanguage("en");
    expect(headerText(res(37, 2, true), null)).toBe("37 matches in 2 files (37 shown, there are more)");
  });
  it("returns the error as is, and nothing for null", () => {
    expect(headerText(null, "zły\nregex")).toBe("zły\nregex");
    expect(headerText(null, null)).toBe("");
  });
});

describe("lineMarks", () => {
  it("are the marks as they are when the line was not cut", () => {
    expect(lineMarks({ file: "a", line: 1, text: "ab pre", marks: [[3, 6]], cut: 0 })).toEqual([[3, 6]]);
  });
  it("drop the leading … and add the cut when it was", () => {
    // "…" + 60 units, then the match: 29 940 units were cut before the window.
    expect(lineMarks({ file: "a", line: 1, text: "…x", marks: [[61, 67], [70, 72]], cut: 29_940 })).toEqual([
      [30_000, 30_006],
      [30_009, 30_011],
    ]);
  });
});

describe("seedText", () => {
  it("is a trimmed one-line selection of at most 200 characters", () => {
    expect(seedText("  pre ")).toBe("pre");
    expect(seedText("x".repeat(200))).toBe("x".repeat(200));
    expect(seedText("pre\n")).toBe("pre");
  });
  it("is nothing for no, an empty, a multi-line or a long selection", () => {
    expect(seedText(undefined)).toBeUndefined();
    expect(seedText("   ")).toBeUndefined();
    expect(seedText("a\nb")).toBeUndefined();
    expect(seedText("a\r\nb")).toBeUndefined();
    expect(seedText("x".repeat(201))).toBeUndefined();
  });
});

describe("editorChoice", () => {
  it("is built-in for an empty command, a program otherwise", () => {
    expect(editorChoice("")).toBe("builtin");
    expect(editorChoice("subl")).toBe("program");
  });
});

describe("moveSelection", () => {
  it("clamps", () => {
    expect(moveSelection(0, -1, 5)).toBe(0);
    expect(moveSelection(4, 1, 5)).toBe(4);
    expect(moveSelection(2, 10, 5)).toBe(4);
    expect(moveSelection(0, 1, 0)).toBe(-1);
  });
});

describe("Latest", () => {
  it("only the newest is latest", () => {
    const l = new Latest();
    const a = l.next();
    const b = l.next();
    expect(l.isLatest(a)).toBe(false);
    expect(l.isLatest(b)).toBe(true);
  });
});
