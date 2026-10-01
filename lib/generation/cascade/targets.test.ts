import { describe, expect, it } from "vitest";
import { buildTargetFor, maxNumberFor, stableHash, targetNumbers } from "./targets";
import type { Anchor } from "@/lib/types";

const ref = (number: number, id: string): Anchor => ({ source: "AMC10", number, statement: `real problem ${id}`, answer: "1", solution: null });

describe("targetNumbers", () => {
  it("spreads a set across the band in easiest-to-hardest order", () => {
    expect(targetNumbers(1, 15, 10, 0, 25)).toEqual([1, 3, 4, 6, 7, 9, 10, 12, 13, 15]);
    expect(targetNumbers(21, 25, 5, 0, 25)).toEqual([21, 22, 23, 24, 25]);
  });
  it("applies a per-writer offset and clamps to the contest", () => {
    expect(targetNumbers(1, 15, 3, 4, 25)).toEqual([5, 12, 19]);
    expect(targetNumbers(10, 15, 2, 5, maxNumberFor("AIME"))).toEqual([15, 15]);
    expect(targetNumbers(1, 5, 2, -3, 25)).toEqual([1, 2]);
  });
});

describe("buildTargetFor", () => {
  const refsByNumber = new Map([[12, ["a", "b", "c", "d"].map((id) => ref(12, id))]]);
  const targets = [3, 12];

  it("gives the objective's position, and a reference when the corpus has one", () => {
    const f = buildTargetFor({ targets, refsByNumber, rotationKey: "s1" });
    expect(f(1, { hint: "x" })?.number).toBe(12);
    expect(f(1, { hint: "x" })?.reference?.number).toBe(12);
    expect(f(0, { hint: "x" })).toEqual({ number: 3, reference: undefined });
    expect(f(5, { hint: "x" })).toBeUndefined();
  });

  it("is stable for one session and rotates across sessions and replacement specs", () => {
    const pick = (key: string, hint: string) => buildTargetFor({ targets, refsByNumber, rotationKey: key })(1, { hint })?.reference?.statement;
    expect(pick("s1", "x")).toBe(pick("s1", "x"));
    const acrossSessions = new Set(Array.from({ length: 20 }, (_, i) => pick(`session-${i}`, "x")));
    expect(acrossSessions.size).toBeGreaterThan(2);
    const acrossSpecs = new Set(["a", "b", "c", "d", "e", "f"].map((h) => pick("s1", h)));
    expect(acrossSpecs.size).toBeGreaterThan(1);
  });

  it("hashes deterministically", () => {
    expect(stableHash("abc")).toBe(stableHash("abc"));
    expect(stableHash("abc")).not.toBe(stableHash("abd"));
  });
});
