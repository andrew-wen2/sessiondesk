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
  // Cascade pipeline (lib/generation/cascade): a rung's call ran out of its deadline,
  // the set failed because an objective ran out of candidates, rungs or time, or a
  // provider was down for the whole request.
  "rung-timeout",
  "slot-exhausted",
  "provider-unavailable",
  // Cascade quality gates (additive: rows written before them still parse).
  "answer-contradicts-solution", // the answer field disagrees with the solution's own result, or the solution calls the problem broken
  "ill-posed", // the well-posedness check found the statement unanswerable as written
  "difficulty-off-target", // the weak-solver pass rate fell outside the slot's window
  "answer-contradicts-program", // the writer's own answer-check program computed a different answer
  "reverse-key-unverified", // a reversed seed whose hidden given or kept answer doesn't match the seed
] as const;
export type DropReason = (typeof DROP_REASONS)[number];

export function isDropReason(v: unknown): v is DropReason {
  return typeof v === "string" && (DROP_REASONS as readonly string[]).includes(v);
}

// What the provider said about one rung call — separate from why a well-formed
// candidate was then rejected (CandidateRejection) and from why a candidate moved up
// the ladder. Collapsing these into one list is what made "drops by cause" useless:
// a successful call can still produce a rejected problem. Each adapter maps its
// vendor's own finish reasons into this vocabulary and keeps the raw string.
export const FINISH_REASONS = [
  "ok",
  "malformed-tool-call",
  "missing-tool-call",
  "max-tokens",
  "filtered",
  "timeout",
  "rate-limited",
  "api-error",
  "aborted",
] as const;
export type FinishReason = (typeof FINISH_REASONS)[number];

export const CANDIDATE_REJECTIONS = [
  "guard-problem", // problemOk
  "guard-solution", // solutionOk
  "guard-answer", // answerOkFor
  "duplicate", // tooSimilarToSeed against a kept item (or its own seed)
  "solver-disagree",
  "solver-ambiguous",
  "guard-consistency", // answerMatchesSolution / solutionMetaOk
  "invalid", // the well-posedness check
  "too-easy", // weak-solver pass rate above the slot's window
  "too-hard", // below it
  "guard-program", // the answer-check program's value contradicts the stated answer (answer-check.ts)
  "guard-reverse", // a reversed seed's key couldn't be traced back to the seed (reverse.ts)
] as const;
export type CandidateRejection = (typeof CANDIDATE_REJECTIONS)[number];

// Cascade provenance for one run: the ladder that ran, and per kept item which rung
// and model wrote it and what it went through first. Absent on legacy runs.
export type ItemDifficulty = { target: number; solved: number; answered: number };

export type CascadeRunMeta = {
  ladder: { provider: string; model: string }[];
  items: {
    objective: number;
    rung: number;
    model: string;
    verdict: VerificationVerdict;
    history: { rung: number; finish: FinishReason; rejection?: CandidateRejection }[];
    // Weak-solver pass rate against the writer's answer, when the difficulty filter ran.
    difficulty?: ItemDifficulty;
    // The writer's one-line solution method (no numbers): cross-session method dedup
    // reads it back from recent sessions.
    method?: string;
    // Difficulty judge placement (difficulty-judge.ts), when it ran.
    placement?: { rating: number; target?: number };
    // The real corpus problem this item is a variant of (seeded scratch slots).
    seedId?: string;
  }[];
  candidatesLaunched: number;
  // Per finished candidate, where its time went (run.ts): queue for a provider permit,
  // the writer call, then checks and verification. `outcome` is the finish reason, the
  // rejection, "duplicate", or "passed" (kept, or passed after its objective filled).
  timings?: { candidate: number; objective: number; outcome: string; queueMs: number; writeMs?: number; checkMs?: number }[];
  candidatesAborted: number;
  callsMade: number;
  finishes: Partial<Record<FinishReason, number>>;
  rejections: Partial<Record<CandidateRejection, number>>;
  failure?: { objective: number; reason: string };
  seedsAvailable?: number;
  // Seeded scratch slots (seed-slots.ts): how many objectives started from a real problem.
  seeded?: number;
  // Which scale placement targets are on: the judge's own (calibrated, judge-calibration.ts)
  // or the human scale, for a judge with no fit for this contest.
  judgeScale?: "calibrated" | "human";
  targets?: number[]; // per-objective contest position aimed at (targets.ts), when the set had targets
  types?: string[]; // per-slot problem types, in slot order (problem-types.ts), when the set had them
  // Corpus-taxonomy type ids the slots were drawn from (taxonomy.ts): the exact ids the
  // next sessions exclude. Absent when the set used the LLM type menu.
  typeIds?: string[];
  recentProblems?: number; // how many recent-session problems the set was told to avoid
  // Answer-check programs over every guarded candidate (answer-check.ts): agreed with the
  // stated answer, contradicted it (rejected), or couldn't be used.
  answerChecks?: { match: number; mismatch: number; abstain: number };
  // Blind program solves (program-solver.ts) for candidates without a matching writer
  // program: agreed, disagreed (vetoed as guard-program), or abstained.
  programSolves?: { agree: number; disagree: number; abstain: number };
};

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
  pipeline?: "legacy" | "cascade"; // absent = legacy (rows written before the cascade existed)
  cascade?: CascadeRunMeta;
  truncated?: boolean; // set if this record itself was truncated to stay under MAX_GENMETA_BYTES
};

// `problems` / `lesson` describe what is PUBLISHED on the session — lib/worksheet.ts
// grades a student's answers against `problems.answerFormat`, so these keys are
// written only when a run succeeds and actually replaces the content they describe.
// A failed run's record goes in `attempts` instead: otherwise a failed regenerate
// would change how the still-published older set is graded.
export type GenMeta = {
  v: typeof GEN_META_VERSION;
  problems?: GenerationRunMeta;
  lesson?: GenerationRunMeta;
  attempts?: GenerationAttempts;
};

// Attempt telemetry, separate from published metadata. Additive and optional, so a
// reader that predates it (parseGenMeta only checks `v`) ignores it rather than
// discarding the row. `last` is the most recent attempt; `prior` keeps a few before it
// so a failure the tutor immediately retried is still countable. `status: "started"`
// is written before generation begins: if the function is killed at maxDuration
// nothing else is ever written, and a stale "started" is how that kill shows up.
export type AttemptStatus = "started" | "ok" | "failed";
export type AttemptRecord = {
  kind: "problems" | "lesson";
  status: AttemptStatus;
  startedAt: string; // ISO
  wallTimeMs?: number;
  tier?: GenerationRunMeta["tier"];
  kept?: number;
  asked?: number;
  topDrops?: { reason: DropReason; count: number }[];
};
export type GenerationAttempts = { last?: AttemptRecord; prior: AttemptRecord[] };

export const MAX_PRIOR_ATTEMPTS = 5;

// Read whatever is on the row as a GenMeta to merge into — a missing or foreign-
// version value starts fresh rather than being merged blind.
function baseOf(existing: unknown): GenMeta {
  return parseGenMeta(existing) ?? { v: GEN_META_VERSION };
}

// Record that an attempt has begun. The previous `last` (whatever its status) moves
// into `prior`, capped, so one row carries a short history of attempts.
export function startAttempt(existing: unknown, kind: AttemptRecord["kind"], now: Date): GenMeta {
  const base = baseOf(existing);
  const prev = base.attempts;
  const prior = prev?.last ? [prev.last, ...prev.prior].slice(0, MAX_PRIOR_ATTEMPTS) : (prev?.prior ?? []);
  return { ...base, attempts: { last: { kind, status: "started", startedAt: now.toISOString() }, prior } };
}

function topDrops(run: GenerationRunMeta): { reason: DropReason; count: number }[] {
  const counts = new Map<DropReason, number>();
  for (const d of run.drops) counts.set(d.reason, (counts.get(d.reason) ?? 0) + 1);
  return [...counts].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count).slice(0, 3);
}

// Record how an attempt ended. `existing` must be re-read from the row immediately
// before this write (not a snapshot from the start of the request): the other
// generate route may have written its own key in the meantime. The published key for
// `kind` is replaced only when `ok` — see the GenMeta comment above.
export function finishAttempt(
  existing: unknown,
  kind: AttemptRecord["kind"],
  startedAt: Date,
  now: Date,
  run: GenerationRunMeta,
  ok: boolean
): GenMeta {
  const base = baseOf(existing);
  const record: AttemptRecord = {
    kind,
    status: ok ? "ok" : "failed",
    startedAt: startedAt.toISOString(),
    wallTimeMs: now.getTime() - startedAt.getTime(),
    tier: run.tier,
    kept: run.kept,
    asked: run.asked,
    topDrops: topDrops(run),
  };
  // Replace our own "started" marker in place; if something else became `last` in
  // the meantime (a concurrent attempt), keep it and file ours under `prior`.
  const prev = base.attempts;
  const ours = prev?.last?.status === "started" && prev.last.kind === kind && prev.last.startedAt === record.startedAt;
  const attempts: GenerationAttempts = ours || !prev?.last
    ? { last: record, prior: prev?.prior ?? [] }
    : { last: prev.last, prior: [record, ...prev.prior].slice(0, MAX_PRIOR_ATTEMPTS) };
  return { ...base, ...(ok ? { [kind]: run } : {}), attempts };
}

// A "started" attempt older than the route's maxDuration plus slack can only mean the
// function was killed before it could record an outcome. Derived at read time (never
// written), same idea as lib/session-status.ts's effectiveStatus.
export const KILLED_AFTER_MS = 300_000 + 60_000;
export function effectiveAttemptStatus(rec: AttemptRecord, now: Date): AttemptStatus | "killed" {
  if (rec.status !== "started") return rec.status;
  return now.getTime() - Date.parse(rec.startedAt) > KILLED_AFTER_MS ? "killed" : "started";
}

// A genMeta row lives on a table every calendar/session page loads — bound it so a
// pathological run (many drops, many stages) can't bloat a row every render pays for.
const MAX_GENMETA_BYTES = 16_000;

export function truncateGenMeta(meta: GenMeta): GenMeta {
  const json = JSON.stringify(meta);
  if (json.length <= MAX_GENMETA_BYTES) return meta;
  // Shrink order: attempt history first (diagnostic only), then drop lists.
  const trimmed: GenMeta = meta.attempts ? { ...meta, attempts: { last: meta.attempts.last, prior: [] } } : meta;
  if (JSON.stringify(trimmed).length <= MAX_GENMETA_BYTES) return trimmed;
  // Excerpts are clamped too: 20 drops of a long provider error message could still
  // overrun the cap on their own.
  const shrink = (run?: GenerationRunMeta): GenerationRunMeta | undefined =>
    run
      ? {
          ...run,
          drops: run.drops.slice(0, 20).map((d) => ({ ...d, excerpt: d.excerpt.slice(0, 200) })),
          truncated: true,
        }
      : undefined;
  return { ...trimmed, problems: shrink(trimmed.problems), lesson: shrink(trimmed.lesson) };
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
