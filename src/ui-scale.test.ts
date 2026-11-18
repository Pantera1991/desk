import { describe, expect, it } from "vitest";
import { UI_SCALES, uiScale } from "./ui-scale";

describe("uiScale", () => {
  it("passes the allowed values through", () => {
    for (const v of UI_SCALES) expect(uiScale(v)).toBe(v);
    expect([...UI_SCALES]).toEqual([0.9, 1, 1.1, 1.25, 1.5]);
  });
  it("falls back to 1 for anything else", () => {
    for (const v of [undefined, null, 0, 2, "1.1", NaN, 1.2]) expect(uiScale(v)).toBe(1);
  });
});
