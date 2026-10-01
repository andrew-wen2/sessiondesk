import { describe, expect, it } from "vitest";
import { aucOf, spearman } from "./eval-difficulty-judge-lib";

describe("spearman", () => {
  it("is 1 for monotone, -1 for reversed, and handles ties", () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 2], [1, 2, 3, 4])).toBeCloseTo(0.894, 3);
  });
});

describe("aucOf", () => {
  it("counts ties as half", () => {
    expect(aucOf([1, 2], [3, 4])).toBe(1);
    expect(aucOf([1], [1])).toBe(0.5);
    expect(aucOf([], [1])).toBeNaN();
  });
});
