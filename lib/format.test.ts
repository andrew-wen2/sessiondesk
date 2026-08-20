import { describe, it, expect } from "vitest";
import { percentChange } from "./format";

describe("percentChange", () => {
  it("rounds a real comparison", () => {
    expect(percentChange(2400, 2220)).toBe(8);
    expect(percentChange(1000, 2000)).toBe(-50);
    expect(percentChange(500, 500)).toBe(0);
  });

  it("returns null rather than dividing by zero", () => {
    // No baseline is not the same as no change. Returning 0 here would render a
    // confident "0%" on a tile whose prior window was simply empty.
    expect(percentChange(900, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
  });
});
