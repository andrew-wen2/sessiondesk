import { describe, expect, it } from "vitest";
import { interpolateRating, isJudgeAnchorId, judgeAnchorIds, placeProblem, spreadAnchors, type RatedAnchor } from "./difficulty-judge";
import { corpusDifficulty, ratedIds } from "@/lib/generation/corpus-difficulty";
import type { CallOpenWeight } from "./verify-cheap";
import type { RungConfig } from "./ladder";

const rung: RungConfig = { provider: "gemini", model: "gemini-3.8-flash", timeoutMs: 1000, maxTokens: 1000, thinking: "low", toolChoice: "forced" };
const signal = new AbortController().signal;
const anchors: RatedAnchor[] = [0.1, 0.2, 0.3, 0.4].map((rating) => ({ statement: `anchor ${rating}`, rating }));

// A judge that "knows" every problem's true rating from its text ("anchor 0.2", "X 0.25").
const truthful: CallOpenWeight = async (_rung, prompt, tool) => {
  const rating = (s: string) => Number(/(\d\.\d+)/.exec(s)![1]);
  if (tool.name === "emit_comparison") {
    const [, first, second] = /First problem:\n(.*)\n\nSecond problem:\n(.*)/s.exec(prompt.user)!;
    return { ok: true, args: { harder: rating(first) > rating(second) ? "first" : "second" } };
  }
  const problem = /New problem:\n(.*)$/s.exec(prompt.user)![1];
  return { ok: true, args: { harderThan: anchors.filter((a) => a.rating < rating(problem)).length } };
};

describe("interpolateRating", () => {
  it("maps 0 and 1 to the extreme anchors and interpolates between", () => {
    expect(interpolateRating([0.1, 0.2, 0.3], 0)).toBeCloseTo(0.1);
    expect(interpolateRating([0.1, 0.2, 0.3], 1)).toBeCloseTo(0.3);
    expect(interpolateRating([0.1, 0.2, 0.3], 0.25)).toBeCloseTo(0.15);
  });
});

describe("placeProblem", () => {
  it("pairwise: asks both orders per anchor and scores the share won", async () => {
    let calls = 0;
    const counting: CallOpenWeight = (...a) => (calls++, truthful(...a));
    const p = await placeProblem({ problem: "X 0.25", anchors, mode: "pairwise", level: "AMC 10", call: counting, rung, signal, recordUsage: () => {} });
    expect(calls).toBe(8);
    expect(p).toMatchObject({ score: 0.5, answered: 8 });
  });

  it("pairwise: a position-biased judge (always 'first') scores exactly one half", async () => {
    const biased: CallOpenWeight = async () => ({ ok: true, args: { harder: "first" } });
    const p = await placeProblem({ problem: "X", anchors, mode: "pairwise", level: "AMC 10", call: biased, rung, signal, recordUsage: () => {} });
    expect(p?.score).toBe(0.5);
  });

  it("ladder: one call, clamped position", async () => {
    const p = await placeProblem({ problem: "X 0.35", anchors, mode: "ladder", level: "AMC 10", call: truthful, rung, signal, recordUsage: () => {} });
    expect(p).toMatchObject({ score: 0.75, answered: 1 });
    const wild: CallOpenWeight = async () => ({ ok: true, args: { harderThan: 99 } });
    expect((await placeProblem({ problem: "X", anchors, mode: "ladder", level: "AMC 10", call: wild, rung, signal, recordUsage: () => {} }))?.score).toBe(1);
  });

  it("returns null when every judgment fails", async () => {
    const down: CallOpenWeight = async () => ({ ok: false, message: "HTTP 500" });
    expect(await placeProblem({ problem: "X", anchors, mode: "pairwise", level: "AMC 10", call: down, rung, signal, recordUsage: () => {} })).toBeNull();
  });
});

describe("spreadAnchors", () => {
  it("covers the whole rating range", () => {
    const pool = Array.from({ length: 11 }, (_, i) => ({ rating: i / 10 }));
    expect(spreadAnchors(pool, 3).map((a) => a.rating)).toEqual([0, 0.5, 1]);
  });
});

describe("judgeAnchorIds", () => {
  it("spreads anchors from the fixed anchor third over the contest's whole rating range", () => {
    const picked = judgeAnchorIds("AMC10", 8);
    expect(picked).toHaveLength(8);
    expect(picked.every((p) => isJudgeAnchorId(p.id) && corpusDifficulty(p.id)?.source === "AMC10")).toBe(true);
    const pool = ratedIds("AMC10", 1, 25).filter((r) => isJudgeAnchorId(r.id)).map((r) => r.rating);
    expect(picked[0].rating).toBe(Math.min(...pool));
    expect(picked[7].rating).toBe(Math.max(...pool));
  });
});
