import { describe, expect, it } from "vitest";
import { methodSimilarity, pairsToJudge, sameMethodAs, type Prior } from "./method-dedup";
import type { CallOpenWeight } from "./verify-cheap";
import type { RungConfig } from "./ladder";

const rung = { provider: "openweight", model: "m", timeoutMs: 1, maxTokens: 1, thinking: "off", toolChoice: "forced" } as RungConfig;
const signal = new AbortController().signal;

describe("methodSimilarity", () => {
  it("scores the same idea in different words above unrelated methods", () => {
    const a = "translate the word problem into one quadratic equation, factor it, keep the positive root";
    const b = "set up a quadratic from the word problem, factoring, take the positive root";
    const c = "count lattice paths with complementary counting around the forbidden point";
    expect(methodSimilarity(a, b)).toBeGreaterThan(methodSimilarity(a, c));
    expect(methodSimilarity(a, c)).toBe(0);
  });
});

describe("pairsToJudge / sameMethodAs", () => {
  const priors: Prior[] = [
    { problem: "P1", method: "word problem to one quadratic equation, factor, positive root", source: "kept" },
    { problem: "P2", method: "complementary counting of lattice paths", source: "recent" },
    { problem: "P3", source: "kept" },
  ];
  const cand = { problem: "Q", method: "quadratic equation from a word problem, factor it, positive root" };

  it("judges only similar, method-bearing priors", () => {
    expect(pairsToJudge(cand.method, priors).map((p) => p.problem)).toEqual(["P1"]);
    expect(pairsToJudge(undefined, priors)).toEqual([]);
  });

  it("returns the prior the judge calls the same practice, and fails open", async () => {
    const yes: CallOpenWeight = async () => ({ ok: true, args: { same: true } });
    const no: CallOpenWeight = async () => ({ ok: true, args: { same: false } });
    const down: CallOpenWeight = async () => ({ ok: false, message: "x" });
    expect((await sameMethodAs({ problem: cand, priors, call: yes, rung, signal, recordUsage: () => {} }))?.problem).toBe("P1");
    expect(await sameMethodAs({ problem: cand, priors, call: no, rung, signal, recordUsage: () => {} })).toBeNull();
    expect(await sameMethodAs({ problem: cand, priors, call: down, rung, signal, recordUsage: () => {} })).toBeNull();
  });
});
