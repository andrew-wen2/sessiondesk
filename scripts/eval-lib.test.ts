import { describe, it, expect } from "vitest";
import {
  ArgError,
  cohortOf,
  experimentId,
  failureUpperBound,
  gateByTier,
  interleave,
  parseArgs,
  summarizeRun,
  type RunRecord,
} from "./eval-lib";

describe("parseArgs", () => {
  it("parses the run flags", () => {
    const a = parseArgs(["--yes", "--pipeline", "cascade", "--repeat", "20", "--concurrency", "3", "--max-dollars", "40", "--out", "runs/c.jsonl"]);
    expect(a).toMatchObject({ yes: true, pipeline: "cascade", repeat: 20, concurrency: 3, maxDollars: 40, out: "runs/c.jsonl" });
  });

  it.each([
    [["--repat", "3"], /Unknown flag --repat/],
    [["--repeat", "0"], /positive integer/],
    [["--pipeline", "fast"], /legacy or cascade/],
    [["--out"], /needs a value/],
    [["--compare", "a.jsonl"], /two run files/],
    [["stray"], /Unexpected argument/],
  ])("rejects %j", (argv, msg) => {
    expect(() => parseArgs(argv as string[])).toThrow(ArgError);
    expect(() => parseArgs(argv as string[])).toThrow(msg);
  });

  it("reads --compare's two files and --gate", () => {
    expect(parseArgs(["--compare", "a.jsonl", "b.jsonl"]).compare).toEqual(["a.jsonl", "b.jsonl"]);
    expect(parseArgs(["--gate", "a.jsonl", "--min-per-tier", "25"])).toMatchObject({ gate: "a.jsonl", minPerTier: 25 });
  });
});

describe("experimentId", () => {
  it("changes when anything that affects results changes", () => {
    const base = { pipeline: "cascade", ladderEnv: "A", gitRev: "abc", fixturesJson: "[]" };
    expect(experimentId(base)).toBe(experimentId({ ...base }));
    expect(experimentId(base)).not.toBe(experimentId({ ...base, ladderEnv: "B" }));
    expect(experimentId(base)).not.toBe(experimentId({ ...base, pipeline: "legacy" }));
  });
});

describe("cohortOf", () => {
  it("prefers the fixture's declared cohort, else the id", () => {
    expect(cohortOf({ id: "x", profile: "", topic: "", recentTopics: [], cohort: "hard" })).toBe("hard");
    expect(cohortOf({ id: "aime-hard-1", profile: "", topic: "", recentTopics: [] })).toBe("hard");
    expect(cohortOf({ id: "spanish", profile: "", topic: "", recentTopics: [] })).toBe("unknown");
  });
});

describe("failureUpperBound", () => {
  it("uses the rule of three for zero failures", () => {
    expect(failureUpperBound(0, 30)).toBeCloseTo(0.1);
    expect(failureUpperBound(0, 60)).toBeCloseTo(0.05);
  });
  it("is above the observed rate otherwise", () => {
    expect(failureUpperBound(2, 30)).toBeGreaterThan(2 / 30);
  });
});

const rec = (over: Partial<RunRecord>): RunRecord => ({ id: "f", ok: true, kept: 10, asked: 10, wallTimeMs: 100_000, cohort: "mid", ...over });

describe("gateByTier", () => {
  const opts = { minPerTier: 3, maxP95Ms: 270_000 };
  it("passes a tier with enough samples, no short sets and p95 inside budget", () => {
    const r = gateByTier([rec({}), rec({}), rec({})], opts);
    expect(r.verdict).toBe("pass");
  });
  it("fails on a single short set, and counts a thrown run in the denominator", () => {
    const r = gateByTier([rec({}), rec({}), rec({ ok: false, kept: undefined, asked: undefined })], opts);
    expect(r.tiers[0]).toMatchObject({ short: 1, verdict: "fail" });
  });
  it("fails when p95 exceeds the budget margin", () => {
    expect(gateByTier([rec({}), rec({}), rec({ wallTimeMs: 290_000 })], opts).verdict).toBe("fail");
  });
  it("reports insufficient evidence below the sample floor", () => {
    expect(gateByTier([rec({})], opts).verdict).toBe("insufficient-evidence");
    expect(gateByTier([], opts).verdict).toBe("insufficient-evidence");
  });
  it("judges each cohort separately (a hard failure can't hide behind easy passes)", () => {
    const r = gateByTier([rec({}), rec({}), rec({}), rec({ cohort: "hard", ok: false })], opts);
    expect(r.tiers.map((t) => [t.cohort, t.verdict])).toEqual([
      ["hard", "fail"],
      ["mid", "pass"],
    ]);
  });
});

describe("interleave", () => {
  it("round-robins across groups", () => {
    expect(interleave([[1, 2, 3], [4], [5, 6]])).toEqual([1, 4, 5, 2, 6, 3]);
  });
});

describe("summarizeRun", () => {
  it("computes short rate, $/set, wrong-answer rate and rating per fixture across repeats", () => {
    const records = [
      rec({ id: "f", sampleId: "f#0", dollars: 1, rungsKept: { "openweight:deepseek-flash": 8, "anthropic:claude-opus-5-5": 2 } }),
      rec({ id: "f", sampleId: "f#1", dollars: 3, ok: false }),
    ];
    const ratings = [
      { id: "f", sampleId: "f#0", index: 0, rating: 4, correct: true },
      { id: "f", sampleId: "f#0", index: 1, rating: 2, correct: false },
    ];
    const row = summarizeRun(records, ratings).get("f")!;
    expect(row).toMatchObject({ samples: 2, shortRate: 0.5, dollarsPerSet: 2, wrongAnswerRate: 0.5, avgRating: 3 });
    expect(row.rungsKept["openweight:deepseek-flash"]).toBe(8);
  });
});
