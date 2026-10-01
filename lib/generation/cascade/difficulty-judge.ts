// Difficulty placement by comparison against real problems of known HUMAN difficulty
// (E2H-AMC ratings, corpus-difficulty.ts). Replaces the weak-solver pass rate as the
// difficulty signal: a pass rate correlates with human difficulty at only r ≈ 0.2, while
// pairwise judgments against anchors reach r ≈ 0.6–0.8 in the literature. Validated on
// held-out real problems by scripts/eval-difficulty-judge.ts before anything uses it.
//
// Two modes:
//  - "pairwise": the problem against each anchor, in BOTH orders (pair order is a known
//    judge bias). Score = share of comparisons it wins. 2 calls per anchor.
//  - "ladder": one call shows every anchor in difficulty order and asks where the
//    problem fits. 1 call.
// Either way the result is mapped onto the anchors' rating scale by interpolation, so
// it is directly comparable with a slot's target rating.
import type Anthropic from "@anthropic-ai/sdk";
import { buildLadderDifficultyPrompt, buildPairwiseDifficultyPrompt } from "@/lib/generation-prompt";
import type { RungConfig } from "@/lib/generation/cascade/ladder";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";
import { stableHash } from "@/lib/generation/cascade/targets";
import { ratedIds } from "@/lib/generation/corpus-difficulty";

export type RatedAnchor = { statement: string; rating: number; label?: string };
export type JudgeMode = "pairwise" | "ladder";
export type Placement = {
  mode: JudgeMode;
  score: number; // 0..1: share of anchors judged easier than the problem
  rating: number; // score mapped onto the anchors' rating scale
  answered: number; // judgments that came back (pairwise: of 2 × anchors; ladder: 0 or 1)
};

const COMPARE_TOOL: ToolSpec = {
  name: "emit_comparison",
  description: "Report which of the two problems is harder.",
  parameters: { type: "object", properties: { harder: { type: "string", enum: ["first", "second"] } }, required: ["harder"] },
};
const LADDER_TOOL: ToolSpec = {
  name: "emit_placement",
  description: "Report how many ladder problems the new problem is harder than.",
  parameters: { type: "object", properties: { harderThan: { type: "integer" } }, required: ["harderThan"] },
};

// score ∈ [0, 1] → a rating on the anchors' scale. Anchors sorted by rating are treated
// as evenly spaced quantiles: beating none of them is the easiest anchor's rating, all
// of them the hardest's, and anything between interpolates linearly.
export function interpolateRating(sortedRatings: number[], score: number): number {
  const n = sortedRatings.length;
  if (n === 0) return NaN;
  if (n === 1) return sortedRatings[0];
  const x = Math.min(1, Math.max(0, score)) * (n - 1);
  const i = Math.min(n - 2, Math.floor(x));
  return sortedRatings[i] + (x - i) * (sortedRatings[i + 1] - sortedRatings[i]);
}

export async function placeProblem(args: {
  problem: string;
  anchors: RatedAnchor[];
  mode: JudgeMode;
  level: string; // e.g. "AMC 10"
  call: CallOpenWeight;
  rung: RungConfig;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<Placement | null> {
  const { problem, mode, level, call, rung, signal, recordUsage } = args;
  const anchors = [...args.anchors].sort((a, b) => a.rating - b.rating);
  if (anchors.length === 0) return null;
  const ratings = anchors.map((a) => a.rating);

  if (mode === "ladder") {
    const r = await call(rung, buildLadderDifficultyPrompt({ problem, ladder: anchors.map((a) => a.statement), level }), LADDER_TOOL, signal, recordUsage);
    const k = r.ok ? Number((r.args as { harderThan?: unknown } | null)?.harderThan) : NaN;
    if (!Number.isFinite(k)) return null;
    const score = Math.min(anchors.length, Math.max(0, Math.round(k))) / anchors.length;
    return { mode, score, rating: interpolateRating(ratings, score), answered: 1 };
  }

  const judgments = await Promise.all(
    anchors.flatMap((a) => [
      // problem first: it wins when "first" is harder
      call(rung, buildPairwiseDifficultyPrompt({ first: problem, second: a.statement, level }), COMPARE_TOOL, signal, recordUsage).then((r) => verdict(r, "first")),
      call(rung, buildPairwiseDifficultyPrompt({ first: a.statement, second: problem, level }), COMPARE_TOOL, signal, recordUsage).then((r) => verdict(r, "second")),
    ])
  );
  const answered = judgments.filter((j) => j !== null);
  if (answered.length === 0) return null;
  const score = answered.filter(Boolean).length / answered.length;
  return { mode, score, rating: interpolateRating(ratings, score), answered: answered.length };
}

// true = the problem was judged harder, false = easier, null = no usable judgment.
function verdict(r: Awaited<ReturnType<CallOpenWeight>>, problemSide: "first" | "second"): boolean | null {
  if (!r.ok) return null;
  const h = (r.args as { harder?: unknown } | null)?.harder;
  return h === "first" || h === "second" ? h === problemSide : null;
}

// Pick `count` anchors spread evenly across a rated pool (sorted by rating), so the
// ladder covers the whole scale rather than clustering where the corpus is dense.
// The judge's anchor pool for a contest: a fixed third of its rated problems (by a stable
// hash). The rest are the calibration eval's test items, so anchors never judge themselves.
export function isJudgeAnchorId(id: string): boolean {
  return stableHash(id) % 3 === 0;
}

// The judge's anchors for a contest, spread over its WHOLE rating range. Production and
// scripts/eval-difficulty-judge.ts pick them identically, because a judge's bias depends
// on its anchors: the calibration fitted on that eval (judge-calibration.ts) only holds
// for placements made against the same anchors.
export function judgeAnchorIds(source: string, count: number): { id: string; rating: number; number: number }[] {
  return spreadAnchors(ratedIds(source, 1, Number.MAX_SAFE_INTEGER).filter((r) => isJudgeAnchorId(r.id)), count);
}

export function spreadAnchors<T extends { rating: number }>(pool: T[], count: number): T[] {
  const sorted = [...pool].sort((a, b) => a.rating - b.rating);
  if (sorted.length <= count) return sorted;
  return Array.from({ length: count }, (_, i) => sorted[Math.round((i * (sorted.length - 1)) / (count - 1))]);
}
