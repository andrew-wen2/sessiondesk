// Method-level duplicates (docs/designs/generation-research.md, finding 4): two problems
// with different stories but the same key idea are the same practice, and whole-text
// shingle dedup can't see that. In the evals, "word problem set up as a quadratic" came
// back six times across three sets, four in one set, each with a new story.
//
// Every cascade candidate carries `method` (one line, no numbers). A cheap lexical score
// between methods picks which pairs are worth asking about; a cheap judge decides. The
// lexical score never rejects on its own: on a narrow topic most methods share words
// ("set up an equation, solve"), and a threshold alone would starve the set.
import type Anthropic from "@anthropic-ai/sdk";
import { buildSameMethodPrompt } from "@/lib/generation-prompt";
import type { RungConfig } from "@/lib/generation/cascade/ladder";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";

// Pairs at or above this method similarity go to the judge. Initial value, chosen to
// send roughly the top few pairs per candidate; revisit with the judge's logged verdicts.
export const METHOD_JUDGE_THRESHOLD = 0.3;
// At most this many comparisons per candidate go to the judge (most similar first).
export const MAX_JUDGED_PAIRS = 3;

const STOP = new Set([
  "the", "and", "then", "with", "from", "into", "for", "each", "that", "this", "use", "using", "find", "solve", "compute",
  "get", "give", "gives", "value", "values", "answer", "number", "numbers", "one", "two", "both", "all", "its", "their", "equation",
]);
export function methodTokens(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z]{3,}/g) ?? [])
      .filter((w) => !STOP.has(w))
      .map((w) => w.replace(/(ing|ed|es|s)$/, ""))
      .filter((w) => w.length >= 3)
  );
}
export function methodSimilarity(a: string, b: string): number {
  const x = methodTokens(a);
  const y = methodTokens(b);
  let shared = 0;
  for (const t of x) if (y.has(t)) shared++;
  return shared / (x.size + y.size - shared || 1);
}

export type Prior = { problem: string; method?: string; source: "kept" | "recent" };

// The priors worth judging against: most method-similar first, above the threshold.
export function pairsToJudge(method: string | undefined, priors: Prior[]): (Prior & { score: number })[] {
  if (!method) return [];
  return priors
    .filter((p) => p.method)
    .map((p) => ({ ...p, score: methodSimilarity(method, p.method!) }))
    .filter((p) => p.score >= METHOD_JUDGE_THRESHOLD)
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_JUDGED_PAIRS);
}

const SAME_TOOL: ToolSpec = {
  name: "emit_same",
  description: "Report whether the two problems are the same practice.",
  parameters: { type: "object", properties: { same: { type: "boolean" } }, required: ["same"] },
};

// The first prior the judge calls the same practice, or null. A judge failure is "not
// the same": this check only ever removes candidates, so it fails open.
export async function sameMethodAs(args: {
  problem: { problem: string; method?: string };
  priors: Prior[];
  call: CallOpenWeight;
  rung: RungConfig;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<(Prior & { score: number }) | null> {
  const pairs = pairsToJudge(args.problem.method, args.priors);
  const verdicts = await Promise.all(
    pairs.map((p) =>
      args
        .call(args.rung, buildSameMethodPrompt({ first: p.problem, second: args.problem.problem }), SAME_TOOL, args.signal, args.recordUsage)
        .then((r) => r.ok && (r.args as { same?: unknown } | null)?.same === true)
    )
  );
  const i = verdicts.findIndex(Boolean);
  return i === -1 ? null : pairs[i];
}
