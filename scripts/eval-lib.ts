// Pure pieces of scripts/eval-generation.ts, split out so they are unit-tested
// (scripts/eval-lib.test.ts). No I/O, no model calls.
import { createHash } from "node:crypto";

export type Fixture = {
  id: string;
  profile: string;
  topic: string;
  recentTopics: string[];
  // The tier this fixture is meant to exercise. Recorded next to the tier the plan
  // actually chose, so a plan-stage downgrade can't quietly move a failure out of the
  // hard tier's denominator. Optional: inferred from the id prefix when absent.
  cohort?: "easy" | "mid" | "hard";
};

export type RunRecord = {
  // `id` is the fixture id (kept for old run files); `sampleId` is `${id}#${repeat}`.
  id: string;
  sampleId?: string;
  repeat?: number;
  experimentId?: string;
  pipeline?: "legacy" | "cascade";
  cohort?: string;
  ok: boolean;
  error?: string;
  tier?: string;
  planSource?: string;
  kept?: number;
  asked?: number;
  dropsByReason?: Record<string, number>;
  verdictCounts?: Record<string, number>;
  rungsKept?: Record<string, number>; // cascade: kept items per "provider:model"
  // cascade: candidates written, model calls made, and answer-check program outcomes
  cascadeStats?: {
    candidatesLaunched: number;
    callsMade: number;
    answerChecks?: { match: number; mismatch: number; abstain: number };
    programSolves?: { agree: number; disagree: number; abstain: number };
    placements?: ({ rating: number; target?: number } | null)[]; // per kept item, set order
  };
  dollars?: number;
  unpricedStages?: string[];
  wallTimeMs: number;
  problems?: { problem: string; answer: string; solution: string; solutionSketch?: string }[];
};

export type Rating = {
  id: string; // fixture id (old files) — prefer sampleId
  sampleId?: string;
  index: number;
  rating: number | null; // calibration/quality 1-5; null = skipped
  correct?: boolean | null; // is the stored answer right? null = couldn't tell
};

export type Args = {
  help: boolean;
  dryRun: boolean;
  yes: boolean;
  resume: boolean;
  append: boolean;
  fixtures: string;
  out: string;
  pipeline?: "legacy" | "cascade";
  repeat: number;
  concurrency: number;
  maxDollars?: number;
  minPerTier: number;
  rate?: string;
  rateCount: number;
  compare?: [string, string];
  gate?: string;
};

export const USAGE = `Usage:
  npm run eval:generation -- --dry-run [--pipeline cascade] [--repeat 20]
  npm run eval:generation -- --yes --out runs/cascade.jsonl --pipeline cascade --repeat 20 [--concurrency 3] [--max-dollars 40]
  npm run eval:generation -- --yes --out runs/cascade.jsonl --resume          (continue an interrupted run)
  npm run eval:generation -- --rate runs/cascade.jsonl [--count 30]
  npm run eval:generation -- --compare runs/legacy.jsonl runs/cascade.jsonl
  npm run eval:generation -- --gate runs/cascade.jsonl [--min-per-tier 30]

  --repeat N        full sets generated per fixture (default 1)
  --concurrency K   sets generated at the same time (default 1)
  --max-dollars X   stop starting new sets once priced spend reaches X
  --pipeline P      legacy | cascade (sets GENERATION_PIPELINE for this process)
  --append          allow writing into an existing --out file
Exit codes for --gate: 0 pass, 1 fail, 2 insufficient evidence.`;

const VALUE_FLAGS = new Set(["fixtures", "out", "pipeline", "repeat", "concurrency", "max-dollars", "min-per-tier", "rate", "count", "gate"]);
const BOOL_FLAGS = new Set(["help", "dry-run", "yes", "resume", "append"]);

export class ArgError extends Error {}

export function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const bools = new Set<string>();
  let compare: [string, string] | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new ArgError(`Unexpected argument "${a}".`);
    const name = a.slice(2);
    if (name === "compare") {
      if (!argv[i + 1] || !argv[i + 2]) throw new ArgError("--compare needs two run files.");
      compare = [argv[i + 1], argv[i + 2]];
      i += 2;
    } else if (BOOL_FLAGS.has(name)) bools.add(name);
    else if (VALUE_FLAGS.has(name)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new ArgError(`--${name} needs a value.`);
      values.set(name, v);
      i++;
    } else throw new ArgError(`Unknown flag --${name}.`);
  }
  const posInt = (name: string, dflt: number) => {
    const raw = values.get(name);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new ArgError(`--${name} must be a positive integer.`);
    return n;
  };
  const pipeline = values.get("pipeline");
  if (pipeline !== undefined && pipeline !== "legacy" && pipeline !== "cascade") {
    throw new ArgError(`--pipeline must be legacy or cascade.`);
  }
  const maxRaw = values.get("max-dollars");
  const maxDollars = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxDollars !== undefined && !(maxDollars > 0)) throw new ArgError("--max-dollars must be a positive number.");
  return {
    help: bools.has("help"),
    dryRun: bools.has("dry-run"),
    yes: bools.has("yes"),
    resume: bools.has("resume"),
    append: bools.has("append"),
    fixtures: values.get("fixtures") ?? "scripts/eval-fixtures/generation-fixtures.json",
    out: values.get("out") ?? "runs/generation-eval.jsonl",
    pipeline: pipeline as Args["pipeline"],
    repeat: posInt("repeat", 1),
    concurrency: posInt("concurrency", 1),
    maxDollars,
    minPerTier: posInt("min-per-tier", 30),
    rate: values.get("rate"),
    rateCount: posInt("count", 30),
    compare,
    gate: values.get("gate"),
  };
}

export const sampleIdOf = (fixtureId: string, repeat: number) => `${fixtureId}#${repeat}`;
export const recordSampleId = (r: RunRecord) => r.sampleId ?? r.id;
export const ratingKey = (r: Pick<Rating, "id" | "sampleId" | "index">) => `${r.sampleId ?? r.id}:${r.index}`;

export function cohortOf(f: Fixture): string {
  if (f.cohort) return f.cohort;
  const m = /-(easy|mid|hard)(-|$)/.exec(f.id);
  return m ? m[1] : "unknown";
}

// Identity of an experiment: what would change the results if it changed. Two runs
// with different identities must not be resumed into one file or compared as one.
export function experimentId(parts: { pipeline: string; ladderEnv: string; gitRev: string; fixturesJson: string }): string {
  return createHash("sha256")
    .update(JSON.stringify(parts))
    .digest("hex")
    .slice(0, 12);
}

export function isShort(r: RunRecord): boolean {
  return !r.ok || (r.kept ?? 0) < (r.asked ?? 0);
}

export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

// One-sided 95% upper bound on a failure rate after `failures` in `n` trials.
// Zero failures uses the rule of three (3/n); otherwise a Wilson score bound.
export function failureUpperBound(failures: number, n: number): number {
  if (n === 0) return 1;
  if (failures === 0) return Math.min(1, 3 / n);
  const z = 1.645;
  const p = failures / n;
  const denom = 1 + (z * z) / n;
  const centre = p + (z * z) / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
  return Math.min(1, (centre + margin) / denom);
}

export type TierGate = {
  cohort: string;
  n: number;
  short: number;
  upperBound: number;
  p95WallMs: number | null;
  verdict: "pass" | "fail" | "insufficient-evidence";
};

// The cutover gate for the short-set rate, per tier (by expected cohort, so a plan
// downgrade can't hide a hard-tier failure): 0 short sets in at least `minPerTier`
// samples, and p95 wall time under the route's budget with a margin.
export function gateByTier(records: RunRecord[], opts: { minPerTier: number; maxP95Ms: number }): {
  tiers: TierGate[];
  verdict: TierGate["verdict"];
} {
  const cohorts = new Map<string, RunRecord[]>();
  for (const r of records) cohorts.set(r.cohort ?? "unknown", [...(cohorts.get(r.cohort ?? "unknown") ?? []), r]);
  const tiers = [...cohorts]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([cohort, rs]): TierGate => {
      const short = rs.filter(isShort).length;
      const walls = rs.map((r) => r.wallTimeMs).sort((a, b) => a - b);
      const p95 = percentile(walls, 95);
      const verdict: TierGate["verdict"] =
        short > 0 || (p95 !== null && p95 > opts.maxP95Ms) ? "fail" : rs.length < opts.minPerTier ? "insufficient-evidence" : "pass";
      return { cohort, n: rs.length, short, upperBound: failureUpperBound(short, rs.length), p95WallMs: p95, verdict };
    });
  const verdict = tiers.some((t) => t.verdict === "fail")
    ? "fail"
    : tiers.length === 0 || tiers.some((t) => t.verdict === "insufficient-evidence")
      ? "insufficient-evidence"
      : "pass";
  return { tiers, verdict };
}

// Interleave rating candidates across samples (round-robin) so a rating session
// covers every fixture and repeat instead of exhausting the first file order.
export function interleave<T>(groups: T[][]): T[] {
  const out: T[] = [];
  for (let i = 0; groups.some((g) => i < g.length); i++) {
    for (const g of groups) if (i < g.length) out.push(g[i]);
  }
  return out;
}

export type CompareRow = {
  fixture: string;
  samples: number;
  shortRate: number;
  p95WallMs: number | null;
  dollarsPerSet: number | null;
  wrongAnswerRate: number | null;
  avgRating: number | null;
  rungsKept: Record<string, number>;
};

export function summarizeRun(records: RunRecord[], ratings: Rating[]): Map<string, CompareRow> {
  const bySample = new Map(records.map((r) => [recordSampleId(r), r]));
  const out = new Map<string, CompareRow>();
  const groups = new Map<string, RunRecord[]>();
  for (const r of records) groups.set(r.id, [...(groups.get(r.id) ?? []), r]);
  for (const [fixture, rs] of groups) {
    const walls = rs.map((r) => r.wallTimeMs).sort((a, b) => a - b);
    const priced = rs.filter((r) => r.dollars != null);
    const fixtureRatings = ratings.filter((x) => bySample.get(x.sampleId ?? x.id)?.id === fixture);
    const scored = fixtureRatings.filter((x) => x.rating != null);
    const judged = fixtureRatings.filter((x) => x.correct != null);
    const rungsKept: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(r.rungsKept ?? {})) rungsKept[k] = (rungsKept[k] ?? 0) + v;
    out.set(fixture, {
      fixture,
      samples: rs.length,
      shortRate: rs.filter(isShort).length / rs.length,
      p95WallMs: percentile(walls, 95),
      dollarsPerSet: priced.length ? priced.reduce((s, r) => s + (r.dollars ?? 0), 0) / priced.length : null,
      wrongAnswerRate: judged.length ? judged.filter((x) => x.correct === false).length / judged.length : null,
      avgRating: scored.length ? scored.reduce((s, x) => s + (x.rating ?? 0), 0) / scored.length : null,
      rungsKept,
    });
  }
  return out;
}
