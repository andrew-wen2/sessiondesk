// Typed shape for Session.genMeta — generation provenance: which provider/model
// produced each stage, per-item verification verdicts, per-stage token counts, and
// drop reasons. A `Json?` column validates nothing, so this is the single source of
// truth for what's actually stored, and `parseGenMeta` is how every reader gets it
// back safely.
//
// `version` is mandatory and first. The shape WILL change as Stage 2 (guards) and
// Stage 3 (provider swap) land, and a bad read must never break a page — same
// defensive posture as lib/session-status.ts's normalizeStatus, for the same reason.
// parseGenMeta returns null on anything unrecognized rather than throwing or
// coercing; a null genMeta reads as "unknown provenance", not "zero cost".
//
// Written on failure too (not just beside `problems`), so a bad run still leaves a
// join key to how it was attempted — see app/api/generate/route.ts.

export const GEN_META_VERSION = 1 as const;

// Closed drop-reason vocabulary. Free-text reasons would make "drops by cause"
// aggregation group typos as distinct causes — this is the eval's join key.
export const DROP_REASONS = [
  "malformed-statement", // problemOk rejected the statement
  "bad-answer-format", // answerOkFor rejected the generator's self-reported answer (pre-solve)
  "backtracking", // solutionOk/solutionSketchOk found leaked self-correction
  "near-duplicate", // tooSimilarToSeed against an already-kept problem
  "solver-no-consensus", // solve.ts couldn't reach agreement within the escalation cap
  "solver-ambiguous", // solve.ts judged the statement ill-posed
  "solver-error", // the solver call itself failed (non-blocking; item ships unverified, not dropped)
  "generation-failed", // the underlying model call failed for this item's batch
  "content-filtered", // Gemini RECITATION/SAFETY — a class Anthropic tool-use never had
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export function isDropReason(v: unknown): v is DropReason {
  return typeof v === "string" && (DROP_REASONS as readonly string[]).includes(v);
}

// Per-item verification outcome. Three-valued, not boolean (Eng D9): a boolean would
// retroactively mark every problem generated before the solver existed as "false".
// Absent/undefined on a Problem = pre-solver, and nothing renders for it.
export type VerificationVerdict = "verified" | "unverified" | "not-applicable";

export type StageUsage = {
  provider: string; // "anthropic" | "gemini" — string, not an enum, same reasoning as Session.status
  model: string;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  cacheWriteTokens: number;
  cacheReadTokens: number;
};

export type GenerationRunMeta = {
  planSource: "corpus" | "model" | "fallback";
  tier: "easy" | "mid" | "hard";
  answerFormat: string;
  competition: string | null;
  bandLow: number | null;
  bandHigh: number | null;
  // Per-stage usage, keyed by the same Stage vocabulary as UsageAccountant.
  usage: Partial<Record<string, StageUsage>>;
  // One entry per dropped candidate, kept even past the current set's `count` cap so
  // "drops by cause" is a real distribution rather than truncated at the first N.
  drops: { reason: DropReason; excerpt: string }[];
  // Per-kept-item verdict, index-aligned to the returned problems array.
  verdicts: VerificationVerdict[];
  kept: number;
  asked: number;
  escalations: number; // total solver escalation calls spent on this run
  truncated?: boolean; // set if this record itself was truncated to stay under MAX_GENMETA_BYTES
};

export type GenMeta = {
  v: typeof GEN_META_VERSION;
  problems?: GenerationRunMeta;
  lesson?: GenerationRunMeta;
};

// A genMeta row lives on a table every calendar/session page loads — bound it so a
// pathological run (many drops, many stages) can't bloat a row every render pays for.
const MAX_GENMETA_BYTES = 16_000;

export function truncateGenMeta(meta: GenMeta): GenMeta {
  const json = JSON.stringify(meta);
  if (json.length <= MAX_GENMETA_BYTES) return meta;
  const shrink = (run?: GenerationRunMeta): GenerationRunMeta | undefined =>
    run ? { ...run, drops: run.drops.slice(0, 20), truncated: true } : undefined;
  return { ...meta, problems: shrink(meta.problems), lesson: shrink(meta.lesson) };
}

// Defensive read: anything that doesn't look like a current-version GenMeta comes
// back null rather than throwing or being coerced. Callers treat null exactly like
// an absent column — "unknown provenance," never "zero cost" or "unverified."
export function parseGenMeta(raw: unknown): GenMeta | null {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as { v?: unknown }).v;
  if (v !== GEN_META_VERSION) return null;
  return raw as GenMeta;
}
