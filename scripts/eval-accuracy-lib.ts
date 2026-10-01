// Pure logic for scripts/eval-accuracy.ts: how an item is judged, how the judges are
// picked, and how results roll up. No model calls here, so it's covered by npm run check.
//
// The judging protocol exists to make an Opus-judged accuracy number affordable.
// Solving every item on Opus is the expensive part, so:
//   1. A cheap judge from a DIFFERENT model family solves the item blind. If it
//      agrees with the writer, the item counts as correct without Opus.
//   2. Disagreement, an "ambiguous" flag or an error goes to Opus (the same blind
//      solve prompt the production solver uses).
//   3. A deterministic sample of cheap agreements is also sent to Opus (the audit),
//      which measures how often two cheap models agree on a WRONG answer, the one
//      failure step 1 can't see.
// "Wrong" always takes two solvers agreeing with each other against the writer (Opus +
// cheap judge, or Opus twice), so one flaky solve can't mark an item wrong.
import { answersMatch, parseNumericAnswer } from "@/lib/generation/answer-match";
import type { AnswerFormat, Tier } from "@/lib/generation/plan";
import { parseLadder, type RungConfig } from "@/lib/generation/cascade/ladder";
import { failureUpperBound } from "./eval-lib";
import { familyOf } from "@/lib/generation/cascade/openweight-call";
// Moved to lib (the cascade's cheap verifiers use them too); re-exported for the scripts.
export {
  familyOf,
  MAX_RETRIES,
  readToolCall,
  RETRYABLE_STATUS,
  retryDelayMs,
  toolChoiceFor,
  type ChatToolResponse,
  type Family,
} from "@/lib/generation/cascade/openweight-call";

export type SolveObs = { kind: "answer"; answer: string } | { kind: "ambiguous"; note: string } | { kind: "error"; message: string };

export type Verdict = "correct" | "wrong" | "ill-posed" | "unresolved" | "not-judgeable";

export type JudgeInput = {
  writerAnswer: string;
  format: AnswerFormat;
  cheap?: SolveObs;
  opus: SolveObs[];
  audit: boolean;
  equiv?: Record<string, boolean>; // equivalence verdicts already obtained, by equivKey
};

export type JudgeStep =
  | { need: "cheap" }
  | { need: "opus" }
  | { need: "equiv"; a: string; b: string } // ask whether these two answers are the same answer
  | { verdict: Verdict; basis: string };

// Most Opus solves one item can use: a first opinion plus one tie-breaker.
export const MAX_OPUS_SOLVES = 2;

// Order-independent, so "a vs b" and "b vs a" share one equivalence call.
export const equivKey = (a: string, b: string) => [a.trim(), b.trim()].sort().join("\u0000");

// Do two final answers say the same thing? true/false when that's decidable by rule,
// undefined when it takes the equivalence model.
//   - exact (strict) match: always the same answer.
//   - integer: the loose rule is definitive (it already ignores "x =" and trailing
//     units), so never pay for a model call there. numeric: a loose match is
//     definitive, a miss goes to the model (multi-part answers).
//   - expression/short-text: wording, notation and multi-part formatting vary too much
//     for a string rule ("x = 10, \; -5" vs "x = 10, x = -5"), so a cheap model decides.
export function answerMatch(a: string, b: string, format: AnswerFormat, equiv: Record<string, boolean> = {}): boolean | undefined {
  if (!a.trim() || !b.trim()) return false; // two empty answers are not agreement
  if (answersMatch(a, b, { format, strictness: "strict" })) return true;
  if (format === "integer") return answersMatch(a, b, { format, strictness: "loose" });
  // A loose numeric match is definitive; a miss isn't, because a numeric answer can
  // have several parts ("pH = 4.14; percent ionization = 0.048%") that no string
  // rule lines up.
  if (format === "numeric" && answersMatch(a, b, { format, strictness: "loose" })) return true;
  // Two plain numbers are decided by rule in every format. The thinking-off
  // equivalence model called "2" and "8/3" the same answer about 1 time in 40.
  if (parseNumericAnswer(a) != null && parseNumericAnswer(b) != null) return answersMatch(a, b, { format, strictness: "loose" });
  return equiv[equivKey(a, b)];
}

// The next thing an item needs, or its verdict. Called after every solve or
// equivalence check.
export function judgeStep(x: JudgeInput): JudgeStep {
  const { writerAnswer, format, cheap, opus, audit, equiv = {} } = x;
  if (format === "open") return { verdict: "not-judgeable", basis: "open-format" };
  if (!cheap) return { need: "cheap" };

  // Each comparison either resolves or names the equivalence check it's waiting on.
  let pending: JudgeStep | null = null;
  const same = (o: SolveObs | undefined, answer: string): boolean => {
    if (o?.kind !== "answer") return false;
    const r = answerMatch(o.answer, answer, format, equiv);
    if (r === undefined) pending ??= { need: "equiv", a: o.answer, b: answer };
    return r === true;
  };

  const cheapAgrees = same(cheap, writerAnswer);
  if (pending) return pending;
  if (cheapAgrees && !audit) return { verdict: "correct", basis: "cheap-agree" };
  if (opus.length === 0) return { need: "opus" };

  const [o1, o2] = opus;
  const o1Writer = same(o1, writerAnswer);
  if (pending) return pending;
  if (o1Writer) return { verdict: "correct", basis: cheapAgrees ? "audit-agree" : "opus-agree" };
  // Opus disagrees and the cheap judge independently reached Opus's answer.
  if (o1.kind === "answer" && cheap.kind === "answer" && !cheapAgrees) {
    const o1Cheap = same(o1, cheap.answer);
    if (pending) return pending;
    if (o1Cheap) return { verdict: "wrong", basis: "opus+cheap" };
  }
  if (o1.kind === "ambiguous" && cheap.kind === "ambiguous") return { verdict: "ill-posed", basis: "opus+cheap-ambiguous" };

  // Anything else needs a second Opus solve to break the tie.
  if (!o2) return opus.length < MAX_OPUS_SOLVES ? { need: "opus" } : { verdict: "unresolved", basis: "opus-budget" };
  const o2Writer = same(o2, writerAnswer);
  if (pending) return pending;
  if (o2Writer) return { verdict: "correct", basis: "opus-split" };
  if (o1.kind === "answer" && o2.kind === "answer") {
    const o1o2 = same(o1, o2.answer);
    if (pending) return pending;
    if (o1o2) return { verdict: "wrong", basis: cheapAgrees ? "audit-opus-twice" : "opus-twice" };
  }
  if (o1.kind === "ambiguous" && o2.kind === "ambiguous") return { verdict: "ill-posed", basis: "opus-twice-ambiguous" };
  return { verdict: "unresolved", basis: "no-agreement" };
}

// ---------------------------------------------------------------------------
// Judges
// ---------------------------------------------------------------------------

export const DEFAULT_CHEAP_JUDGES = {
  glm: "openweight:zai-org/GLM-5.3",
  deepseek: "openweight:deepseek-ai/DeepSeek-V4.1-Flash@medium",
} as const;

// Decides whether two differently written answers are the same answer (never solves).
// Admitted as an easy rung: thinking off with a forced tool call, 6-7s.
export const EQUIV_JUDGE = "openweight:deepseek-ai/DeepSeek-V4.1-Flash";

// A cheap judge must come from a different family than the writer, or the two
// agreeing says little: same-family models tend to make the same mistakes.
export function cheapJudgeFor(writerModel: string, override?: string): string {
  if (override) {
    const judgeModel = specModel(override);
    if (familyOf(judgeModel) === familyOf(writerModel) && familyOf(writerModel) !== "other") {
      throw new Error(`--cheap-judge ${override} is the same model family as the writer ${writerModel}; pick a different family.`);
    }
    return override;
  }
  return familyOf(writerModel) === "glm" ? DEFAULT_CHEAP_JUDGES.deepseek : DEFAULT_CHEAP_JUDGES.glm;
}

// "provider:model[@thinking]" → model.
export function specModel(spec: string): string {
  const rest = spec.slice(spec.indexOf(":") + 1);
  const at = rest.lastIndexOf("@");
  return at > 0 ? rest.slice(0, at) : rest;
}

// Deterministic audit sample: the same item is audited on every resume.
export function auditPick(id: string, rate: number): boolean {
  if (rate <= 0) return false;
  if (rate >= 1) return true;
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) / 2 ** 32 < rate;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type RungUnderTest = { tier: Tier; spec: string; rung: RungConfig };

export type AccuracyArgs = {
  rungs: RungUnderTest[];
  perTier: number;
  audit: number;
  judgeModel: string;
  cheapJudge?: string;
  out: string;
  concurrency: number;
  maxDollars: number;
  timeoutS?: number;
  yes: boolean;
  dryRun: boolean;
  contestOnly: boolean; // only fixtures whose plan names a competition (AMC, AIME, F=ma)
  summary?: string;
};

export class AccuracyArgError extends Error {}

export const ACCURACY_USAGE = `Usage:
  npm run eval:accuracy -- --dry-run --rung easy=openweight:deepseek-ai/DeepSeek-V4.1-Flash [--rung mid=...] [--per-tier 30]
  npm run eval:accuracy -- --yes --rung TIER=provider:model[@thinking] [...] [--per-tier 30] [--audit 0.15]
       [--judge-model claude-opus-5-5] [--cheap-judge provider:model] [--out runs/accuracy.jsonl]
       [--concurrency N, default: every item at once] [--max-dollars 20] [--timeout seconds] [--contest-only]
  npm run eval:accuracy -- --summary runs/accuracy.jsonl

  --rung TIER=SPEC   the rung under test, as it would appear in GENERATION_LADDER_<TIER>; repeatable
  --audit R          share of cheap-judge agreements also re-solved by Opus (default 0.15)
  --timeout S        overrides the rung deadline (default: the rung's real ladder deadline)
  --out FILE         JSONL; an existing file is resumed (finished items are skipped)
  --contest-only     only fixtures whose plan names a competition (AMC, AIME, F=ma)`;

const TIERS: readonly Tier[] = ["easy", "mid", "hard"];

export function parseAccuracyArgs(argv: string[]): AccuracyArgs {
  const flags = new Set(["--yes", "--dry-run", "--contest-only"]);
  const valued = new Set(["--rung", "--per-tier", "--audit", "--judge-model", "--cheap-judge", "--out", "--concurrency", "--max-dollars", "--timeout", "--summary"]);
  const rungs: RungUnderTest[] = [];
  const vals = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (flags.has(a)) continue;
    if (!valued.has(a)) throw new AccuracyArgError(`Unknown argument ${a}.`);
    const v = argv[++i];
    if (v === undefined || v.startsWith("--")) throw new AccuracyArgError(`${a} needs a value.`);
    if (a === "--rung") {
      const eq = v.indexOf("=");
      const tier = v.slice(0, eq) as Tier;
      const spec = v.slice(eq + 1);
      if (eq < 0 || !TIERS.includes(tier) || !spec) throw new AccuracyArgError(`--rung ${v} must look like TIER=provider:model[@thinking], TIER one of easy, mid, hard.`);
      let rung: RungConfig;
      try {
        // Parsed as a cheap rung (not the top), like gen:admit, so it gets the tier's cheap-rung settings.
        [rung] = parseLadder(tier, `${spec},anthropic:claude-opus-5-5`);
      } catch (e) {
        throw new AccuracyArgError(e instanceof Error ? e.message : String(e));
      }
      if (rungs.some((r) => r.tier === tier && r.spec === spec)) throw new AccuracyArgError(`--rung ${v} is listed twice.`);
      rungs.push({ tier, spec, rung });
    } else vals.set(a, v);
  }
  const num = (k: string, dflt: number, ok: (n: number) => boolean) => {
    const raw = vals.get(k);
    if (raw === undefined) return dflt;
    const n = Number(raw);
    if (!ok(n)) throw new AccuracyArgError(`${k} ${raw} is out of range.`);
    return n;
  };
  const summary = vals.get("--summary");
  if (!summary && rungs.length === 0) throw new AccuracyArgError("Pass at least one --rung.");
  const timeoutRaw = vals.get("--timeout");
  return {
    rungs,
    perTier: num("--per-tier", 30, (n) => Number.isInteger(n) && n >= 1 && n <= 500),
    audit: num("--audit", 0.15, (n) => n >= 0 && n <= 1),
    judgeModel: vals.get("--judge-model") ?? "claude-opus-5-5",
    cheapJudge: vals.get("--cheap-judge"),
    out: vals.get("--out") ?? `runs/accuracy-${Date.now()}.jsonl`,
    // Default: every item at once. --max-dollars is checked before an item starts, so
    // with no limit here it can't stop a run partway; pass a small N to keep it meaningful.
    concurrency: vals.has("--concurrency") ? num("--concurrency", 4, (n) => Number.isInteger(n) && n >= 1) : Infinity,
    maxDollars: num("--max-dollars", 20, (n) => n > 0),
    timeoutS: timeoutRaw === undefined ? undefined : num("--timeout", 0, (n) => n > 0),
    yes: argv.includes("--yes"),
    dryRun: argv.includes("--dry-run"),
    contestOnly: argv.includes("--contest-only"),
    summary,
  };
}

// ---------------------------------------------------------------------------
// Records and summary
// ---------------------------------------------------------------------------

export type ItemRecord = {
  id: string; // `${tier}|${spec}|${index}` — the resume key
  tier: Tier;
  rung: string;
  index: number;
  fixtureId: string;
  answerFormat: AnswerFormat;
  write: { ok: true; ms: number; problem: string; answer: string; solution: string } | { ok: false; ms: number; finish: string; message: string };
  guard: string | null; // cascadeCheck rejection; a rejected item never ships, so it isn't judged
  cheapJudge?: string;
  cheap?: SolveObs;
  opus: SolveObs[];
  equiv?: Record<string, boolean>; // equivalence-model verdicts, by equivKey
  audited: boolean;
  verdict?: Verdict;
  basis?: string;
  dollars: number;
  unpriced: string[];
};

export const itemId = (tier: Tier, spec: string, index: number) => `${tier}|${spec}|${index}`;

export type AccuracyRow = {
  tier: Tier;
  rung: string;
  attempted: number;
  writeFailed: number;
  guardRejected: number;
  judged: number; // correct + wrong + ill-posed
  correct: number;
  wrong: number;
  illPosed: number;
  unresolved: number;
  wrongRate: number | null; // (wrong + ill-posed) / judged
  upperBound: number | null; // one-sided 95%
  audited: number;
  auditCaught: number; // audited cheap agreements that turned out wrong
  opusSolves: number;
  dollars: number;
  unpriced: string[];
};

export function summarizeAccuracy(records: ItemRecord[]): AccuracyRow[] {
  const groups = new Map<string, ItemRecord[]>();
  for (const r of records) {
    const k = `${r.tier}\u0000${r.rung}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const order = (t: Tier) => TIERS.indexOf(t);
  return [...groups.values()]
    .map((rs): AccuracyRow => {
      const count = (v: Verdict) => rs.filter((r) => r.verdict === v).length;
      const correct = count("correct");
      const wrong = count("wrong");
      const illPosed = count("ill-posed");
      const judged = correct + wrong + illPosed;
      const bad = wrong + illPosed;
      const audited = rs.filter((r) => r.audited && r.verdict && r.verdict !== "not-judgeable");
      return {
        tier: rs[0].tier,
        rung: rs[0].rung,
        attempted: rs.length,
        writeFailed: rs.filter((r) => !r.write.ok).length,
        guardRejected: rs.filter((r) => r.write.ok && r.guard).length,
        judged,
        correct,
        wrong,
        illPosed,
        unresolved: count("unresolved"),
        wrongRate: judged ? bad / judged : null,
        upperBound: judged ? failureUpperBound(bad, judged) : null,
        audited: audited.length,
        auditCaught: audited.filter((r) => r.verdict === "wrong" || r.verdict === "ill-posed").length,
        opusSolves: rs.reduce((n, r) => n + r.opus.length, 0),
        dollars: rs.reduce((n, r) => n + r.dollars, 0),
        unpriced: [...new Set(rs.flatMap((r) => r.unpriced))],
      };
    })
    .sort((a, b) => order(a.tier) - order(b.tier) || a.rung.localeCompare(b.rung));
}

// Rough spend for --dry-run. Opus 5.5 is $4/$20 per M tokens; one blind solve is
// capped at JUDGE_MAX_TOKENS output, so a solve costs at most about $0.35 on the hard
// tier and much less on easy. The expected case assumes a quarter of items disagree.
export const JUDGE_MAX_TOKENS: Record<Tier, number> = { easy: 4000, mid: 8000, hard: 16000 };
const OPUS_OUT_PER_TOKEN = 20 / 1_000_000;
const EXPECTED_DISAGREE = 0.25;
const CHEAP_PER_ITEM = 0.01; // writer + cheap judge on DeepInfra, generously rounded up

export function estimateDollars(rungs: { tier: Tier }[], perTier: number, audit: number): { expected: number; worst: number } {
  let expected = 0;
  let worst = 0;
  for (const { tier } of rungs) {
    const maxSolve = JUDGE_MAX_TOKENS[tier] * OPUS_OUT_PER_TOKEN + 0.01;
    const typicalSolve = maxSolve * 0.5;
    const opusShare = EXPECTED_DISAGREE * 1.5 + (1 - EXPECTED_DISAGREE) * audit;
    expected += perTier * (CHEAP_PER_ITEM + opusShare * typicalSolve);
    worst += perTier * (CHEAP_PER_ITEM + MAX_OPUS_SOLVES * maxSolve);
  }
  return { expected, worst };
}
