import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Anchor } from "@/lib/types";
import type { GenerationPlan } from "@/lib/generation/plan";

// No database and no model calls: retrieval and the solver are mocked, writers are
// injected fakes.
const getAnchors = vi.fn<(...args: unknown[]) => Promise<Anchor[]>>();
const getReferencesAt = vi.fn<(...args: unknown[]) => Promise<Map<number, Anchor[]>>>();
const getAnchorsByIds = vi.fn<(ids: string[]) => Promise<Anchor[]>>();
vi.mock("@/lib/corpus-retrieval", () => ({
  getAnchors: (...a: unknown[]) => getAnchors(...a),
  getReferencesAt: (...a: unknown[]) => getReferencesAt(...a),
  getStatements: async () => new Map(),
  getAnchorsByIds: (ids: string[]) => getAnchorsByIds(ids),
}));
const solveProblem = vi.fn();
vi.mock("@/lib/generation/solve", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/generation/solve")>()),
  solveProblem: (...a: unknown[]) => solveProblem(...a),
}));

import { cascadeCheck, cascadeRequestBuilder, firstWaveFromEnv, generateProblemsCascade, writesOwnProgram, CASCADE_ERRORS } from "./generate";
import { parseLadder } from "./ladder";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import type { Writer } from "./writers";
import type { CallOpenWeight } from "./verify-cheap";
import { catalogFor } from "./taxonomy-slots";
import { corpusDifficulty, targetRating } from "@/lib/generation/corpus-difficulty";
import { judgeScaleTarget } from "@/lib/generation/judge-calibration";

const plan = (over: Partial<GenerationPlan> = {}): GenerationPlan => ({
  domain: "Competition math (AMC10)",
  contentType: "math",
  tier: "mid",
  answerFormat: "numeric",
  rubric: "r",
  competition: "AMC10",
  bandLow: 16,
  bandHigh: 25,
  category: null,
  source: "corpus",
  ...over,
});

const anchor = (i: number): Anchor => ({ source: "AIME", number: 12, statement: `seed statement number ${i} about widgets`, answer: `${i}`, solution: "sol" });

// A writer that returns a distinct, guard-passing problem per call. The statements
// share no content words and no numbers, so the real near-duplicate check passes.
const DISTINCT = [
  "How many subsets of eleven marbles contain exactly four red ones?",
  "A triangle has sides 13, 14 and 15; what is its area?",
  "Find the remainder when 7 raised to 2026 is divided by 9.",
  "Solve for the positive root of x squared minus 6x plus 5.",
  "What is the sum of interior angles of a convex octagon?",
  "Compute the greatest common divisor of 252 and 198.",
  "A fair die rolls twice; find the probability both faces are even.",
  "Evaluate the infinite geometric series one plus half plus quarter.",
  "How many diagonals does a regular dodecagon possess?",
  "Determine the least common multiple of 18 and 24.",
  "What digit ends the product of all primes below thirty?",
  "Count lattice points strictly inside a circle radius three.",
  "Find the median of the list 3, 8, 1, 9, 4.",
  "Arrange letters of BANANA; how many distinct words result?",
  "Pipes fill a tank in 3 and 6 hours; together, how long?",
];
function distinctWriter(): { writer: Writer; users: string[] } {
  const users: string[] = [];
  let n = 0;
  const writer: Writer = async (req) => {
    users.push(req.user);
    const i = n++;
    return { problem: DISTINCT[i % DISTINCT.length], answer: `${i + 2}`, solution: `Working gives ${i + 2}.` };
  };
  return { writer, users };
}

beforeEach(() => {
  vi.stubEnv("GENERATION_LADDER_MID", "");
  vi.stubEnv("GENERATION_LADDER_HARD", "");
  vi.stubEnv("CASCADE_VERIFY_SCRATCH", "off"); // the cheap-verification tests below turn it on
  getAnchors.mockReset();
  getReferencesAt.mockReset();
  getReferencesAt.mockResolvedValue(new Map());
  getAnchorsByIds.mockReset();
  getAnchorsByIds.mockResolvedValue([]);
  solveProblem.mockReset();
});
afterEach(() => vi.unstubAllEnvs());

describe("generateProblemsCascade", () => {
  it("writes a full mid-tier set, one problem per call, each told its slot", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const { writer, users } = distinctWriter();
    const r = await generateProblemsCascade({
      profile: "AMC10 #16-25",
      topic: "counting",
      recentTopics: [],
      accountant: new UsageAccountant(),
      plan: plan(),
      writers: { anthropic: writer },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.problems).toHaveLength(10);
    expect(r.meta.pipeline).toBe("cascade");
    expect(r.meta.cascade?.ladder).toEqual([{ provider: "anthropic", model: "claude-opus-5-5" }]);
    const timings = r.meta.cascade!.timings!;
    expect(timings.length).toBeGreaterThanOrEqual(10); // every finished candidate reports where its time went
    expect(timings.every((t) => t.queueMs >= 0 && (t.writeMs ?? 0) >= 0)).toBe(true);
    expect(timings.filter((t) => t.outcome === "passed")).toHaveLength(10);
    expect(users[0]).toMatch(/problem 1 of a 10-problem set/);
    expect(users[0]).toMatch(/Write the problem and call emit_problems/); // construct is the default
    expect(r.meta.cascade?.targets).toEqual([16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
    expect(solveProblem).not.toHaveBeenCalled(); // scratch tiers aren't solved
  });

  it("keeps the classic prompt when CASCADE_SCRATCH_PROMPT=classic, and rejects an unknown value", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    vi.stubEnv("CASCADE_SCRATCH_PROMPT", "classic");
    const { writer, users } = distinctWriter();
    const input = { profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), writers: { anthropic: writer } };
    const r = await generateProblemsCascade({ ...input, accountant: new UsageAccountant() });
    expect(r.ok).toBe(true);
    expect(users[0]).toMatch(/Generate exactly 1 fully-solved problem/);
    vi.stubEnv("CASCADE_SCRATCH_PROMPT", "fancy");
    const bad = await generateProblemsCascade({ ...input, accountant: new UsageAccountant() });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toBe(CASCADE_ERRORS.misconfigured);
  });

  it("gives each hard variant its own in-band seed, verifies it, and never widens the band", async () => {
    getAnchors.mockResolvedValue(Array.from({ length: 15 }, (_, i) => anchor(i)));
    solveProblem.mockResolvedValue({ kind: "answer", answer: "x", agreesWithGenerator: true, crossFamily: true, attempts: 1 });
    const { writer, users } = distinctWriter();
    const r = await generateProblemsCascade({
      profile: "AIME 10-15",
      topic: "",
      recentTopics: [],
      accountant: new UsageAccountant(),
      plan: plan({ tier: "hard", competition: "AIME", bandLow: 10, bandHigh: 15, answerFormat: "integer" }),
      writers: { anthropic: writer },
    });
    expect(getAnchors).toHaveBeenCalledWith(expect.objectContaining({ strictBand: true }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.verdicts.every((v) => v === "verified")).toBe(true);
    // Each call carries exactly one seed, and no two calls share one.
    const seedsShown = users.map((u) => u.match(/seed statement number (\d+)/g) ?? []);
    expect(seedsShown.every((s) => s.length === 1)).toBe(true);
    expect(new Set(seedsShown.map((s) => s[0])).size).toBe(users.length);
  });

  it("mixes in HMMT problems rated inside the AIME band, only those with an AIME-style answer", async () => {
    getAnchors.mockResolvedValue(Array.from({ length: 6 }, (_, i) => anchor(i)));
    // HMMT rows the rating window asks for: half have integer answers, half don't.
    getAnchorsByIds.mockImplementation(async (ids) =>
      ids.map((id, i) => ({ id, source: corpusDifficulty(id)!.source, number: corpusDifficulty(id)!.number, statement: `hmmt problem ${id} ${i % 2 ? "fraction" : "integer"}`, answer: i % 2 ? "\\frac{1}{2}" : "42", solution: "s" }))
    );
    solveProblem.mockResolvedValue({ kind: "answer", answer: "x", agreesWithGenerator: true, crossFamily: true, attempts: 1 });
    const { writer, users } = distinctWriter();
    const r = await generateProblemsCascade({
      profile: "AIME 10-15", topic: "", recentTopics: [], accountant: new UsageAccountant(), rotationKey: "s1",
      plan: plan({ tier: "hard", competition: "AIME", bandLow: 10, bandHigh: 15, answerFormat: "integer" }),
      writers: { anthropic: writer },
    });
    expect(r.ok).toBe(true);
    const asked = getAnchorsByIds.mock.calls[0][0];
    expect(asked.length).toBeGreaterThan(0);
    const lo = targetRating("AIME", 10)!;
    for (const id of asked) {
      expect(corpusDifficulty(id)!.source).toMatch(/^HMMT-/);
      expect(corpusDifficulty(id)!.rating).toBeGreaterThanOrEqual(lo);
    }
    expect(users.some((u) => /hmmt problem \S+ integer/.test(u))).toBe(true);
    expect(users.some((u) => /hmmt problem \S+ fraction/.test(u))).toBe(false);
  });

  it("CASCADE_SEED_BORROW=off keeps AIME seeds to AIME", async () => {
    vi.stubEnv("CASCADE_SEED_BORROW", "off");
    getAnchors.mockResolvedValue(Array.from({ length: 15 }, (_, i) => anchor(i)));
    solveProblem.mockResolvedValue({ kind: "answer", answer: "x", agreesWithGenerator: true, crossFamily: true, attempts: 1 });
    const r = await generateProblemsCascade({
      profile: "AIME 10-15", topic: "", recentTopics: [], accountant: new UsageAccountant(),
      plan: plan({ tier: "hard", competition: "AIME", bandLow: 10, bandHigh: 15, answerFormat: "integer" }),
      writers: { anthropic: distinctWriter().writer },
    });
    expect(r.ok).toBe(true);
    expect(getAnchorsByIds).not.toHaveBeenCalled();
  });

  it("fills the rest with scratch problems when the band has too few seeds", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    solveProblem.mockResolvedValue({ kind: "answer", answer: "x", agreesWithGenerator: true, crossFamily: true, attempts: 1 });
    const { writer } = distinctWriter();
    const r = await generateProblemsCascade({
      profile: "AIME",
      topic: "",
      recentTopics: [],
      accountant: new UsageAccountant(),
      plan: plan({ tier: "hard", competition: "AIME", bandLow: 10, bandHigh: 15, answerFormat: "integer" }),
      writers: { anthropic: writer },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.cascade?.seedsAvailable).toBe(2);
    expect(r.meta.verdicts.filter((v) => v === "not-applicable").length).toBe(r.problems.length - 2);
  });

  it("fails with the misconfiguration copy when a ladder provider has no credentials", async () => {
    vi.stubEnv("GENERATION_LADDER_MID", "openweight:deepseek-flash,anthropic:claude-opus-5-5");
    vi.stubEnv("OPENWEIGHT_BASE_URL", "");
    getAnchors.mockResolvedValue([]);
    const { writer } = distinctWriter();
    const r = await generateProblemsCascade({
      profile: "x",
      topic: "",
      recentTopics: [],
      accountant: new UsageAccountant(),
      plan: plan(),
      writers: undefined,
    });
    expect(r).toMatchObject({ ok: false, error: CASCADE_ERRORS.misconfigured });
    void writer;
  });

  it("fails with the provider-down copy when every call errors at the provider", async () => {
    getAnchors.mockResolvedValue([]);
    const { RungError } = await import("./writers");
    const writer: Writer = async () => {
      throw new RungError("api-error", "HTTP 503", true);
    };
    const r = await generateProblemsCascade({
      profile: "x",
      topic: "",
      recentTopics: [],
      accountant: new UsageAccountant(),
      plan: plan({ competition: null, source: "model", slots: ["a", "b"] }),
      writers: { anthropic: writer },
    });
    expect(r).toMatchObject({ ok: false, error: CASCADE_ERRORS.providerDown });
    if (r.ok) return;
    expect(r.meta.drops.some((d) => d.reason === "provider-unavailable")).toBe(true);
  });

  it("records per-model usage in genMeta", async () => {
    getAnchors.mockResolvedValue([]);
    const accountant = new UsageAccountant();
    const writer: Writer = async (req) => {
      req.recordUsage({ input_tokens: 100, output_tokens: 10 } as never);
      return { problem: `Unique problem ${req.user.length}-${Math.random()} value`, answer: "3", solution: "It is 3." };
    };
    const r = await generateProblemsCascade({
      profile: "x",
      topic: "",
      recentTopics: [],
      accountant,
      plan: plan({ competition: null, source: "model", contentType: "prose", answerFormat: "short-text" }),
      writers: { anthropic: writer },
    });
    expect(r.meta.usage["generation:anthropic:claude-opus-5-5"]).toMatchObject({ provider: "anthropic", model: "claude-opus-5-5" });
  });
});

describe("cascadeCheck", () => {
  const check = cascadeCheck(plan({ answerFormat: "numeric" }));
  const spec = { hint: "x" };
  it("rejects an answer field that contradicts the solution, and a solution that calls the problem broken", () => {
    expect(check({ problem: "Find $b+c$.", answer: "13", solution: "We get $c=20$.\nSo $b+c=\\tfrac{21}{2}$." }, spec)).toBe("guard-consistency");
    expect(check({ problem: "Find $b+c$.", answer: "3/2", solution: "The problem as written has no answer and needs to be rewritten." }, spec)).toBe("guard-consistency");
  });
  it("keeps a consistent problem", () => {
    expect(check({ problem: "Find $b+c$.", answer: "21/2", solution: "We get $c=20$.\nSo $b+c=\\tfrac{21}{2}$." }, spec)).toBeNull();
  });
  it("rejects a key its own answer-check program contradicts, and counts every outcome", () => {
    const stats = { match: 0, mismatch: 0, abstain: 0 };
    const guarded = cascadeCheck(plan({ answerFormat: "numeric" }), stats);
    const base = { problem: "How many multiples of 3 or 5 are at most 20?", solution: "Count them.\nThe answer is 9." };
    const program = "f(n) = mod(n,3)==0 or mod(n,5)==0; size(filter(1:20, f))";
    expect(guarded({ ...base, answer: "9", answerCheck: program }, spec)).toBeNull();
    expect(guarded({ ...base, answer: "9", answerCheck: "size(filter(1:20, f(n) = mod(n,3)==0))" }, spec)).toBe("guard-program");
    expect(guarded({ ...base, answer: "9", answerCheck: "none" }, spec)).toBeNull();
    expect(guarded({ ...base, answer: "9" }, spec)).toBeNull();
    expect(stats).toEqual({ match: 1, mismatch: 1, abstain: 2 });
  });
  it("does not run programs when disabled or for open-format plans", () => {
    const stats = { match: 0, mismatch: 0, abstain: 0 };
    const p = { problem: "Q", answer: "5", solution: "The answer is 5.", answerCheck: "2 + 2" };
    expect(cascadeCheck(plan({ answerFormat: "numeric" }))(p, spec)).toBeNull();
    expect(cascadeCheck(plan({ answerFormat: "open" }), stats)(p, spec)).toBeNull();
    expect(stats).toEqual({ match: 0, mismatch: 0, abstain: 0 });
  });
});

describe("per-slot targets", () => {
  it("shows each objective a real problem at its target position, varying with the rotation key", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    getReferencesAt.mockImplementation(async (...a: unknown[]) => {
      const { numbers } = a[0] as { numbers: number[] };
      return new Map(numbers.map((n) => [n, ["p", "q", "r"].map((id) => ({ source: "AMC10", number: n, statement: `real #${n} ${id}`, answer: "1", solution: null }))]));
    });
    const run = async (rotationKey: string) => {
      const { writer, users } = distinctWriter();
      const r = await generateProblemsCascade({
        profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), writers: { anthropic: writer },
        accountant: new UsageAccountant(), rotationKey,
      });
      expect(r.ok).toBe(true);
      return users;
    };
    const a = await run("session-a:1");
    const slot0 = a.find((u) => /problem 1 of a 10-problem set/.test(u))!;
    expect(slot0).toMatch(/real #16 [pqr]/);
    expect(slot0).toMatch(/ONLY so you can feel the difficulty/);
    const refsSeen = new Set<string>();
    for (const key of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
      const u = (await run(key)).find((x) => /problem 10 of a 10-problem set/.test(x))!;
      refsSeen.add(/real #25 ([pqr])/.exec(u)![1]);
    }
    expect(refsSeen.size).toBeGreaterThan(1);
  });
});

describe("seeded slots", () => {
  const host = (fit: "all" | "fail"): CallOpenWeight => async (_r, _p, tool) =>
    tool.name === "emit_selection" && fit === "all" ? { ok: true, args: { types: catalogFor("AMC10").map((_, i) => i) } } : { ok: false, message: "unused" };
  // The corpus answers for whichever rated ids the rating window asks for (at most `limit`).
  const rated = (limit = Infinity) =>
    getAnchorsByIds.mockImplementation(async (ids) =>
      ids.slice(0, limit).map((id) => ({ id, source: corpusDifficulty(id)!.source, number: corpusDifficulty(id)!.number, statement: `rated ${id}`, answer: "7", solution: "real solution" }))
    );
  const run = (over: Partial<Parameters<typeof generateProblemsCascade>[0]> = {}) => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const { writer, users } = distinctWriter();
    return {
      users,
      result: generateProblemsCascade({
        profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), accountant: new UsageAccountant(),
        writers: { anthropic: writer }, cheapCall: host("all"), rotationKey: "s1", ...over,
      }),
    };
  };

  it("builds every objective as a variant of a real problem rated like the band, fitting the topic, and records which", async () => {
    rated();
    const { users, result } = run();
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.cascade?.seeded).toBe(10);
    const slot1 = users.find((u) => /problem 1 of a 10-problem set/.test(u))!;
    expect(slot1).toMatch(/Build your problem as a variant of this real AMC10 #\d+/);
    expect(slot1).toMatch(/Its solution \(for the idea only/);
    expect(slot1).not.toMatch(/ONLY so you can feel the difficulty/);
    const seedIds = r.meta.cascade!.items.map((it) => it.seedId!);
    expect(new Set(seedIds).size).toBe(10);
    // Chosen by human rating, never below the band's easiest target.
    const lo = targetRating("AMC10", 16)!;
    for (const id of getAnchorsByIds.mock.calls[0][0]) {
      expect(corpusDifficulty(id)!.source).toBe("AMC10");
      expect(corpusDifficulty(id)!.rating).toBeGreaterThanOrEqual(lo);
    }
    expect(solveProblem).not.toHaveBeenCalled(); // seeded variants get the cheap checks, never Opus
  });

  it("never reuses a real problem a recent set was built on", async () => {
    rated();
    const used = (await run().result).meta.cascade!.items.map((it) => it.seedId!);
    expect(used.length).toBe(10);
    const r = await run({ recentMemory: { typeIds: [], methods: [], seedIds: used } }).result;
    expect(r.ok).toBe(true);
    expect(r.meta.cascade!.items.filter((it) => it.seedId).length).toBeGreaterThan(0);
    expect(r.meta.cascade!.items.some((it) => it.seedId && used.includes(it.seedId))).toBe(false);
  });

  it("CASCADE_SEED_ONLY=on builds every candidate from a real problem, spares included", async () => {
    rated();
    vi.stubEnv("CASCADE_SEED_ONLY", "on");
    const { users, result } = run();
    const r = await result;
    expect(r.ok).toBe(true);
    expect(r.meta.cascade!.items.every((it) => it.seedId)).toBe(true);
    expect(users.every((u) => /Build your problem as a variant of this real/.test(u))).toBe(true);
  });

  it("CASCADE_FIRST_WAVE races several candidates per objective and keeps one each", async () => {
    rated();
    vi.stubEnv("CASCADE_FIRST_WAVE", "2");
    const { users, result } = run();
    const r = await result;
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.problems).toHaveLength(10);
    expect(r.meta.cascade!.candidatesLaunched).toBeGreaterThanOrEqual(20); // 2 per objective from the start
    // Siblings still queued for a writer when their objective fills are cancelled unwritten.
    expect(users.length).toBeLessThan(r.meta.cascade!.candidatesLaunched);
    expect(r.meta.cascade!.candidatesAborted).toBeGreaterThan(0);
  });

  it("writes the rest from scratch when too few real problems fit, and stays all-scratch without a topic fit", async () => {
    rated(1);
    const mixed = await run().result;
    expect(mixed.ok).toBe(true);
    expect(mixed.meta.cascade?.seeded).toBe(1);
    rated();
    const noFit = await run({ cheapCall: host("fail") }).result;
    expect(noFit.meta.cascade?.seeded).toBeUndefined();
    vi.stubEnv("CASCADE_SEED_SLOTS", "off");
    const off = await run().result;
    expect(off.meta.cascade?.seeded).toBeUndefined();
  });
});

describe("cheap verification of scratch candidates", () => {
  // The fake writer answers `${i + 2}` for its i-th call; this host's solvers answer
  // with whatever `solverAnswer` says for that statement.
  const host = (solverAnswer: (problem: string) => string | "ambiguous", valid = true): CallOpenWeight => async (_rung, prompt, tool) => {
    if (tool.name === "emit_validity") return { ok: true, args: { wellPosed: valid, reason: valid ? "ok" : "no solution exists" } };
    const problem = prompt.user.split("\n").slice(1).join("\n").trim(); // both prompts: a label line, then the statement
    const a = solverAnswer(problem);
    return { ok: true, args: a === "ambiguous" ? { answer: "", ambiguous: true } : { answer: a, ambiguous: false } };
  };
  const input = () => ({ profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), accountant: new UsageAccountant() });

  beforeEach(() => {
    vi.stubEnv("CASCADE_VERIFY_SCRATCH", "on");
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
  });

  it("keeps problems both blind solvers agree on, marked verified", async () => {
    const answers = new Map<string, string>();
    const writer: Writer = async () => {
      const i = answers.size;
      const p = { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: `${i + 2}`, solution: `Working gives ${i + 2}.` };
      answers.set(p.problem, p.answer);
      return p;
    };
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: writer }, cheapCall: host((p) => answers.get(p) ?? "?") });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.verdicts.every((v) => v === "verified")).toBe(true);
  });

  it("replaces a candidate whose answer a solver contradicts, or that the validity check calls broken", async () => {
    let n = 0;
    const writer: Writer = async () => {
      const i = n++;
      return { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: "7", solution: "Working gives 7." };
    };
    const disagree = await generateProblemsCascade({ ...input(), writers: { anthropic: writer }, cheapCall: host(() => "8") });
    expect(disagree.ok).toBe(false);
    expect(disagree.meta.cascade?.rejections["solver-disagree"]).toBeGreaterThan(0);
    const broken = await generateProblemsCascade({ ...input(), writers: { anthropic: writer }, cheapCall: host(() => "7", false) });
    expect(broken.ok).toBe(false);
    expect(broken.meta.cascade?.rejections.invalid).toBeGreaterThan(0);
    expect(broken.meta.drops.some((d) => d.reason === "ill-posed")).toBe(true);
  });

  it("refuses to run without a host or with a writer no solver is outside of", async () => {
    vi.stubEnv("OPENWEIGHT_BASE_URL", "");
    const noHost = await generateProblemsCascade({ ...input(), writers: { anthropic: distinctWriter().writer } });
    expect(noHost.ok).toBe(false);
    if (!noHost.ok) expect(noHost.error).toBe(CASCADE_ERRORS.misconfigured);
    vi.stubEnv("CASCADE_SOLVERS", "openweight:zai-org/GLM-5.3,openweight:zai-org/GLM-5.3-Flash");
    vi.stubEnv("GENERATION_LADDER_MID", "openweight:zai-org/GLM-5.3,anthropic:claude-opus-5-5");
    const sameFamily = await generateProblemsCascade({ ...input(), writers: { anthropic: distinctWriter().writer, openweight: distinctWriter().writer }, cheapCall: host(() => "2") });
    expect(sameFamily.ok).toBe(false);
    expect(sameFamily.meta.drops[0]?.excerpt).toMatch(/no solver from a different model family/);
  });
});

describe("difficulty filter in the cascade", () => {
  it("replaces a confirmed-correct candidate that plays too easy for its slot, and records the pass rate", async () => {
    vi.stubEnv("CASCADE_VERIFY_SCRATCH", "on");
    vi.stubEnv("CASCADE_DIFFICULTY_SOLVER", "openweight:zai-org/GLM-5.3-Flash");
    // Late slots (#21-25) must stump the weak solver at least once in three.
    vi.stubEnv("CASCADE_DIFFICULTY_WINDOWS", JSON.stringify([{ from: 21, to: 25, minRate: 0, maxRate: 0.67 }]));
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const answers = new Map<string, string>();
    const writer: Writer = async () => {
      const i = answers.size;
      const p = { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: `${i + 2}`, solution: `Working gives ${i + 2}.` };
      answers.set(p.problem, p.answer);
      return p;
    };
    // Every solver, the weak one included, always finds the right answer.
    const host: CallOpenWeight = async (_r, prompt, tool) =>
      tool.name === "emit_validity"
        ? { ok: true, args: { wellPosed: true, reason: "ok" } }
        : { ok: true, args: { answer: answers.get(prompt.user.split("\n").slice(1).join("\n").trim()) ?? "?", ambiguous: false } };
    const r = await generateProblemsCascade({
      profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), accountant: new UsageAccountant(),
      writers: { anthropic: writer }, cheapCall: host,
    });
    // Objectives aimed at #21-25 can never pass, so the set can't complete.
    expect(r.ok).toBe(false);
    expect(r.meta.cascade?.rejections["too-easy"]).toBeGreaterThan(0);
    expect(r.meta.drops.some((d) => d.reason === "difficulty-off-target")).toBe(true);
    const early = r.meta.cascade?.items.find((i) => i.objective === 0);
    expect(early?.difficulty).toEqual({ target: 16, solved: 3, answered: 3 });
  });
});

describe("repetition guards", () => {
  const typesHost = (types: string[] | "fail"): CallOpenWeight => async (_r, _p, tool) =>
    tool.name === "emit_types" ? (types === "fail" ? { ok: false, message: "timeout" } : { ok: true, args: { types } }) : { ok: false, message: "unused" };
  const TYPES = ["Vieta root transform", "work-rate", "integer-root casework", "revenue maximization", "shared root", "absolute value equations"];
  const run = (over: Partial<Parameters<typeof generateProblemsCascade>[0]>) => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const { writer, users } = distinctWriter();
    return {
      users,
      result: generateProblemsCascade({
        profile: "AMC10 #16-25", topic: "quadratics", recentTopics: [], plan: plan(), accountant: new UsageAccountant(),
        writers: { anthropic: writer }, ...over,
      }),
    };
  };

  it("gives each slot a distinct problem type from one listing call, and records them", async () => {
    const { users, result } = run({ cheapCall: typesHost(TYPES), rotationKey: "s1" });
    const r = await result;
    expect(r.ok).toBe(true);
    const types = r.meta.cascade?.types ?? [];
    expect(types).toHaveLength(10);
    expect(new Set(types.slice(0, TYPES.length)).size).toBe(TYPES.length); // the first six slots are all different
    const slot1 = users.find((u) => /problem 1 of a 10-problem set/.test(u))!;
    expect(TYPES.some((t) => slot1.includes(t))).toBe(true);
  });

  it("rotates the types across sessions", async () => {
    const firsts = new Set<string>();
    for (const key of ["a", "b", "c", "d", "e", "f"]) firsts.add((await run({ cheapCall: typesHost(TYPES), rotationKey: key }).result).meta.cascade!.types![0]);
    expect(firsts.size).toBeGreaterThan(1);
  });

  it("falls back to the old hints when the listing call fails", async () => {
    const r = await run({ cheapCall: typesHost("fail") }).result;
    expect(r.ok).toBe(true);
    expect(r.meta.cascade?.types).toBeUndefined();
  });

  it("shows the writer the student's recent problems and rejects a repeat of one", async () => {
    const recent = [DISTINCT[0]];
    const { users, result } = run({ recentProblems: recent });
    const r = await result;
    expect(users[0]).toContain("already worked in recent sessions");
    expect(users[0]).toContain(DISTINCT[0].slice(0, 40));
    // The fake writer's first statement IS the recent problem: it must not be kept.
    expect(r.meta.cascade?.rejections.duplicate).toBeGreaterThan(0);
    if (r.ok) expect(r.problems.map((p) => p.problem)).not.toContain(DISTINCT[0]);
    expect(r.meta.cascade?.recentProblems).toBe(1);
  });
});

describe("within-set dedup on typed sets", () => {
  // Structurally different equations in the same terse contest prose (the kind of
  // pair that failed a real set): the prose check reads them as one problem, the
  // math-aware check doesn't. (The same equation with new numbers IS a repeat, and the
  // math-aware check still catches that.)
  const EQUATIONS = [
    "|x^2-6x+5| = x-1",
    "x^4-5x^3+8x^2-5x+1=0",
    "\\frac{x}{x-2}+\\frac{3}{x+1}=\\frac{6}{x^2-x-2}",
    "\\sqrt{x+7} = x-5",
    "(x^2-2x)^2-2(x^2-2x)=24",
    "2^{2x}-5\\cdot 2^{x}+4=0",
    "x^3-7x+6=0",
    "\\frac{1}{x}+\\frac{1}{x+4}=\\frac{1}{3}",
    "|2x-3|+|x+1|=9",
    "x+\\frac{4}{x}=5",
    "(x-1)(x-2)(x-3)(x-4)=24",
    "x^2+\\sqrt{x^2+9}=21",
  ];
  const terseWriter = (): Writer => {
    let n = 0;
    return async () => {
      const i = n++;
      return { problem: `Find the sum of all real numbers $x$ that satisfy $${EQUATIONS[i % EQUATIONS.length]}.$`, answer: `${i + 3}`, solution: `Working gives ${i + 3}.` };
    };
  };
  const typesHost: CallOpenWeight = async (_r, _p, tool) =>
    tool.name === "emit_types" ? { ok: true, args: { types: ["t1", "t2", "t3", "t4", "t5", "t6", "t7", "t8", "t9", "t10", "t11", "t12"] } } : { ok: false, message: "unused" };
  const base = () => ({ profile: "AMC10 #16-25", topic: "quadratics", recentTopics: [], plan: plan(), accountant: new UsageAccountant() });

  it("keeps different equations that share their prose when slots are typed", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const r = await generateProblemsCascade({ ...base(), writers: { anthropic: terseWriter() }, cheapCall: typesHost });
    expect(r.ok).toBe(true);
    expect(r.meta.cascade?.rejections.duplicate ?? 0).toBe(0);
  });

  it("still uses the prose check on untyped sets", async () => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
    const r = await generateProblemsCascade({ ...base(), writers: { anthropic: terseWriter() } });
    expect(r.meta.cascade?.rejections.duplicate ?? 0).toBeGreaterThan(0);
  });
});

describe("program checks on scratch candidates", () => {
  // Only the program path runs here: the text solvers are off.
  const input = () => ({ profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), accountant: new UsageAccountant() });
  const numbered: Writer = (() => {
    let n = 0;
    return async () => {
      const i = n++;
      return { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: `${i + 2}`, solution: `Working gives ${i + 2}.` };
    };
  })();
  // A program solver that writes "<answer> + <delta>", where answer is read from the
  // statement's "(#i)" tag the way numbered() assigns it.
  const programs = (delta: number) => {
    const calls: string[] = [];
    const call: CallOpenWeight = async (_rung, prompt, tool) => {
      calls.push(tool.name);
      const i = Number(/\(#(\d+)\)/.exec(prompt.user)?.[1]);
      return { ok: true, args: { program: `${i + 2} + ${delta}` } };
    };
    return { call, calls };
  };

  beforeEach(() => {
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
  });

  it("verifies a candidate whose blind program computes the stated answer", async () => {
    const p = programs(0);
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered }, programCall: p.call });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.meta.verdicts.every((v) => v === "verified")).toBe(true);
    expect(r.meta.cascade?.programSolves?.agree).toBeGreaterThanOrEqual(10); // backups count too
    expect(r.meta.cascade?.programSolves?.disagree).toBe(0);
    expect(p.calls.every((c) => c === "emit_program")).toBe(true);
  });

  it("vetoes a candidate whose blind program computes a different answer", async () => {
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered }, programCall: programs(1).call });
    expect(r.ok).toBe(false);
    expect(r.meta.cascade?.rejections["guard-program"]).toBeGreaterThan(0);
  });

  it("skips the blind program when the writer's own program already matched", async () => {
    const p = programs(0);
    let n = 0;
    const writer: Writer = async () => {
      const i = n++;
      return { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: `${i + 2}`, solution: `Working gives ${i + 2}.`, answerCheck: `${i} + 2` };
    };
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: writer }, programCall: p.call });
    expect(r.ok).toBe(true);
    expect(p.calls).toHaveLength(0);
    expect(r.ok && r.meta.cascade!.answerChecks!.match).toBeGreaterThanOrEqual(10);
  });

  it("asks only thinking Anthropic writers to write their own program", () => {
    const build = cascadeRequestBuilder({ plan: plan(), profile: "p", topic: "t", recentTopics: [], pool: [], calibration: [], count: 10, scratchPrompt: "construct", writerProgram: writesOwnProgram });
    const [opus] = parseLadder("easy", "anthropic:claude-opus-5-5");
    const [gemini] = parseLadder("easy", "gemini:gemini-3.8-flash@low");
    const spec = { hint: "x" };
    expect(build({ objective: 0, spec, kept: [], rung: opus }).system).toMatch(/"answerCheck" is a short program/);
    expect(build({ objective: 0, spec, kept: [], rung: gemini }).system).not.toMatch(/"answerCheck" is a short program/);
    expect(build({ objective: 0, spec, kept: [], rung: gemini }).system).toMatch(/"method"/);
  });

  it("CASCADE_ANSWER_CHECK=off turns off both program paths", async () => {
    vi.stubEnv("CASCADE_ANSWER_CHECK", "off");
    const p = programs(1);
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered }, programCall: p.call });
    expect(r.ok).toBe(true);
    expect(p.calls).toHaveLength(0);
  });
});

describe("difficulty judge on scratch candidates", () => {
  const input = () => ({ profile: "AMC10 #16-25", topic: "counting", recentTopics: [], plan: plan(), accountant: new UsageAccountant() });
  const anchors = [0.2, 0.25, 0.3, 0.35].map((rating, i) => ({ statement: `anchor ${i}`, rating }));
  // Always "harder than 1 of 4" → score 0.25 → rating 0.2375 by interpolation.
  const judge: CallOpenWeight = async (_r, _p, tool) => (tool.name === "emit_placement" ? { ok: true, args: { harderThan: 1 } } : { ok: false, message: "n/a" });
  const programs: CallOpenWeight = async (_r, prompt) => ({ ok: true, args: { program: String(Number(/\(#(\d+)\)/.exec(prompt.user)?.[1]) + 2) } });
  const numbered = (): Writer => {
    let n = 0;
    return async () => {
      const i = n++;
      return { problem: DISTINCT[i % DISTINCT.length] + ` (#${i})`, answer: `${i + 2}`, solution: `Working gives ${i + 2}.` };
    };
  };
  beforeEach(() => {
    vi.stubEnv("CASCADE_DIFFICULTY_JUDGE", "openweight:zai-org/GLM-5.3@low");
    getAnchors.mockResolvedValue([anchor(1), anchor(2)]);
  });

  it("records each kept item's placement next to its target", async () => {
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered() }, programCall: programs, judgeCall: judge, judgeAnchors: anchors });
    expect(r.ok).toBe(true);
    const items = r.meta.cascade!.items;
    expect(items.every((it) => it.placement && Math.abs(it.placement.rating - 0.2375) < 1e-9)).toBe(true);
    expect(items.some((it) => typeof it.placement?.target === "number")).toBe(true);
  });

  it("compares placements with targets on the judge's own scale when it has a calibration", async () => {
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered() }, programCall: programs, judgeCall: judge, judgeAnchors: anchors });
    expect(r.meta.cascade?.judgeScale).toBe("calibrated");
    const t0 = r.meta.cascade!.items.find((it) => it.objective === 0)!.placement!.target!;
    expect(t0).toBeCloseTo(judgeScaleTarget("openweight:zai-org/GLM-5.3@low", "AMC10", targetRating("AMC10", 16)!)!, 4);
    expect(t0).toBeLessThan(targetRating("AMC10", 16)!); // GLM rates real #16 problems below their human rating

    vi.stubEnv("CASCADE_DIFFICULTY_JUDGE", "openweight:some/uncalibrated-judge@low");
    const raw = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered() }, programCall: programs, judgeCall: judge, judgeAnchors: anchors });
    expect(raw.meta.cascade?.judgeScale).toBe("human");
    expect(raw.meta.cascade!.items.find((it) => it.objective === 0)!.placement!.target).toBeCloseTo(targetRating("AMC10", 16)!, 4);
  });

  it("rejects off-target candidates only when a tolerance is set", async () => {
    vi.stubEnv("CASCADE_DIFFICULTY_TOLERANCE", "0.001");
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: numbered() }, programCall: programs, judgeCall: judge, judgeAnchors: anchors });
    // AMC10 #16–25 targets sit well above a 0.2375 placement.
    expect(r.ok).toBe(false);
    expect(r.meta.cascade?.rejections["too-easy"]).toBeGreaterThan(0);
  });
});

describe("reverse candidates on the hard tier", () => {
  // Seed i: "... 40+i marbles ...", answer 500+i. The reversed problem states 500+i and
  // asks for 40+i.
  const seed = (i: number): Anchor => ({ source: "AIME", number: 12, statement: `A jar holds ${40 + i} marbles of ${i + 3} colors; count the arrangements.`, answer: `${500 + i}`, solution: "sol" });
  const seeds = Array.from({ length: 30 }, (_, i) => seed(i));
  const writer = (wrongKey = false): Writer => async (req) => {
    const i = Number(/holds (\d+) marbles/.exec(req.user)?.[1]) - 40;
    const key = wrongKey ? 7 : 40 + i;
    return { problem: DISTINCT[i % DISTINCT.length] + ` Given ${500 + i} arrangements (#${i}).`, answer: `${key}`, masked: `${key}`, solution: `So the count is ${key}.` };
  };
  const host: CallOpenWeight = async (_rung, prompt, tool) => {
    if (tool.name === "emit_validity") return { ok: true, args: { wellPosed: true, reason: "ok" } };
    const i = Number(/\(#(\d+)\)/.exec(prompt.user)?.[1]);
    return { ok: true, args: { answer: `${40 + i}`, ambiguous: false } };
  };
  const input = () => ({ profile: "AIME 10-15", topic: "", recentTopics: [], accountant: new UsageAccountant(), plan: plan({ tier: "hard", competition: "AIME", bandLow: 10, bandHigh: 15, answerFormat: "integer" }) });

  beforeEach(() => {
    vi.stubEnv("CASCADE_REVERSE_SHARE", "1");
    vi.stubEnv("CASCADE_VERIFY_SCRATCH", "on");
    getAnchors.mockResolvedValue(seeds);
  });

  it("verifies reversed seeds with the cheap checks, never the Opus solver", async () => {
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: writer() }, cheapCall: host });
    expect(r.ok).toBe(true);
    expect(solveProblem).not.toHaveBeenCalled();
    expect(r.ok && r.meta.verdicts.every((v) => v === "verified")).toBe(true);
  });

  it("rejects a reversed problem whose key isn't a given of its seed", async () => {
    const r = await generateProblemsCascade({ ...input(), writers: { anthropic: writer(true) }, cheapCall: host });
    expect(r.ok).toBe(false);
    expect(r.meta.cascade?.rejections["guard-reverse"]).toBeGreaterThan(0);
  });
});

describe("first-wave racing per tier", () => {
  it("races 3 candidates per slot on the mid tier and 1 elsewhere by default", () => {
    expect(firstWaveFromEnv("easy")).toBe(1);
    expect(firstWaveFromEnv("mid")).toBe(3);
    expect(firstWaveFromEnv("hard")).toBe(1);
  });
  it("lets a tier setting beat the global one, and caps it at 4", () => {
    vi.stubEnv("CASCADE_FIRST_WAVE", "2");
    expect(firstWaveFromEnv("easy")).toBe(2);
    vi.stubEnv("CASCADE_FIRST_WAVE_MID", "1");
    expect(firstWaveFromEnv("mid")).toBe(1);
    vi.stubEnv("CASCADE_FIRST_WAVE_HARD", "9");
    expect(firstWaveFromEnv("hard")).toBe(4);
  });
});
