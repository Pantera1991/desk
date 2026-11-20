import { describe, expect, it } from "vitest";
import { TILE_ICON_SCALES, UI_SCALES, tileIconScale, uiScale } from "./ui-scale";

describe("uiScale", () => {
  it("passes the allowed values through", () => {
    for (const v of UI_SCALES) expect(uiScale(v)).toBe(v);
    expect([...UI_SCALES]).toEqual([0.9, 1, 1.1, 1.25, 1.5]);
  });
  it("falls back to 1 for anything else", () => {
    for (const v of [undefined, null, 0, 2, "1.1", NaN, 1.2]) expect(uiScale(v)).toBe(1);
  });
});

describe("tileIconScale", () => {
  it("passes the allowed values through", () => {
    for (const v of TILE_ICON_SCALES) expect(tileIconScale(v)).toBe(v);
    expect([...TILE_ICON_SCALES]).toEqual([1, 1.25, 1.5, 1.75]);
  });
  it("falls back to 1 for anything else, older layouts included", () => {
    for (const v of [undefined, null, 0, 0.9, 2, "1.5", NaN]) expect(tileIconScale(v)).toBe(1);
  });
});
