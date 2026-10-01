import { describe, it, expect } from "vitest";
import { buildSpecs, composeUpperSlots } from "./slots";
import { buildPrompt } from "@/lib/generation-prompt";
import type { GenerationPlan } from "@/lib/generation/plan";
import type { Anchor } from "@/lib/types";

const plan = (over: Partial<GenerationPlan> = {}): GenerationPlan => ({
  domain: "d",
  contentType: "math",
  tier: "mid",
  answerFormat: "numeric",
  rubric: "",
  competition: null,
  bandLow: null,
  bandHigh: null,
  category: null,
  source: "model",
  ...over,
});
const seed = (i: number, withSolution = true): Anchor => ({
  source: "AIME",
  number: 12,
  statement: `s${i}`,
  answer: withSolution ? `${i}` : null,
  solution: withSolution ? "sol" : null,
});

describe("buildSpecs", () => {
  it("gives every variant candidate its own seed, in order", () => {
    const { specs, seedsUsed } = buildSpecs({ plan: plan({ tier: "hard" }), mode: "variant", seeds: [seed(0), seed(1), seed(2)], total: 3 });
    expect(seedsUsed).toBe(3);
    expect(specs.map((s) => s.seedIndex)).toEqual([0, 1, 2]);
  });

  it("falls back to scratch specs instead of reusing or widening seeds", () => {
    const { specs, seedsUsed } = buildSpecs({ plan: plan({ tier: "hard" }), mode: "variant", seeds: [seed(0), seed(1, false)], total: 4 });
    expect(seedsUsed).toBe(1); // the seed with neither answer nor solution is skipped
    expect(specs).toHaveLength(4);
    expect(specs.filter((s) => s.seedIndex !== undefined)).toHaveLength(1);
  });

  it("uses the plan's sub-skills, then cycles them with angles rather than drifting off-topic", () => {
    const { specs } = buildSpecs({ plan: plan({ slots: ["fractions", "ratios"] }), mode: "scratch", seeds: [], total: 5 });
    expect(specs[0].hint).toMatch(/fractions/);
    expect(specs[1].hint).toMatch(/ratios/);
    expect(specs[2].hint).toMatch(/fractions.*approached as/);
    expect(new Set(specs.map((s) => s.hint)).size).toBe(5);
  });

  it("uses rotating angles when there are no sub-skills", () => {
    const { specs } = buildSpecs({ plan: plan(), mode: "scratch", seeds: [], total: 3 });
    expect(new Set(specs.map((s) => s.hint)).size).toBe(3);
  });
});


describe("buildPrompt slot block", () => {
  it("tells a single-problem call where it sits in the set and what to focus on", () => {
    const { user } = buildPrompt({
      plan: plan(),
      profile: "p",
      topic: "t",
      count: 1,
      recentTopics: [],
      slot: { index: 3, of: 10, hint: "the sub-skill \"ratios\"" },
    });
    expect(user).toMatch(/problem 4 of a 10-problem set/);
    expect(user).toMatch(/Focus for this problem: the sub-skill "ratios"/);
  });

  it("is absent on the legacy chunked path", () => {
    const { user } = buildPrompt({ plan: plan(), profile: "p", topic: "t", count: 5, recentTopics: [], chunkIndex: 1 });
    expect(user).not.toMatch(/problem \d+ of a/);
    expect(user).toMatch(/For this batch specifically/);
  });
});

describe("composeUpperSlots", () => {
  it("pairs the upper half with spare types, leaving the lower half and spares alone", () => {
    const types = ["a", "b", "c", "d", "x", "y"];
    expect(composeUpperSlots(types, 4)).toEqual([
      "a",
      "b",
      "c, COMBINED WITH x (the problem must need both ideas)",
      "d, COMBINED WITH y (the problem must need both ideas)",
      "x",
      "y",
    ]);
  });
  it("falls back to a sibling's type when there are no spares", () => {
    expect(composeUpperSlots(["a", "b", "c"], 3)[2]).toBe("c, COMBINED WITH a (the problem must need both ideas)");
  });
});

describe("reverse specs", () => {
  const seeds = Array.from({ length: 10 }, (_, i) => ({ source: "AIME", number: 10, statement: `s${i}`, answer: `${100 + i}`, solution: "sol" }));
  const plan = { tier: "hard", competition: "AIME" } as GenerationPlan;
  it("spreads the reversed share evenly and only over integer-answer seeds", () => {
    const { specs } = buildSpecs({ plan, mode: "variant", seeds, total: 10, reverseShare: 0.3 });
    expect(specs.filter((s) => s.reverse).map((s) => s.seedIndex)).toEqual([3, 6, 9]);
    const odd = seeds.map((s, i) => (i === 3 ? { ...s, answer: "3/4" } : s));
    expect(buildSpecs({ plan, mode: "variant", seeds: odd, total: 10, reverseShare: 0.3 }).specs.find((s) => s.seedIndex === 3)?.reverse).toBeUndefined();
    expect(buildSpecs({ plan, mode: "variant", seeds, total: 10 }).specs.some((s) => s.reverse)).toBe(false);
  });
});
