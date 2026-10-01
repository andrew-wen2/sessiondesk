// Cascade pipeline entry point: same input and result shape as the legacy
// generateProblems(), so the route doesn't care which one ran. problems.ts dispatches
// here after planning when pipelineFor(tier) is "cascade".
//
// Per request: plan (already done) → retrieve anchors/seeds → build candidate specs →
// runCascade over the tier's ladder → map the result into genMeta.
//
// Hard-tier variants write the variant and its FULL solution in one call (the
// statement-only re-solve framing, `adapt: false`), then the independent solver checks
// the answer. The legacy seed-sketch → transpose → expand chain is not used: its only
// purpose was to fit a set of long solutions into one call, and here every call writes
// exactly one problem.
import Anthropic from "@anthropic-ai/sdk";
import { buildConstructPrompt, buildPrompt, buildReversePrompt, type ConstructTarget } from "@/lib/generation-prompt";
import { reverseKeyProblem } from "@/lib/generation/cascade/reverse";
import { getAnchors, getAnchorsByIds, getReferencesAt, getStatements } from "@/lib/corpus-retrieval";
import { corpusDifficulty, idsInRatingWindow, targetRating } from "@/lib/generation/corpus-difficulty";
import { countForTier } from "@/lib/calibration";
import { envOr, SOLVER_CLIENT_TIMEOUT_MS, solverConfig } from "@/lib/generation/config";
import { answerMatchesSolution, answerOkFor, nearCopyOf, problemOk, solutionMetaOk, solutionOk, tooSimilarToSeed } from "@/lib/generation/verifier";
import { solveProblem } from "@/lib/generation/solve";
import { evaluateAnswer } from "@/lib/generation/answer-match";
import { checkAnswer } from "@/lib/generation/answer-check";
import { geminiClient } from "@/lib/generation/gemini-call";
import { costForRun } from "@/lib/generation/pricing";
import type { DropReason, GenerationRunMeta, CandidateRejection } from "@/lib/generation/gen-meta";
import type { GenerationPlan } from "@/lib/generation/plan";
import type { UsageAccountant } from "@/lib/generation/usage-accounting";
import type { Anchor, Problem } from "@/lib/types";
import { ladderFor, LadderConfigError, parseRungSpec, type RungConfig, type RungProvider } from "@/lib/generation/cascade/ladder";
import { ladderFeasibility, USABLE_BUDGET_MS } from "@/lib/generation/cascade/deadline";
import { buildSpecs, composeUpperSlots } from "@/lib/generation/cascade/slots";
import { judgeAnchorIds, placeProblem, type RatedAnchor } from "@/lib/generation/cascade/difficulty-judge";
import { calibrationFor, judgeScaleTarget } from "@/lib/generation/judge-calibration";
import { buildTargetFor, maxNumberFor, stableHash, targetNumbers } from "@/lib/generation/cascade/targets";
import { excludeSimilar, problemTypes, rotateTypes, typesModelFromEnv } from "@/lib/generation/cascade/problem-types";
import { taxonomySlots } from "@/lib/generation/cascade/taxonomy-slots";
import { assignSeeds, pickSeeds, seedFitsContest, seedSourcesFor, type SeedPick } from "@/lib/generation/cascade/seed-slots";
import { taxonomyTypes, typeIdOf } from "@/lib/generation/taxonomy";
import { sameMethodAs, type Prior } from "@/lib/generation/cascade/method-dedup";
import type { RecentMemory } from "@/lib/generation/recent-problems";
import { runCascade, type RunInput, type Verify } from "@/lib/generation/cascade/run";
import type { CandidateSpec } from "@/lib/generation/cascade/scheduler";
import { anthropicWriter, geminiWriter, openWeightWriter, type Writers } from "@/lib/generation/cascade/writers";
import { Semaphore } from "@/lib/generation/cascade/semaphore";
import type { SolverObservation } from "@/lib/generation/cascade/verify-policy";
import { decideDifficulty, difficultyConfigFromEnv, measureDifficulty, type DifficultyConfig } from "@/lib/generation/cascade/difficulty-filter";
import { cheapConfigFromEnv, cheapVerify, familyProblem, openWeightCaller, type CallOpenWeight, type CheapConfig } from "@/lib/generation/cascade/verify-cheap";
import { programSolve } from "@/lib/generation/cascade/program-solver";
import { anthropicToolCaller, geminiToolCaller, multiProviderCaller } from "@/lib/generation/cascade/tool-caller";
import { familyOf } from "@/lib/generation/cascade/openweight-call";

export type CascadeInput = {
  profile: string;
  topic: string;
  recentTopics: string[];
  accountant: UsageAccountant;
  plan: GenerationPlan;
  startedAt?: number; // epoch ms the request began; the deadline counts from here
  rotationKey?: string; // varies the reference problems per session/attempt (targets.ts)
  recentProblems?: string[]; // the student's recent-session problems: never repeated
  recentMemory?: RecentMemory; // what recent sets' genMeta says they practiced
  signal?: AbortSignal;
  writers?: Writers; // tests inject fakes; production builds them from env
  cheapCall?: CallOpenWeight; // tests inject a fake host for the cheap verifiers
  programCall?: CallOpenWeight; // tests inject a fake caller for the blind program solver
  judgeCall?: CallOpenWeight; // tests inject a fake caller for the difficulty judge
  judgeAnchors?: RatedAnchor[]; // tests inject rated anchors (production reads the corpus)
};

export type CascadeResult =
  | { ok: true; problems: Problem[]; plan: GenerationPlan; count: number; meta: GenerationRunMeta }
  | { ok: false; error: string; meta: GenerationRunMeta };

// Spare specs beyond the objectives, first-wave backups, and the physical call cap.
// 20, not 10: with typed slots and cheap verification about 40% of candidates are
// rejected, and 10 spares ran out mid-set ("no distinct candidates left"). Spend and
// time stay bounded by CASCADE_MAX_CALLS and the deadline.
export const SPARES = 20;
// Extra real problems held back for seeded slots whose first variant is rejected.
export const SEED_SPARES = 10;
// The rating window above the hardest target: variants measured about 0.02 easier than
// the real problems they came from, so seeds may sit a little above the band.
const SEED_WINDOW_ABOVE = 0.03;
const BACKUPS = 3;
// First-wave candidates per objective (CASCADE_FIRST_WAVE, default 1 = one each plus
// BACKUPS). With k > 1 every objective races k candidates from the start; the first to
// pass fills it and its siblings are cancelled (the scheduler already does both). A
// failed candidate then rarely leaves its objective empty after the replacement cutoff,
// which is what killed most GLM sets (39% of writes hit the 90s deadline). Racing per
// objective, not "first 10 of any", keeps the review's fix for arrival-order bias: fast
// candidates are the easy ones, so a free-for-all would skew the set easy.
//
// Per tier: CASCADE_FIRST_WAVE_<TIER>, else CASCADE_FIRST_WAVE, else the tier default. Mid
// defaults to 3 (docs/designs/generation-research.md, "Mid-tier options"): at high
// thinking about 1 in 5 GLM writes think until the token cap and write nothing, a slot's
// replacement can only start in the first ~125s, and one candidate per slot completed 1
// of 10 real mid-tier sets. Replaying 16 measured writes through these timing rules:
// 1 candidate 22%, 2 → 83–88%, 3 → 97%; on a host 1.6x slower, 2 → 26%, 3 → 62%.
// Easy already completes ~100% with 1, so it keeps 1 (racing only adds spend).
export const FIRST_WAVE_DEFAULTS: Record<GenerationPlan["tier"], number> = { easy: 1, mid: 3, hard: 1 };
export function firstWaveFromEnv(tier: GenerationPlan["tier"]): number {
  const raw = envOr(`CASCADE_FIRST_WAVE_${tier.toUpperCase()}`, "") || envOr("CASCADE_FIRST_WAVE", "") || String(FIRST_WAVE_DEFAULTS[tier]);
  const k = Math.floor(Number(raw));
  return Number.isFinite(k) && k >= 1 ? Math.min(k, 4) : 1;
}
const numberEnv = (name: string, fallback: number) => {
  const n = Number(envOr(name, String(fallback)));
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

// Per-provider permits, per process (see semaphore.ts for why this is per instance).
const semaphores: Partial<Record<RungProvider, Semaphore>> = {};
function semaphoreFor(p: RungProvider): Semaphore {
  // Open-weight: 32, so a mid-tier first wave (3 candidates x 10 slots) runs at once
  // instead of queueing behind its own permits.
  const defaults: Record<RungProvider, number> = { anthropic: 6, openweight: 32, gemini: 8 };
  return (semaphores[p] ??= new Semaphore(numberEnv(`CASCADE_CONCURRENCY_${p.toUpperCase()}`, defaults[p])));
}

// Writers are built only for providers the ladder uses, so a missing key for a
// vendor that isn't on the ladder never matters.
export function writersFor(providers: Set<RungProvider>): Writers {
  const writers: Writers = {};
  if (providers.has("anthropic")) writers.anthropic = anthropicWriter(new Anthropic({ maxRetries: 0 }));
  if (providers.has("gemini")) writers.gemini = geminiWriter(geminiClient());
  if (providers.has("openweight")) {
    const baseUrl = envOr("OPENWEIGHT_BASE_URL", "");
    const apiKey = envOr("OPENWEIGHT_API_KEY", "");
    const firstTokenSeconds = Number(envOr("CASCADE_FIRST_TOKEN_SECONDS", ""));
    const firstTokenMs = Number.isFinite(firstTokenSeconds) && firstTokenSeconds > 0 ? firstTokenSeconds * 1000 : undefined;
    if (baseUrl && apiKey) writers.openweight = openWeightWriter({ baseUrl, apiKey, firstTokenMs });
  }
  return writers;
}

// Tutor-facing error copy per failure cause: "[what failed] — [what to do]".
export const CASCADE_ERRORS = {
  providerDown: "Generation service is unavailable — try again in a few minutes.",
  outOfTime: "Generation ran out of time — try again.",
  exhausted: "Couldn't find enough distinct problems for this topic — broaden the student profile or topic, then try again.",
  misconfigured: "Problem generation is misconfigured — check the server logs.",
} as const;

const REJECTION_DROP: Record<CandidateRejection, DropReason> = {
  "guard-problem": "malformed-statement",
  "guard-solution": "backtracking",
  "guard-answer": "bad-answer-format",
  duplicate: "near-duplicate",
  "solver-disagree": "solver-no-consensus",
  "solver-ambiguous": "solver-ambiguous",
  "guard-consistency": "answer-contradicts-solution",
  invalid: "ill-posed",
  "too-easy": "difficulty-off-target",
  "too-hard": "difficulty-off-target",
  "guard-program": "answer-contradicts-program",
  "guard-reverse": "reverse-key-unverified",
};

const anchorLabel = (a: Anchor) => `${a.source}${a.number != null ? `#${a.number}` : ""}`;

// How scratch (non-seed) candidates are written: "construct" builds each problem
// backward from an answer it picks first (buildConstructPrompt, measured 2x faster and
// fewer failed writes than the classic prompt plus an override); "classic" is the
// cascade's original buildPrompt. Seed-based variants always use buildPrompt.
export type ScratchPrompt = "construct" | "classic";
export function scratchPromptFromEnv(): ScratchPrompt {
  const v = envOr("CASCADE_SCRATCH_PROMPT", "construct");
  if (v !== "construct" && v !== "classic") throw new LadderConfigError(`CASCADE_SCRATCH_PROMPT must be construct or classic, got "${v}"`);
  return v;
}

// The prompt for one candidate. Shared with scripts/gen-slot.ts so a reproduced slot
// sees exactly what the pipeline would have sent.
export function cascadeRequestBuilder(args: {
  plan: GenerationPlan;
  profile: string;
  topic: string;
  recentTopics: string[];
  pool: Anchor[]; // variant seeds (indexed by spec.seedIndex)
  calibration: Anchor[]; // shared calibration anchors for scratch candidates
  count: number;
  scratchPrompt?: ScratchPrompt; // default "classic", so existing callers are unchanged
  // Seeded scratch slots (seed-slots.ts): a spec with a seedIndex is a construct-prompt
  // variant of that real problem, not a hard-tier transposition.
  seededScratch?: boolean;
  // Per-objective difficulty target and reference (see targets.ts); scratch + construct only.
  targetFor?: (objective: number, spec: CandidateSpec) => ConstructTarget | undefined;
  seen?: string[]; // the student's recent-session problems (construct prompt only)
  // Which writers also write their own answerCheck program (construct prompt only).
  writerProgram?: (rung: RungConfig) => boolean;
}): RunInput["buildRequest"] {
  const { plan, profile, topic, recentTopics, pool, calibration, count, scratchPrompt = "classic", targetFor, seen, writerProgram, seededScratch = false } = args;
  return ({ objective, spec, kept, rung }) =>
    spec.reverse && spec.seedIndex !== undefined
      ? buildReversePrompt({ plan, seed: pool[spec.seedIndex], avoidStatements: kept.map((p) => p.problem), slot: { index: objective, of: count, hint: spec.hint } })
      : (spec.seedIndex === undefined || seededScratch) && scratchPrompt === "construct"
      ? buildConstructPrompt({
          plan,
          profile,
          topic,
          recentTopics,
          anchors: calibration,
          avoidStatements: kept.map((p) => p.problem),
          slot: { index: objective, of: count, hint: spec.hint },
          output: "problems",
          target: targetFor?.(objective, spec),
          seenStatements: seen,
          answerCheck: writerProgram?.(rung) ?? false,
          seed: seededScratch && spec.seedIndex !== undefined ? pool[spec.seedIndex] : undefined,
        })
      : buildPrompt({
      plan,
      profile,
      topic,
      count: 1,
      recentTopics,
      anchors: spec.seedIndex !== undefined ? [pool[spec.seedIndex]] : calibration,
      mode: spec.seedIndex !== undefined ? "variant" : "scratch",
      adapt: false,
      avoidStatements: kept.map((p) => p.problem),
      slot: { index: objective, of: count, hint: spec.hint },
    });
}

// The deterministic guards every candidate must pass before it can be kept. The
// consistency guard is cascade-only: the answer field must equal what the solution
// works out to, and the solution must not call the problem itself broken. The program
// guard (answer-check.ts) runs last and only when enabled: the writer's answerCheck
// program must not compute a different answer. All of these run before any paid
// verification, so a wrong key found here costs nothing more.
export type AnswerCheckStats = { match: number; mismatch: number; abstain: number };
export function cascadeCheck(plan: GenerationPlan, program?: AnswerCheckStats, pool: Anchor[] = []): RunInput["check"] {
  return (p, spec) => {
    const guard = !problemOk(p, plan)
      ? "guard-problem"
      : !solutionOk(p, plan)
        ? "guard-solution"
        : !answerOkFor(p, plan)
          ? "guard-answer"
          : !answerMatchesSolution(p) || !solutionMetaOk(p)
            ? "guard-consistency"
            : null;
    if (guard) return guard;
    if (spec?.reverse && spec.seedIndex !== undefined) {
      const why = reverseKeyProblem(p, pool[spec.seedIndex]);
      if (why) {
        console.warn(`[cascade] reversed seed rejected: ${why}`);
        return "guard-reverse";
      }
    }
    if (!program || plan.answerFormat === "open") return null;
    const c = checkAnswer(p.answerCheck, evaluateAnswer(p.answer));
    program[c.kind]++;
    if (c.kind === "mismatch") {
      console.warn(`[cascade] answer check computed ${c.value}, stated ${p.answer}: ${p.problem.replace(/\s+/g, " ").slice(0, 120)}`);
      return "guard-program";
    }
    return null;
  };
}

// Writers that write their own answerCheck: those that reason in a thinking block
// (Anthropic with thinking on). A cheap writer asked for one worked the check out loud
// and leaked "wait, ..." corrections into 14 of 19 solutions (Gemini Flash), so for
// every other writer the blind program solver computes the check instead.
export function writesOwnProgram(rung: RungConfig): boolean {
  return rung.provider === "anthropic" && rung.thinking !== "off";
}

// Blind program solvers, in preference order; the first from a model family other than
// the candidate's writer is used. Measured on 80 real AMC #1–15 problems: Gemini Flash
// (thinking low) computed 74 with 2 wrong in 21s; DeepSeek Flash (low) 72 with 2 wrong
// in 40s; DeepSeek with thinking off got 43% of its values wrong and is not usable.
// The default is open-weight only (2026-10: Gemini is opt-in everywhere).
// GLM-5.3 is second so a DeepSeek-written candidate still has a
// solver from another family; GLM has NOT been measured as a program solver.
// "gemini:gemini-3.8-flash@low" can be put back in front through CASCADE_PROGRAM_SOLVERS.
// The same-practice judge for method-level dedup: a classification, fast with thinking off.
export const DEFAULT_METHOD_JUDGE = "openweight:deepseek-ai/DeepSeek-V4.1-Flash@off";

export const DEFAULT_PROGRAM_SOLVERS = "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low,openweight:zai-org/GLM-5.3@low";
export function programSolversFromEnv(tier: GenerationPlan["tier"]): RungConfig[] {
  const v = envOr("CASCADE_PROGRAM_SOLVERS", DEFAULT_PROGRAM_SOLVERS).trim();
  if (v === "off") return [];
  return v.split(",").map((x) => x.trim()).filter(Boolean).map((x) => parseRungSpec(tier, x));
}
export function programSolverFor(solvers: RungConfig[], writerModel: string): RungConfig | null {
  return solvers.find((s) => familyOf(s.model) !== familyOf(writerModel)) ?? null;
}

// Difficulty judge (difficulty-judge.ts, ladder mode): places each scratch candidate on
// the corpus's human-difficulty scale (E2H ratings). Validated on 90 held-out real
// AMC 10 problems (eval:difficulty-judge): Gemini Flash Spearman 0.76 vs human rating,
// GLM-5.3 0.64, problem number itself 0.63; DeepSeek failed. Recorded per kept item;
// it rejects only when CASCADE_DIFFICULTY_TOLERANCE (in rating units) is set.
// GLM-5.3 for now (2026-10), so nothing in the default configuration needs a Gemini
// key. It tracks human ratings less closely than Gemini Flash (0.64 against 0.76) but
// has a fitted calibration for AMC 10, AMC 12 and AIME (data/judge-calibration.json);
// set CASCADE_DIFFICULTY_JUDGE="gemini:gemini-3.8-flash@low" to go back.
export const DEFAULT_DIFFICULTY_JUDGE = "openweight:zai-org/GLM-5.3@low";
export const JUDGE_ANCHORS = 8;

export function answerCheckEnabled(): boolean {
  const v = envOr("CASCADE_ANSWER_CHECK", "on");
  if (v !== "on" && v !== "off") throw new LadderConfigError(`CASCADE_ANSWER_CHECK must be on or off, got "${v}"`);
  return v === "on";
}

export async function generateProblemsCascade(input: CascadeInput): Promise<CascadeResult> {
  const { plan, profile, topic, recentTopics, accountant } = input;
  const startedAt = input.startedAt ?? Date.now();
  const count = countForTier(plan.tier);
  const mode: "variant" | "scratch" = plan.tier === "hard" && plan.competition ? "variant" : "scratch";
  const numeric = plan.contentType === "math";

  const baseMeta = (extra: Partial<GenerationRunMeta>): GenerationRunMeta => ({
    planSource: plan.source,
    tier: plan.tier,
    answerFormat: plan.answerFormat,
    competition: plan.competition,
    bandLow: plan.bandLow,
    bandHigh: plan.bandHigh,
    usage: {},
    drops: [],
    verdicts: [],
    kept: 0,
    asked: count,
    escalations: 0,
    pipeline: "cascade",
    ...extra,
  });

  let ladder;
  let scratchPrompt: ScratchPrompt;
  // Cheap verification of scratch candidates (verify-cheap.ts); CASCADE_VERIFY_SCRATCH=off disables it.
  let cheap: CheapConfig | null;
  // Typed slots (problem-types.ts); CASCADE_TYPES_MODEL=off disables them.
  let typesRung: RungConfig | null;
  // Pass-rate difficulty filter (difficulty-filter.ts); off unless CASCADE_DIFFICULTY_SOLVER is set.
  let difficulty: DifficultyConfig | null;
  let program: AnswerCheckStats | undefined;
  let programSolvers: RungConfig[] = [];
  try {
    ladder = ladderFor(plan.tier);
    scratchPrompt = scratchPromptFromEnv();
    cheap = envOr("CASCADE_VERIFY_SCRATCH", "on") === "off" || plan.answerFormat === "open" ? null : cheapConfigFromEnv(plan.tier);
    difficulty = plan.answerFormat === "open" ? null : difficultyConfigFromEnv(plan.tier);
    typesRung = typesModelFromEnv(plan.tier);
    program = answerCheckEnabled() ? { match: 0, mismatch: 0, abstain: 0 } : undefined;
    programSolvers = program && plan.answerFormat !== "open" && plan.contentType === "math" ? programSolversFromEnv(plan.tier) : [];
  } catch (e) {
    if (!(e instanceof LadderConfigError)) throw e;
    console.error(`[cascade] ladder config: ${e.message}`);
    return { ok: false, error: CASCADE_ERRORS.misconfigured, meta: baseMeta({ drops: [{ reason: "generation-failed", excerpt: e.message }] }) };
  }

  const solveCfg = solverConfig();
  // Seed-based variants are solved by the Opus solver; scratch candidates by the cheap
  // verifiers. Either way the rung budget reserves verification time.
  const verified =
    plan.answerFormat !== "open" && ((mode === "variant" && solveCfg.enabled) || cheap !== null || difficulty !== null || programSolvers.length > 0);
  const feasible = ladderFeasibility(ladder, verified, plan.tier);
  if (!feasible.topRungFits) {
    console.error(`[cascade] ${feasible.message}`);
    return { ok: false, error: CASCADE_ERRORS.misconfigured, meta: baseMeta({ drops: [{ reason: "generation-failed", excerpt: feasible.message }] }) };
  }

  // The open-weight host shared by the types call and the cheap verifiers (tests inject one).
  const baseUrl = envOr("OPENWEIGHT_BASE_URL", "");
  const apiKey = envOr("OPENWEIGHT_API_KEY", "");
  const host: CallOpenWeight | null = input.cheapCall ?? (baseUrl && apiKey ? openWeightCaller(baseUrl, apiKey) : null);
  const rotationKey = input.rotationKey ?? `${profile}|${topic}|${startedAt}`;
  const recentProblems = input.recentProblems ?? [];

  // Typed slots: a scratch set whose plan has no sub-skills (the contest fast path) gets
  // one distinct problem type per slot. Contest sets draw them from the corpus taxonomy
  // first (taxonomy-slots.ts: one selection call, sampling and recent-type exclusion in
  // code); a narrow topic with too few fresh catalog types, a non-contest set, or any
  // failure falls back to the LLM type menu, then to the old angle hints.
  const recentMemory: RecentMemory = input.recentMemory ?? { typeIds: [], methods: [] };
  let types: string[] | undefined;
  let typeIds: string[] | undefined;
  let fittingIds: string[] | undefined; // catalog types that fit today's topic (seeded slots draw from these)
  if (mode === "scratch" && !(plan.slots && plan.slots.length > 0) && typesRung && host) {
    const fromTaxonomy =
      plan.competition && envOr("CASCADE_TAXONOMY", "on") !== "off"
        ? await taxonomySlots({
            call: host,
            rung: typesRung,
            plan,
            profile,
            topic,
            recentTypeIds: recentMemory.typeIds,
            rotationKey,
            count,
            signal: AbortSignal.timeout(30_000),
            recordUsage: (u) => accountant.recordFor("plan", "openweight", typesRung!.model, u),
          })
        : null;
    fittingIds = fromTaxonomy?.fittingIds;
    const catalogTypes = fromTaxonomy?.types ?? [];
    if (fromTaxonomy) console.log(`[cascade] taxonomy: ${fromTaxonomy.fitting} types fit the topic, ${fromTaxonomy.fresh} fresh, using ${catalogTypes.length}`);
    if (catalogTypes.length >= count) {
      types = catalogTypes.map((t) => t.name);
      typeIds = catalogTypes.map((t) => t.id);
    } else {
      // Top up from the type menu, minus anything restating a chosen catalog type.
      const listed = await problemTypes({
        call: host,
        rung: typesRung,
        plan,
        profile,
        topic,
        recentProblems,
        signal: AbortSignal.timeout(30_000),
        recordUsage: (u) => accountant.recordFor("plan", "openweight", typesRung!.model, u),
      });
      const chosen = catalogTypes.map((t) => t.name);
      const topUp = rotateTypes(excludeSimilar(listed, chosen), rotationKey);
      const merged = [...chosen, ...topUp];
      if (merged.length >= 3) types = merged;
      if (catalogTypes.length > 0) typeIds = catalogTypes.map((t) => t.id);
      console.log(`[cascade] types: ${types ? `${chosen.length} from the taxonomy + ${merged.length - chosen.length} from the menu` : `none (${listed.length} listed)`}`);
    }
  }
  // Per-slot targets: contest scratch sets written with the construct prompt. Each
  // objective aims at one position in the band and is shown one real problem there.
  const offset = Number(envOr("CASCADE_TARGET_OFFSET", "0"));
  const targets =
    mode === "scratch" && scratchPrompt === "construct" && plan.competition && plan.bandLow != null && plan.bandHigh != null
      ? targetNumbers(plan.bandLow, plan.bandHigh, count, Number.isFinite(offset) ? offset : 0, maxNumberFor(plan.competition))
      : undefined;
  const refsByNumber = targets && plan.competition ? await getReferencesAt({ competition: plan.competition, numbers: targets }) : new Map<number, Anchor[]>();
  const targetFor = targets && plan.competition ? buildTargetFor({ targets, refsByNumber, rotationKey }) : undefined;
  if (targets) console.log(`[cascade] targets=[${targets.join(",")}] offset=${offset}`);

  // Seeded slots (seed-slots.ts): objectives built as variants of real problems at the
  // target positions whose type fits today's topic. Needs the taxonomy's topic fit, so a
  // set whose type selection failed stays all-scratch. CASCADE_SEED_SLOTS=off disables it.
  const targetRatings = targets && plan.competition ? targets.map((n) => targetRating(plan.competition!, n)) : [];
  const seeding = mode === "scratch" && targets && fittingIds && envOr("CASCADE_SEED_SLOTS", "on") !== "off";
  let seedCandidates: Anchor[] = [];
  // Seed-only sets (CASCADE_SEED_ONLY=on, an eval switch): every candidate, spares
  // included, is a variant of a real problem. When too few fit the topic, the rest come
  // from real problems of any type in the same rating window, and the log says how many.
  const seedOnly = seeding && envOr("CASCADE_SEED_ONLY", "off") === "on";
  // CASCADE_SEED_BORROW=off keeps seeds to the student's own contest (no HMMT for AIME).
  const seedSourcesFrom = (competition: string) => (envOr("CASCADE_SEED_BORROW", "on") === "off" ? [competition] : seedSourcesFor(competition));
  let offTopicCandidates: Anchor[] = [];
  if (seeding) {
    // Rated problems from the same contest whose human rating falls in the targets'
    // window (filtered to fitting, unused types before the query). By rating, not
    // position: AMC 10 #10–15 from 2010–14 rate 0.222 against 0.244 for 2015+, so a seed
    // at the right position from an old contest is easier than the slot. Problems at the
    // target positions count only when no target is rated. Same contest only: variants of AMC 12 #2–7 problems rated like
    // AMC 10 #10–15 were judged 0.191 against their seeds' 0.241 (2 of 17 on target),
    // while AMC 10 seeds kept 0.213 of 0.233 (12 of 24).
    const rated = targetRatings.filter((r): r is number => r != null);
    const fitting = new Set(fittingIds);
    const recentSeeds = new Set(recentMemory.seedIds ?? []);
    const windowIds =
      rated.length && plan.competition
        ? idsInRatingWindow(seedSourcesFrom(plan.competition), Math.min(...rated), Math.max(...rated) + SEED_WINDOW_ABOVE)
            .map((r) => r.id)
            .filter((id) => !recentSeeds.has(id) && fitting.has(typeIdOf(id) ?? ""))
        : [];
    seedCandidates = (rated.length ? await getAnchorsByIds(windowIds) : [...refsByNumber.values()].flat()).filter((a) => seedFitsContest(a, plan));
    if (seedOnly && rated.length && plan.competition) {
      const anyType = idsInRatingWindow(seedSourcesFrom(plan.competition), Math.min(...rated), Math.max(...rated) + SEED_WINDOW_ABOVE)
        .map((r) => r.id)
        .filter((id) => !recentSeeds.has(id) && !fitting.has(typeIdOf(id) ?? "") && typeIdOf(id));
      offTopicCandidates = (await getAnchorsByIds(anyType)).filter((a) => seedFitsContest(a, plan));
    }
  }
  const perObjective = firstWaveFromEnv(plan.tier);
  const backups = perObjective > 1 ? count * (perObjective - 1) : BACKUPS;
  const raceExtra = perObjective > 1 ? backups : 0; // specs the first wave uses beyond one per objective
  const seedPicks: SeedPick[] = seeding
    ? pickSeeds({
        candidates: seedCandidates,
        typeOf: typeIdOf,
        ratingOf: (id) => corpusDifficulty(id)?.rating,
        fittingTypeIds: new Set(fittingIds),
        recentSeedIds: recentMemory.seedIds ?? [],
        recentTypeIds: recentMemory.typeIds,
        rotationKey,
        max: count + raceExtra + (seedOnly ? SPARES : SEED_SPARES),
      })
    : [];
  if (seedOnly && seedPicks.length < count + raceExtra + SPARES) {
    const onTopic = seedPicks.length;
    seedPicks.push(
      ...pickSeeds({
        candidates: offTopicCandidates,
        typeOf: typeIdOf,
        ratingOf: (id) => corpusDifficulty(id)?.rating,
        fittingTypeIds: new Set(offTopicCandidates.map((a) => typeIdOf(a.id!)!)),
        recentSeedIds: [...(recentMemory.seedIds ?? []), ...seedPicks.map((p) => p.seed.id)],
        recentTypeIds: recentMemory.typeIds,
        rotationKey,
        max: count + raceExtra + SPARES - onTopic,
      })
    );
    console.log(`[cascade] seed-only: ${onTopic} real problems fit the topic, ${seedPicks.length - onTopic} added from other topics`);
  }
  const seededObjectives = assignSeeds(seedPicks.slice(0, count), targets ?? [], targetRatings, plan.competition);
  const seedPool: Anchor[] = seedPicks.map((p) => p.seed);
  // Scratch slots skip the types a seed already covers, so a variant and a scratch
  // problem never practice the same thing.
  if (types && seedPicks.length > 0) {
    const seededNames = new Set(taxonomyTypes().filter((t) => seedPicks.some((p) => p.typeId === t.id)).map((t) => t.name));
    const rest = types.filter((t) => !seededNames.has(t));
    types = rest.length > 0 ? rest : types;
  }

  // Two-skill composition for the upper half (slots.ts); off unless CASCADE_COMPOSE=on.
  if (types && envOr("CASCADE_COMPOSE", "off") === "on") types = composeUpperSlots(types, count);
  const specPlan = types ? { ...plan, slots: types } : plan;

  // Variant seeds: one distinct in-band seed per candidate, never widened past the band.
  // Scratch: a small shared set of calibration anchors.
  const total = count + raceExtra + SPARES;
  const ownPool: Anchor[] = plan.competition
    ? await getAnchors({
        competition: plan.competition,
        bandLow: plan.bandLow,
        bandHigh: plan.bandHigh,
        category: plan.category,
        count: mode === "variant" ? total : plan.tier === "hard" ? 6 : 4,
        strictBand: mode === "variant",
      })
    : [];
  // Hard-tier variants may also transform another contest's problem rated inside this
  // band (seed-slots.ts SEED_SOURCES: HMMT for AIME), mixed in per session so both kinds
  // lead. Own-contest problems come by position; borrowed ones only by rating.
  let pool = ownPool;
  if (mode === "variant" && plan.competition && plan.bandLow != null && plan.bandHigh != null) {
    const borrowed = seedSourcesFrom(plan.competition).filter((src) => src !== plan.competition);
    const band = Array.from({ length: plan.bandHigh - plan.bandLow + 1 }, (_, i) => targetRating(plan.competition!, plan.bandLow! + i)).filter((r): r is number => r != null);
    if (borrowed.length && band.length) {
      const ids = idsInRatingWindow(borrowed, Math.min(...band), Math.max(...band) + SEED_WINDOW_ABOVE).map((r) => r.id);
      const extra = (await getAnchorsByIds(ids)).filter((a) => seedFitsContest(a, plan));
      const key = (a: Anchor) => stableHash(`${rotationKey}|variant|${a.id ?? a.statement.slice(0, 80)}`);
      pool = [...ownPool, ...extra].sort((x, y) => key(x) - key(y)).slice(0, total);
      console.log(`[cascade] variant seeds: ${ownPool.length} ${plan.competition} + ${extra.length} rated-in-band from ${borrowed.join("/")}, using ${pool.length}`);
    }
  }
  const reverseShare = Math.min(1, Math.max(0, Number(envOr("CASCADE_REVERSE_SHARE", "0")) || 0));
  const built = buildSpecs({ plan: specPlan, mode, seeds: mode === "variant" ? pool : [], total, reverseShare });
  const seedsUsed = built.seedsUsed;
  let specs = built.specs;
  if (seedPicks.length > 0) {
    const seedSpec = (i: number): CandidateSpec => ({
      hint: `a variant of the real ${anchorLabel(seedPicks[i].seed)} shown below`,
      seedIndex: i,
      seedId: seedPicks[i].seed.id,
    });
    const scratch = [...built.specs];
    const objectives = Array.from({ length: count }, (_, o) => {
      const pick = seededObjectives.get(o);
      return pick ? seedSpec(seedPicks.indexOf(pick)) : scratch.shift()!;
    });
    // Spares: the held-back real problems first, then scratch specs.
    const unused = seedPicks.map((_, i) => i).filter((i) => ![...seededObjectives.values()].includes(seedPicks[i]));
    // Racing: the scheduler gives the b-th backup to objective b % count, so order the
    // spare seeds to hand each objective the unused real problem nearest its target.
    const ordered: number[] = [];
    for (let b = 0; b < raceExtra && unused.length > 0; b++) {
      const target = targetRatings[b % count];
      let best = 0;
      unused.forEach((i, k) => {
        const r = seedPicks[i].rating;
        const bestR = seedPicks[unused[best]].rating;
        if (target != null && r !== undefined && (bestR === undefined || Math.abs(r - target) < Math.abs(bestR - target))) best = k;
      });
      ordered.push(unused.splice(best, 1)[0]);
    }
    const spareSeeds = [...ordered, ...unused].map(seedSpec);
    specs = seedOnly && spareSeeds.length + seededObjectives.size >= count ? [...objectives, ...spareSeeds] : [...objectives, ...spareSeeds, ...scratch].slice(0, total);
  }
  const calibration = mode === "variant" ? pool.slice(0, 4) : pool;
  // Which anchors spec.seedIndex points into: hard-tier seeds, or the seeded slots' real problems.
  const specPool = mode === "variant" ? pool : seedPool;
  console.log(
    `[cascade] tier=${plan.tier} mode=${mode} ladder=[${ladder.map((r) => `${r.provider}:${r.model}`).join(",")}] seeds=${seedsUsed}/${count} seeded=${seededObjectives.size}/${count}${seedPicks.length ? ` (${seedPicks.length} real problems fit)` : ""} anchors=[${pool.map(anchorLabel).join(", ")}] verified=${verified}`
  );

  const providers = new Set(ladder.map((r) => r.provider));
  const writers = input.writers ?? writersFor(providers);
  const missing = [...providers].filter((p) => !writers[p]);
  if (missing.length > 0) {
    const msg = `no credentials configured for ${missing.join(", ")} (see .env.example)`;
    console.error(`[cascade] ${msg}`);
    return { ok: false, error: CASCADE_ERRORS.misconfigured, meta: baseMeta({ drops: [{ reason: "generation-failed", excerpt: msg }] }) };
  }

  // The cheap verifiers need a host, and every writer needs a solver outside its family.
  let cheapCall: CallOpenWeight | null = null;
  if (cheap || difficulty) {
    cheapCall = host;
    const problem = !cheapCall
      ? "no credentials configured for the cheap verifiers (OPENWEIGHT_BASE_URL/OPENWEIGHT_API_KEY)"
      : cheap
        ? familyProblem(ladder, cheap.solvers)
        : null;
    if (problem) {
      console.error(`[cascade] ${problem}`);
      return { ok: false, error: CASCADE_ERRORS.misconfigured, meta: baseMeta({ drops: [{ reason: "generation-failed", excerpt: problem }] }) };
    }
  }
  let cheapErrorsInARow = 0;

  // The blind program solver's caller: Gemini and/or the open-weight host, whichever
  // are configured. No caller → no program solves (never a failed set).
  // Tool callers for the program solver and the difficulty judge: every provider that
  // has credentials. Tests inject fakes.
  const toolCallers: Partial<Record<RungProvider, CallOpenWeight>> = {
    ...(envOr("GOOGLE_API_KEY", "") ? { gemini: geminiToolCaller(geminiClient()) } : {}),
    ...(envOr("ANTHROPIC_API_KEY", "") ? { anthropic: anthropicToolCaller(new Anthropic({ maxRetries: 0 })) } : {}),
    ...(host ? { openweight: host } : {}),
  };
  const injected = (c: CallOpenWeight | undefined) => (c ? { anthropic: c, gemini: c, openweight: c } : null);
  const programCallers = injected(input.programCall) ?? toolCallers;
  // Only solvers whose provider has credentials; none left → no program solves.
  programSolvers = programSolvers.filter((r) => programCallers[r.provider]);
  const programCall: CallOpenWeight | null = programSolvers.length === 0 ? null : multiProviderCaller(programCallers);

  // The difficulty judge, its rated anchors, and each objective's target on the judge's
  // own scale. Only for contest scratch sets with targets; any gap (no credentials, too
  // few rated anchors) just leaves placements unrecorded. Anchors span the whole contest
  // (judgeAnchorIds), the same ones the calibration was fitted with.
  const judgeSpec = envOr("CASCADE_DIFFICULTY_JUDGE", DEFAULT_DIFFICULTY_JUDGE).trim();
  const judgeCallers = injected(input.judgeCall) ?? toolCallers;
  const judgeRung = judgeSpec === "off" || !targets || !plan.competition ? null : parseRungSpec(plan.tier, judgeSpec);
  let judgeAnchors: RatedAnchor[] = input.judgeAnchors ?? [];
  if (judgeRung && judgeCallers[judgeRung.provider] && !input.judgeAnchors && targets && plan.competition) {
    const picked = judgeAnchorIds(plan.competition, JUDGE_ANCHORS);
    const statements = await getStatements(picked.map((p) => p.id));
    judgeAnchors = picked.filter((p) => statements.has(p.id)).map((p) => ({ statement: statements.get(p.id)!, rating: p.rating, label: `#${p.number}` }));
  }
  const judgeCall = judgeRung && judgeCallers[judgeRung.provider] && judgeAnchors.length >= 4 ? multiProviderCaller(judgeCallers) : null;
  // A judge compresses toward the middle, so real problems at a position don't reach
  // their own human rating on its scale (judge-calibration.ts). Each target is mapped
  // through the judge's fitted line; an uncalibrated judge falls back to the human scale.
  const judgeTargets = targetRatings.map((r) => (r == null || !plan.competition ? null : (judgeScaleTarget(judgeSpec, plan.competition, r) ?? r)));
  const judgeCalibrated = judgeCall !== null && plan.competition !== null && calibrationFor(judgeSpec, plan.competition) !== null;
  if (judgeCall && !judgeCalibrated) console.warn(`[cascade] difficulty judge ${judgeSpec} has no calibration for ${plan.competition}; comparing against human-scale targets`);
  const tolerance = Number(envOr("CASCADE_DIFFICULTY_TOLERANCE", "0"));
  const level = plan.competition ? plan.competition.replace(/^([A-Za-z]+)(\d+)$/, "$1 $2") : "";
  if (judgeCall) console.log(`[cascade] difficulty judge ${judgeRung!.model}: ${judgeAnchors.length} anchors, targets on its scale [${judgeTargets.map((r) => r?.toFixed(3) ?? "-").join(",")}]${judgeCalibrated ? "" : " (uncalibrated)"}`);
  const programStats = { agree: 0, disagree: 0, abstain: 0 };

  // Independent solver for seed-based candidates. Below the top rung one solve; at
  // the top rung three in parallel (a vote) — one solver timeout either way, which is
  // what deadline.ts budgets. Consecutive errors with no success mean the solver's
  // provider is down, which fails the set rather than shipping everything unverified.
  const solverClient = new Anthropic({ maxRetries: 0, timeout: SOLVER_CLIENT_TIMEOUT_MS });
  let solverErrorsInARow = 0;
  const verify: Verify = async (problem, spec, isTopRung, signal, writerModel, objective) => {
    // Scratch-mode candidates (seeded variants included) and reverse candidates, whose
    // key comes from the seed, get the cheap checks (uniqueness, well-posedness, the
    // program), not the Opus re-solve: the hard tier's variants are the only ones it's for.
    if (mode === "scratch" || spec.seedIndex === undefined || spec.reverse) {
      // A writer program that already matched is the program evidence; otherwise a
      // blind program solver from another model family computes the check.
      const stated = evaluateAnswer(problem.answer);
      const writerMatched = program !== undefined && checkAnswer(problem.answerCheck, stated).kind === "match";
      const programRung = programCall && stated !== null && !writerMatched ? programSolverFor(programSolvers, writerModel) : null;
      if ((!cheapCall || (!cheap && !difficulty)) && !programRung) return { observations: [], providerDown: false, notApplicable: true };
      const target = targets?.[objective];
      const [v, d, placed, prog] = await Promise.all([
        cheap && cheapCall
          ? cheapVerify({
              problem,
              plan,
              config: cheap,
              call: cheapCall,
              signal,
              recordUsage: (model, u) => accountant.recordFor("solve", "openweight", model, u),
            })
          : null,
        difficulty && cheapCall && target !== undefined
          ? measureDifficulty({
              problem,
              target,
              plan,
              config: difficulty,
              call: cheapCall,
              signal,
              recordUsage: (u) => accountant.recordFor("verification", "openweight", difficulty!.solver.model, u),
            })
          : null,
        judgeCall
          ? placeProblem({
              problem: problem.problem,
              anchors: judgeAnchors,
              mode: "ladder",
              level,
              call: judgeCall,
              rung: judgeRung!,
              signal,
              recordUsage: (u) => accountant.recordFor("verification", judgeRung!.provider, judgeRung!.model, u),
            })
          : null,
        programRung
          ? programSolve({
              call: programCall!,
              rung: programRung,
              problem: problem.problem,
              domain: plan.domain,
              signal,
              recordUsage: (u) => accountant.recordFor("solve", programRung.provider, programRung.model, u),
            })
          : null,
      ]);
      if (v) cheapErrorsInARow = v.solverErrorsOnly ? cheapErrorsInARow + 1 : 0;
      const programAgrees =
        prog?.kind === "value" && stated !== null ? Math.abs(prog.value - stated) <= 1e-6 * Math.max(1, Math.abs(prog.value), Math.abs(stated)) : null;
      if (prog) programStats[programAgrees === null ? "abstain" : programAgrees ? "agree" : "disagree"]++;
      if (v?.invalid) {
        console.warn(`[cascade] ill-posed candidate dropped: ${v.invalid}`);
        return { observations: v.observations, providerDown: cheapErrorsInARow >= 3, rejection: "invalid" };
      }
      // A program that computes a different answer is a veto, not one vote among the
      // text solvers: it exists for exactly the case where text solvers share a wrong
      // answer. Wrong on ~3% of real problems, so a veto costs about one candidate in 30.
      if (programAgrees === false) {
        // The whole statement and the program, so a veto can be audited by hand.
        const p = prog as { value: number; program: string };
        console.warn(`[cascade] program solver computed ${p.value}, stated ${problem.answer}: ${problem.problem.replace(/\s+/g, " ")} || program: ${p.program.replace(/\s+/g, " ")}`);
        return { observations: v?.observations ?? [], providerDown: cheapErrorsInARow >= 3, rejection: "guard-program" };
      }
      // A pass rate means something only against an answer the solvers confirmed.
      const confirmed = !v || (v.observations.some((o) => o.kind === "agree") && v.observations.every((o) => o.kind === "agree" || o.kind === "error"));
      const off = d && difficulty && confirmed ? decideDifficulty(d, difficulty.trials, difficulty.windows) : null;
      if (off) console.warn(`[cascade] objective ${objective} ${off}: target #${d!.target}, weak solver ${d!.solved}/${d!.answered}`);
      // Difficulty placement against the slot's target (human-rating scale). Recorded
      // always; a rejection only with a tolerance set, and only for a confirmed answer.
      const targetR = judgeTargets[objective] ?? undefined;
      const placement = placed ? { rating: Number(placed.rating.toFixed(4)), ...(targetR != null ? { target: targetR } : {}) } : undefined;
      const judged =
        placement && targetR != null && tolerance > 0 && confirmed && Math.abs(placement.rating - targetR) > tolerance
          ? placement.rating < targetR
            ? ("too-easy" as const)
            : ("too-hard" as const)
          : null;
      if (judged) console.warn(`[cascade] objective ${objective} ${judged}: judged ${placement!.rating.toFixed(3)} vs target ${targetR!.toFixed(3)}`);
      // The program's agreement counts as a vote only when no text solver disagreed, so
      // it can never outvote a disagreement (the measured "any disagreement replaces").
      const textDisagrees = v?.observations.some((o) => o.kind === "disagree") ?? false;
      const observations: SolverObservation[] = [...(v?.observations ?? []), ...(programAgrees && !textDisagrees ? [{ kind: "agree" as const }] : [])];
      return {
        observations: observations.length ? observations : [{ kind: "error", message: "not verified (CASCADE_VERIFY_SCRATCH=off)" }],
        providerDown: cheapErrorsInARow >= 3,
        ...(off ? { rejection: off } : judged ? { rejection: judged } : {}),
        ...(d ? { difficulty: d } : {}),
        ...(placement ? { placement } : {}),
      };
    }
    const once = () =>
      solveProblem({
        client: solverClient,
        model: solveCfg.model,
        escalateModel: solveCfg.escalateModel,
        effort: solveCfg.effort,
        problem: problem.problem,
        domain: plan.domain,
        rubric: plan.rubric,
        answerFormat: plan.answerFormat,
        generatorAnswer: problem.answer,
        maxEscalations: 0,
        recordUsage: (u) => accountant.recordFor("solve", "anthropic", solveCfg.model, u),
      });
    // The Opus votes measure Opus's own confidence (same model, not independent), so the
    // blind program solver, a different modality, runs beside them as a veto.
    const seedStated = evaluateAnswer(problem.answer);
    const seedProgramRung = programCall && seedStated !== null ? programSolverFor(programSolvers, writerModel) : null;
    const [outcomes, seedProg] = await Promise.all([
      Promise.all(Array.from({ length: isTopRung ? 3 : 1 }, once)),
      seedProgramRung
        ? programSolve({
            call: programCall!,
            rung: seedProgramRung,
            problem: problem.problem,
            domain: plan.domain,
            signal,
            recordUsage: (u) => accountant.recordFor("solve", seedProgramRung.provider, seedProgramRung.model, u),
          })
        : null,
    ]);
    if (outcomes.some((o) => o.kind === "not-applicable")) return { observations: [], providerDown: false, notApplicable: true };
    const seedProgramAgrees =
      seedProg?.kind === "value" && seedStated !== null ? Math.abs(seedProg.value - seedStated) <= 1e-6 * Math.max(1, Math.abs(seedProg.value), Math.abs(seedStated)) : null;
    if (seedProg) programStats[seedProgramAgrees === null ? "abstain" : seedProgramAgrees ? "agree" : "disagree"]++;
    // With maxEscalations 0, a single disagreeing solve comes back as "no-consensus".
    const observations: SolverObservation[] = outcomes.map((o) =>
      o.kind === "answer"
        ? o.agreesWithGenerator
          ? { kind: "agree" }
          : { kind: "disagree", answer: o.answer }
        : o.kind === "ambiguous"
          ? { kind: "ambiguous", note: o.note }
          : o.kind === "error"
            ? { kind: "error", message: o.message }
            : { kind: "disagree", answer: "" }
    );
    solverErrorsInARow = observations.every((o) => o.kind === "error") ? solverErrorsInARow + 1 : 0;
    if (seedProgramAgrees === false) {
      console.warn(`[cascade] program solver computed ${(seedProg as { value: number }).value} for a seed variant, stated ${problem.answer}`);
      return { observations, providerDown: solverErrorsInARow >= 3, rejection: "guard-program" };
    }
    return { observations, providerDown: solverErrorsInARow >= 3 };
  };

  // Method-level dedup (method-dedup.ts): against this set's kept problems and the
  // methods recent sets recorded. CASCADE_METHOD_JUDGE=off disables it.
  const methodJudgeSpec = envOr("CASCADE_METHOD_JUDGE", DEFAULT_METHOD_JUDGE).trim();
  const methodJudge = methodJudgeSpec === "off" || !host ? null : parseRungSpec(plan.tier, methodJudgeSpec);
  const recentPriors: Prior[] = recentMemory.methods.map((m) => ({ ...m, source: "recent" }));
  const screen: RunInput["screen"] = methodJudge
    ? async (p, kept, _spec, signal) => {
        const priors: Prior[] = [...kept.map((k) => ({ problem: k.problem, method: k.method, source: "kept" as const })), ...recentPriors];
        const same = await sameMethodAs({
          problem: p,
          priors,
          call: host!,
          rung: methodJudge,
          signal,
          recordUsage: (u) => accountant.recordFor("verification", "openweight", methodJudge.model, u),
        });
        if (same) console.warn(`[cascade] duplicate (same method as ${same.source}, sim=${same.score.toFixed(2)}): ${p.problem.replace(/\s+/g, " ").slice(0, 140)}`);
        return same !== null;
      }
    : undefined;

  const maxUsd = Number(envOr("CASCADE_MAX_USD", "0"));
  const result = await runCascade({
    ladder,
    writers,
    specs,
    count,
    backups,
    maxCalls: numberEnv("CASCADE_MAX_CALLS", 40 + raceExtra),
    verified,
    verify,
    // CASCADE_BUDGET_SECONDS overrides the budget for evals only: the route's maxDuration
    // (300s) still bounds a real request.
    deadlineAt: startedAt + numberEnv("CASCADE_BUDGET_SECONDS", USABLE_BUDGET_MS / 1000) * 1000,
    signal: input.signal,
    semaphores: Object.fromEntries([...providers].map((p) => [p, semaphoreFor(p)])),
    breakerThreshold: numberEnv("CASCADE_BREAKER_THRESHOLD", 3),
    recordUsage: (provider, model, u) => accountant.recordFor("generation", provider, model, u),
    ...(maxUsd > 0 ? { budget: { spentUsd: () => costForRun(accountant.perModelUsage()).total, maxUsd } } : {}),
    buildRequest: cascadeRequestBuilder({
      plan,
      profile,
      topic,
      recentTopics,
      pool: specPool,
      calibration,
      count,
      scratchPrompt,
      seededScratch: mode === "scratch",
      targetFor,
      seen: recentProblems,
      writerProgram: (rung) => program !== undefined && plan.answerFormat !== "open" && writesOwnProgram(rung),
    }),
    check: cascadeCheck(plan, program, specPool),
    screen,
    // Near-duplicates of this set's kept problems, or of anything the student worked in
    // recent sessions (an eval gave two sessions the same problem word for word).
    // Against the student's recent sessions: a math-aware near-copy check, since the
    // prose/number check misfires on terse statements (see nearCopyOf). Within the set,
    // too, when slots are typed: each slot already has its own type, so the prose check
    // only added false matches (three shared small numbers, "all real numbers $x$ that
    // satisfy") and a set ran out of candidates. Untyped sets keep the prose check.
    isDuplicate: (p, kept) => {
      const keptStatements = kept.map((k) => k.problem);
      const inSet = types
        ? ((c) => (c ? `kept near-copy=${c.score.toFixed(2)}` : null))(nearCopyOf(p.problem, keptStatements))
        : tooSimilarToSeed(p, keptStatements.map((statement) => ({ source: "kept", number: null, statement })), { numeric });
      const copy = inSet ? null : nearCopyOf(p.problem, recentProblems);
      const why = inSet ?? (copy ? `recent#${copy.index} near-copy=${copy.score.toFixed(2)}` : null);
      if (why) console.warn(`[cascade] duplicate (${why}): ${p.problem.replace(/\s+/g, " ").slice(0, 140)}`);
      return why !== null;
    },
  });

  const drops: GenerationRunMeta["drops"] = [];
  for (const [rejection, n] of Object.entries(result.meta.rejections) as [CandidateRejection, number][]) {
    for (let i = 0; i < n; i++) drops.push({ reason: REJECTION_DROP[rejection], excerpt: `cascade: ${rejection}` });
  }
  for (const [finish, n] of Object.entries(result.meta.finishes)) {
    if (finish === "ok" || finish === "aborted") continue;
    const reason: DropReason = finish === "timeout" ? "rung-timeout" : finish === "filtered" ? "content-filtered" : "generation-failed";
    for (let i = 0; i < (n ?? 0); i++) drops.push({ reason, excerpt: `cascade: ${finish}` });
  }
  if (result.failure) drops.push({ reason: result.failure.dropReason, excerpt: result.failure.reason });

  const meta = baseMeta({
    usage: accountant.perModelUsage(),
    drops,
    verdicts: result.verdicts,
    kept: result.problems.length,
    cascade: {
      ...result.meta,
      seedsAvailable: mode === "variant" ? seedsUsed : undefined,
      ...(targets ? { targets } : {}),
      ...(types ? { types: specs.slice(0, count).map((s) => s.hint) } : {}),
      ...(typeIds || seededObjectives.size ? { typeIds: [...new Set([...(typeIds ?? []), ...[...seededObjectives.values()].map((p) => p.typeId)])] } : {}),
      ...(seededObjectives.size ? { seeded: seededObjectives.size } : {}),
      ...(judgeCall ? { judgeScale: judgeCalibrated ? ("calibrated" as const) : ("human" as const) } : {}),
      ...(recentProblems.length ? { recentProblems: recentProblems.length } : {}),
      ...(program ? { answerChecks: program } : {}),
      ...(programCall ? { programSolves: programStats } : {}),
    },
  });
  console.log(accountant.summaryLine({ tier: plan.tier, count: result.problems.length }));

  if (!result.ok) {
    const error =
      result.failure?.dropReason === "provider-unavailable"
        ? CASCADE_ERRORS.providerDown
        : result.failure?.reason === "not enough time left for another attempt"
          ? CASCADE_ERRORS.outOfTime
          : CASCADE_ERRORS.exhausted;
    console.error(`[cascade] set failed: ${result.failure?.reason} (objective ${result.failure?.objective ?? "-"})`);
    return { ok: false, error, meta };
  }

  // Strip the difficulty self-tag, as the legacy path does: a calibration aid only.
  // answerCheck/method are pipeline-internal too, so they never reach the stored set.
  const problems = result.problems.map(({ problem, answer, solution }) => ({ problem, answer, solution }));
  return { ok: true, problems, plan, count, meta };
}
