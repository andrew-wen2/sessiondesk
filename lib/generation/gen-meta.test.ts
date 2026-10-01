import { describe, it, expect } from "vitest";
import {
  GEN_META_VERSION,
  KILLED_AFTER_MS,
  MAX_PRIOR_ATTEMPTS,
  effectiveAttemptStatus,
  finishAttempt,
  parseGenMeta,
  startAttempt,
  truncateGenMeta,
  type GenMeta,
  type GenerationRunMeta,
} from "./gen-meta";
import { resolveAnswerFormat } from "@/lib/worksheet";

function run(over: Partial<GenerationRunMeta> = {}): GenerationRunMeta {
  return {
    planSource: "corpus",
    tier: "mid",
    answerFormat: "integer",
    competition: "AMC10",
    bandLow: 16,
    bandHigh: 25,
    usage: {},
    drops: [],
    verdicts: [],
    kept: 10,
    asked: 10,
    escalations: 0,
    ...over,
  };
}

const t0 = new Date("2026-09-23T12:00:00Z");
const t1 = new Date("2026-09-23T12:01:30Z");

describe("finishAttempt: published metadata", () => {
  it("replaces genMeta.problems on success", () => {
    const started = startAttempt(null, "problems", t0);
    const done = finishAttempt(started, "problems", t0, t1, run({ answerFormat: "expression" }), true);
    expect(done.problems?.answerFormat).toBe("expression");
    expect(done.attempts?.last).toMatchObject({ kind: "problems", status: "ok", wallTimeMs: 90_000, kept: 10 });
  });

  // REGRESSION: the failure path used to overwrite genMeta.problems with the failed
  // run (answerFormat ""), while the older set stayed published, so the old set's
  // grading silently changed format.
  it("leaves genMeta.problems, and so grading of the published set, untouched on failure", () => {
    const published: GenMeta = { v: GEN_META_VERSION, problems: run({ answerFormat: "integer" }) };
    const started = startAttempt(published, "problems", t0);
    const failed = finishAttempt(started, "problems", t0, t1, run({ answerFormat: "", kept: 3 }), false);
    expect(failed.problems?.answerFormat).toBe("integer");
    expect(resolveAnswerFormat(failed, "AIME prep")).toEqual({ format: "integer", fallback: false });
    expect(failed.attempts?.last).toMatchObject({ status: "failed", kept: 3 });
  });

  // REGRESSION: /api/generate rebuilt the row as {v, problems} and erased the lesson key.
  it("keeps genMeta.lesson when problems are regenerated", () => {
    const withLesson: GenMeta = { v: GEN_META_VERSION, lesson: run({ tier: "easy" }) };
    const done = finishAttempt(startAttempt(withLesson, "problems", t0), "problems", t0, t1, run(), true);
    expect(done.lesson?.tier).toBe("easy");
    expect(done.problems).toBeDefined();
  });

  it("keeps genMeta.problems and attempts when a lesson is written", () => {
    const afterProblems = finishAttempt(startAttempt(null, "problems", t0), "problems", t0, t1, run(), true);
    const t2 = new Date("2026-09-23T12:05:00Z");
    const lessonDone = finishAttempt(startAttempt(afterProblems, "lesson", t2), "lesson", t2, t1, run(), true);
    expect(lessonDone.problems).toEqual(afterProblems.problems);
    expect(lessonDone.attempts?.prior[0]).toMatchObject({ kind: "problems", status: "ok" });
  });

  it("starts fresh from a missing or foreign-version value", () => {
    expect(startAttempt(undefined, "problems", t0).v).toBe(GEN_META_VERSION);
    const foreign = startAttempt({ v: 99, problems: run() }, "problems", t0);
    expect(foreign.problems).toBeUndefined();
  });
});

describe("attempt history", () => {
  it("moves the previous attempt into prior, capped", () => {
    let meta: GenMeta | null = null;
    for (let i = 0; i < MAX_PRIOR_ATTEMPTS + 3; i++) {
      meta = startAttempt(meta, "problems", new Date(t0.getTime() + i * 1000));
    }
    expect(meta!.attempts!.prior).toHaveLength(MAX_PRIOR_ATTEMPTS);
    expect(meta!.attempts!.last!.startedAt).toBe(new Date(t0.getTime() + (MAX_PRIOR_ATTEMPTS + 2) * 1000).toISOString());
  });

  it("files a finished attempt under prior when a newer attempt became last meanwhile", () => {
    const first = startAttempt(null, "problems", t0);
    const second = startAttempt(first, "problems", t1);
    const firstDone = finishAttempt(second, "problems", t0, t1, run(), false);
    expect(firstDone.attempts?.last).toMatchObject({ status: "started", startedAt: t1.toISOString() });
    expect(firstDone.attempts?.prior[0]).toMatchObject({ status: "failed", startedAt: t0.toISOString() });
  });

  it("summarizes the most common drop reasons", () => {
    const drops = [
      { reason: "generation-failed" as const, excerpt: "a" },
      { reason: "near-duplicate" as const, excerpt: "b" },
      { reason: "generation-failed" as const, excerpt: "c" },
    ];
    const done = finishAttempt(startAttempt(null, "problems", t0), "problems", t0, t1, run({ drops }), false);
    expect(done.attempts?.last?.topDrops).toEqual([
      { reason: "generation-failed", count: 2 },
      { reason: "near-duplicate", count: 1 },
    ]);
  });
});

describe("effectiveAttemptStatus", () => {
  const started = { kind: "problems" as const, status: "started" as const, startedAt: t0.toISOString() };
  it("reads a stale started attempt as killed", () => {
    expect(effectiveAttemptStatus(started, new Date(t0.getTime() + KILLED_AFTER_MS + 1))).toBe("killed");
  });
  it("does not misread an attempt still inside the route's budget", () => {
    expect(effectiveAttemptStatus(started, new Date(t0.getTime() + 299_000))).toBe("started");
  });
  it("passes finished statuses through", () => {
    expect(effectiveAttemptStatus({ ...started, status: "ok" }, new Date(t0.getTime() + 10 * KILLED_AFTER_MS))).toBe("ok");
  });
});

describe("truncateGenMeta", () => {
  it("drops attempt history before trimming drop lists", () => {
    const bigExcerpt = "x".repeat(1000);
    let meta: GenMeta = startAttempt(null, "problems", t0);
    for (let i = 0; i < MAX_PRIOR_ATTEMPTS; i++) meta = startAttempt(meta, "problems", t1);
    meta = { ...meta, problems: run({ drops: Array.from({ length: 30 }, () => ({ reason: "near-duplicate" as const, excerpt: bigExcerpt })) }) };
    const out = truncateGenMeta(meta);
    expect(out.attempts?.prior).toEqual([]);
    expect(out.attempts?.last).toBeDefined();
    expect(JSON.stringify(out).length).toBeLessThanOrEqual(16_000);
  });

  it("leaves a small record untouched", () => {
    const meta = startAttempt(null, "problems", t0);
    expect(truncateGenMeta(meta)).toBe(meta);
  });
});

describe("parseGenMeta", () => {
  it("still reads rows that predate the attempts field", () => {
    expect(parseGenMeta({ v: GEN_META_VERSION, problems: run() })?.problems?.tier).toBe("mid");
  });
});
