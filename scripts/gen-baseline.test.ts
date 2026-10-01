import { describe, it, expect } from "vitest";
import { summarize, summarizeAttempts, type Row } from "./gen-baseline";
import { GEN_META_VERSION, KILLED_AFTER_MS, type GenerationRunMeta } from "@/lib/generation/gen-meta";

const now = new Date("2026-09-23T12:00:00Z");

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

function row(genMeta: unknown, i = 0): Row {
  return { sessionId: `s${i}`, start: now, genMeta };
}

describe("summarize", () => {
  it("counts short runs per tier and groups their drop causes", () => {
    const rows = [
      row({ v: GEN_META_VERSION, problems: run() }, 1),
      row({
        v: GEN_META_VERSION,
        problems: run({
          kept: 6,
          drops: [
            { reason: "generation-failed", excerpt: "malformed_function_call" },
            { reason: "generation-failed", excerpt: "no_tool" },
            { reason: "near-duplicate", excerpt: "x" },
          ],
        }),
      }, 2),
    ];
    const mid = summarize(rows, now).tiers.find((t) => t.tier === "mid")!;
    expect(mid.runs).toBe(2);
    expect(mid.short).toBe(1);
    expect(mid.failedDropCauses[0]).toMatchObject({ reason: "generation-failed", count: 2 });
    expect(mid.malformedMentions).toBe(1);
  });

  it("reports hard runs against both the current and the old 5-problem contract", () => {
    const hard = summarize(
      [row({ v: GEN_META_VERSION, problems: run({ tier: "hard", kept: 5 }) })],
      now
    ).tiers.find((t) => t.tier === "hard")!;
    expect(hard.short).toBe(1);
    expect(hard.shortOfHistoricalTarget).toBe(0);
  });

  it("separates missing, unreadable and readable genMeta", () => {
    const s = summarize([row(null, 1), row({ v: 99 }, 2), row({ v: GEN_META_VERSION, problems: run() }, 3)], now);
    expect(s).toMatchObject({ sessionsInWindow: 3, withGenMeta: 2, unreadable: 1 });
  });

  it("classifies a stale started marker as killed, under an unknown tier", () => {
    const startedAt = new Date(now.getTime() - KILLED_AFTER_MS - 1000).toISOString();
    const s = summarize(
      [row({ v: GEN_META_VERSION, attempts: { last: { kind: "problems", status: "started", startedAt }, prior: [] } })],
      now
    );
    expect(s.tiers.find((t) => (t.tier as string) === "unknown")?.attempts.killed).toBe(1);
  });

  it("reports wall-time percentiles from finished attempts", () => {
    const attempts = {
      last: { kind: "problems", status: "ok", startedAt: now.toISOString(), wallTimeMs: 200_000, tier: "mid" },
      prior: [
        { kind: "problems", status: "failed", startedAt: now.toISOString(), wallTimeMs: 100_000, tier: "mid" },
        { kind: "lesson", status: "ok", startedAt: now.toISOString(), wallTimeMs: 999_999, tier: "mid" },
      ],
    };
    const mid = summarize([row({ v: GEN_META_VERSION, attempts })], now).tiers.find((t) => t.tier === "mid")!;
    expect(mid.attempts).toMatchObject({ ok: 1, failed: 1 });
    expect(mid.wallTimeMs).toEqual({ n: 2, p50: 100_000, p95: 200_000 });
  });
  it("totals cascade rejections over every run, complete sets included", () => {
    const cascade = (rejections: Record<string, number>) => ({
      ladder: [],
      items: [],
      candidatesLaunched: 0,
      candidatesAborted: 0,
      callsMade: 0,
      finishes: {},
      rejections,
    });
    const rows = [
      row({ v: GEN_META_VERSION, problems: run({ tier: "easy", cascade: cascade({ "solver-disagree": 5, duplicate: 4 }) }) }, 1),
      row({ v: GEN_META_VERSION, problems: run({ tier: "easy", kept: 9, cascade: cascade({ "solver-disagree": 3 }) }) }, 2),
      row({ v: GEN_META_VERSION, problems: run({ tier: "easy" }) }, 3), // legacy run: not counted
    ];
    const easy = summarize(rows, now).tiers.find((t) => t.tier === "easy")!;
    expect(easy.cascadeRejections).toEqual({
      runs: 2,
      total: 12,
      perSet: 6,
      byReason: [
        { reason: "solver-disagree", count: 8 },
        { reason: "duplicate", count: 4 },
      ],
    });
  });
});

describe("summarizeAttempts", () => {
  it("groups by tier and pipeline and counts kills and short sets", () => {
    const stale = new Date(now.getTime() - KILLED_AFTER_MS - 1000);
    const rows = [
      { kind: "problems", pipeline: "cascade", tier: "mid", status: "ok", startedAt: now, wallTimeMs: 90_000, kept: 10, asked: 10 },
      { kind: "problems", pipeline: "cascade", tier: "mid", status: "failed", startedAt: now, wallTimeMs: 200_000, kept: 7, asked: 10 },
      { kind: "problems", pipeline: "cascade", tier: "mid", status: "started", startedAt: stale, wallTimeMs: null, kept: null, asked: null },
      { kind: "problems", pipeline: "legacy", tier: "mid", status: "ok", startedAt: now, wallTimeMs: 50_000, kept: 10, asked: 10 },
      { kind: "lesson", pipeline: null, tier: "mid", status: "ok", startedAt: now, wallTimeMs: 10, kept: 1, asked: 1 },
    ];
    const groups = summarizeAttempts(rows, now);
    expect(groups.map((g) => g.key)).toEqual(["mid/cascade", "mid/legacy"]);
    expect(groups[0]).toMatchObject({ total: 3, ok: 1, failed: 1, killed: 1, short: 2, p95WallMs: 200_000 });
  });
});
