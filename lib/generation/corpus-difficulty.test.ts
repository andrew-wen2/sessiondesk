import { describe, expect, it } from "vitest";
import { targetRating, TARGET_SINCE_YEAR } from "./corpus-difficulty";

describe("targetRating", () => {
  it("defines a position by recent contests, which rate harder than 2010–2014 at AMC 10 #10–15", () => {
    const recent = [10, 11, 12, 13, 14, 15].map((n) => targetRating("AMC10", n)!);
    const allYears = [10, 11, 12, 13, 14, 15].map((n) => targetRating("AMC10", n, 0)!);
    const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
    expect(TARGET_SINCE_YEAR).toBe(2015);
    expect(mean(recent)).toBeGreaterThan(mean(allYears));
  });

  it("rises with position and is null where nothing is rated", () => {
    expect(targetRating("AMC10", 20)!).toBeGreaterThan(targetRating("AMC10", 10)!);
    expect(targetRating("AMC10", 99)).toBeNull();
  });
});
