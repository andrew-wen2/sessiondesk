import { describe, expect, it } from "vitest";
import { diversityStats, effectiveTypes, normalizeGroups, repetitionStats, symmetricEigenvalues, vendiScore, type Item } from "./eval-repetition-lib";

// Two sets of three: set 0 = items 0-2, set 1 = items 3-5.
const items: Item[] = [0, 1, 2, 3, 4, 5].map((i) => ({ set: i < 3 ? 0 : 1, index: i }));

describe("normalizeGroups", () => {
  it("gives every item exactly one group, dropping duplicates and bad indices", () => {
    const g = normalizeGroups([{ type: "a", members: [0, 0, 1, 9] }, { type: "b", members: [1, 2] }], 4);
    expect(g).toEqual([
      { type: "a", members: [0, 1] },
      { type: "b", members: [2] },
      { type: "(ungrouped #3)", members: [3] },
    ]);
  });
});

describe("repetitionStats", () => {
  it("counts repeats inside a set and types shared across sets", () => {
    const s = repetitionStats(items, [
      { type: "shared root", members: [0, 1, 4] }, // twice in set 0, once in set 1
      { type: "work-rate", members: [2, 5] }, // once in each set
      { type: "vieta", members: [3] },
    ]);
    expect(s).toEqual({ sets: 2, problems: 6, types: 3, withinSetRepeats: 1, crossSetRepeatedTypes: 2, crossSetPairs: 2 });
  });
  it("reports no repetition when every problem is its own type", () => {
    expect(repetitionStats(items, [])).toMatchObject({ types: 6, withinSetRepeats: 0, crossSetRepeatedTypes: 0 });
  });
});

describe("diversity scores", () => {
  it("vendi is n for unrelated items and 1 for copies", () => {
    const id = [0, 1, 2, 3].map((i) => [0, 1, 2, 3].map((j) => (i === j ? 1 : 0)));
    expect(vendiScore(id)).toBeCloseTo(4, 6);
    expect(vendiScore([[1, 1, 1], [1, 1, 1], [1, 1, 1]])).toBeCloseTo(1, 6);
  });

  it("vendi of two copies plus one unrelated item sits between 2 and 3", () => {
    // eigenvalues of K/3 are 2/3, 1/3, 0 → exp(H) ≈ 1.89
    expect(vendiScore([[1, 1, 0], [1, 1, 0], [0, 0, 1]])).toBeCloseTo(Math.exp(-(2 / 3) * Math.log(2 / 3) - (1 / 3) * Math.log(1 / 3)), 6);
  });

  it("eigenvalues of a known symmetric matrix", () => {
    const e = symmetricEigenvalues([[2, 1], [1, 2]]).sort((a, b) => a - b);
    expect(e[0]).toBeCloseTo(1, 9);
    expect(e[1]).toBeCloseTo(3, 9);
  });

  it("effective types reads as a type count", () => {
    expect(effectiveTypes([1, 1, 1, 1])).toBeCloseTo(4, 9);
    expect(effectiveTypes([2, 2])).toBeCloseTo(2, 9);
    expect(effectiveTypes([4])).toBeCloseTo(1, 9);
  });

  it("per-set and pooled type diversity", () => {
    // set 0: types A, A, B; set 1: types A, C, D
    const groups = [
      { type: "A", members: [0, 1, 3] },
      { type: "B", members: [2] },
      { type: "C", members: [4] },
      { type: "D", members: [5] },
    ];
    const statements = ["a", "b", "c", "d", "e", "f"];
    const d = diversityStats(items, groups, statements, (x, y) => (x === y ? 1 : 0));
    expect(d.statementVendiPerSet).toBeCloseTo(3, 6);
    expect(d.effectiveTypesPerSet).toBeCloseTo((effectiveTypes([2, 1]) + 3) / 2, 9);
    expect(d.effectiveTypesPooled).toBeCloseTo(effectiveTypes([3, 1, 1, 1]), 9);
  });
});
