// Read-only baseline: how often do problem sets fail or come back short, on which
// tier, and why? Reads Session.genMeta for one user's sessions. No API keys, no
// writes, no spend. Design: docs/designs/generation-cascade.md ("The Assignment").
//
//   npm run gen:baseline -- --email you@example.com [--days 60] [--json]
//   npm run gen:baseline -- --user-id <id> [--days 60] [--json]
//
// It UNDERCOUNTS, and says so in its output:
//  - Session has no generation timestamp, so the window is by session start date.
//  - Rows written before attempt tracking hold only the latest run per session: a
//    failure the tutor retried is gone, and a run killed at the 300s limit wrote
//    nothing. Rows with `attempts` recover some of that (history, killed runs).
//  - Before attempt tracking, a failed regenerate overwrote genMeta.problems, so an
//    old row's problems meta may describe the failed run rather than the published
//    set. That is counted here as the failure it was.
//  - Gemini's MALFORMED_FUNCTION_CALL was only logged (not stored) before attempt
//    tracking; old rows show it as a generic generation failure. Vercel logs
//    ("finishReason=MALFORMED_FUNCTION_CALL") are the other source while retained.
//
// Standalone Node process (outside Next) → its own PrismaClient, per CLAUDE.md.
import { PrismaClient } from "@prisma/client";
import {
  effectiveAttemptStatus,
  parseGenMeta,
  type AttemptRecord,
  type GenMeta,
  type GenerationRunMeta,
} from "@/lib/generation/gen-meta";

type Tier = GenerationRunMeta["tier"];
const TIERS: Tier[] = ["easy", "mid", "hard"];

// The set size a run was contracted to deliver. Hard sets were 5 until the count
// moved to 10 for every tier; which applied to an old row isn't recorded, so hard
// runs are judged against both and reported separately.
const TARGET = 10;
const HISTORICAL_HARD_TARGET = 5;

export type Row = { sessionId: string; start: Date; genMeta: unknown };

export type TierSummary = {
  tier: Tier;
  runs: number; // published-meta runs (one per session, the latest)
  short: number; // kept < 10
  shortOfHistoricalTarget: number | null; // hard only: kept < 5
  failedDropCauses: { reason: string; count: number; example: string }[];
  malformedMentions: number; // drop excerpts naming Gemini's malformed function call
  // Cascade candidates rejected, by reason, over EVERY cascade run (complete sets
  // included): the waste each generation change is meant to move. A short set's drops
  // alone hide it, because most rejected candidates are replaced in time.
  cascadeRejections: { runs: number; total: number; perSet: number | null; byReason: { reason: string; count: number }[] };
  attempts: { ok: number; failed: number; killed: number; started: number };
  wallTimeMs: { n: number; p50: number | null; p95: number | null };
};

export type BaselineSummary = {
  sessionsInWindow: number;
  withGenMeta: number;
  unreadable: number; // genMeta present but not a current-version record
  tiers: TierSummary[];
};

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)];
}

function attemptsOf(meta: GenMeta): AttemptRecord[] {
  const a = meta.attempts;
  if (!a) return [];
  return [...(a.last ? [a.last] : []), ...a.prior].filter((r) => r.kind === "problems");
}

export function summarize(rows: Row[], now: Date): BaselineSummary {
  let withGenMeta = 0;
  let unreadable = 0;
  const byTier = new Map<Tier, { runs: GenerationRunMeta[]; attempts: AttemptRecord[] }>(
    TIERS.map((t) => [t, { runs: [], attempts: [] }])
  );
  const unknownTierAttempts: AttemptRecord[] = [];

  for (const row of rows) {
    if (row.genMeta == null) continue;
    withGenMeta++;
    const meta = parseGenMeta(row.genMeta);
    if (!meta) {
      unreadable++;
      continue;
    }
    if (meta.problems) byTier.get(meta.problems.tier)?.runs.push(meta.problems);
    for (const a of attemptsOf(meta)) {
      if (a.tier) byTier.get(a.tier)?.attempts.push(a);
      else unknownTierAttempts.push(a); // a "started" marker that never finished
    }
  }

  const tiers = TIERS.map((tier): TierSummary => {
    const { runs, attempts } = byTier.get(tier)!;
    const causes = new Map<string, { count: number; example: string }>();
    let malformedMentions = 0;
    for (const run of runs) {
      if (run.kept >= TARGET) continue;
      for (const d of run.drops) {
        const c = causes.get(d.reason) ?? { count: 0, example: d.excerpt };
        c.count++;
        causes.set(d.reason, c);
        if (/malformed_function_call|MALFORMED_FUNCTION_CALL/.test(d.excerpt)) malformedMentions++;
      }
    }
    const rejections = new Map<string, number>();
    const cascadeRuns = runs.filter((r) => r.cascade);
    for (const run of cascadeRuns) {
      for (const [reason, n] of Object.entries(run.cascade!.rejections)) rejections.set(reason, (rejections.get(reason) ?? 0) + (n ?? 0));
    }
    const rejectedTotal = [...rejections.values()].reduce((a, b) => a + b, 0);
    const counts = { ok: 0, failed: 0, killed: 0, started: 0 };
    const walls: number[] = [];
    for (const a of attempts) {
      counts[effectiveAttemptStatus(a, now)]++;
      if (typeof a.wallTimeMs === "number") walls.push(a.wallTimeMs);
    }
    walls.sort((x, y) => x - y);
    return {
      tier,
      runs: runs.length,
      short: runs.filter((r) => r.kept < TARGET).length,
      shortOfHistoricalTarget: tier === "hard" ? runs.filter((r) => r.kept < HISTORICAL_HARD_TARGET).length : null,
      failedDropCauses: [...causes]
        .map(([reason, v]) => ({ reason, ...v }))
        .sort((a, b) => b.count - a.count),
      malformedMentions,
      cascadeRejections: {
        runs: cascadeRuns.length,
        total: rejectedTotal,
        perSet: cascadeRuns.length ? rejectedTotal / cascadeRuns.length : null,
        byReason: [...rejections].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
      },
      attempts: counts,
      wallTimeMs: { n: walls.length, p50: percentile(walls, 50), p95: percentile(walls, 95) },
    };
  });

  // Attempts with no tier are "started" markers from runs that never finished;
  // classify them (killed vs still running) under a separate line.
  if (unknownTierAttempts.length > 0) {
    const counts = { ok: 0, failed: 0, killed: 0, started: 0 };
    for (const a of unknownTierAttempts) counts[effectiveAttemptStatus(a, now)]++;
    tiers.push({
      tier: "unknown" as Tier,
      runs: 0,
      short: 0,
      shortOfHistoricalTarget: null,
      failedDropCauses: [],
      malformedMentions: 0,
      cascadeRejections: { runs: 0, total: 0, perSet: null, byReason: [] },
      attempts: counts,
      wallTimeMs: { n: 0, p50: null, p95: null },
    });
  }

  return { sessionsInWindow: rows.length, withGenMeta, unreadable, tiers };
}

// Rows from the GenerationAttempt table: complete (retries and kills included), unlike
// genMeta. Empty until that table exists and generation has run since.
export type AttemptRow = {
  kind: string;
  pipeline: string | null;
  tier: string | null;
  status: string;
  startedAt: Date;
  wallTimeMs: number | null;
  kept: number | null;
  asked: number | null;
};

export type AttemptGroup = {
  key: string; // "tier/pipeline"
  total: number;
  ok: number;
  failed: number;
  killed: number;
  inProgress: number;
  short: number; // finished ok=false or kept < asked
  p95WallMs: number | null;
};

export function summarizeAttempts(rows: AttemptRow[], now: Date): AttemptGroup[] {
  const groups = new Map<string, AttemptRow[]>();
  for (const r of rows.filter((x) => x.kind === "problems")) {
    const key = `${r.tier ?? "unknown"}/${r.pipeline ?? "unknown"}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, rs]) => {
      const status = rs.map((r) =>
        effectiveAttemptStatus({ kind: "problems", status: r.status as AttemptRecord["status"], startedAt: r.startedAt.toISOString() }, now)
      );
      const walls = rs.map((r) => r.wallTimeMs).filter((w): w is number => typeof w === "number").sort((a, b) => a - b);
      return {
        key,
        total: rs.length,
        ok: status.filter((x) => x === "ok").length,
        failed: status.filter((x) => x === "failed").length,
        killed: status.filter((x) => x === "killed").length,
        inProgress: status.filter((x) => x === "started").length,
        short: rs.filter((r, i) => status[i] === "failed" || status[i] === "killed" || (r.kept != null && r.asked != null && r.kept < r.asked)).length,
        p95WallMs: percentile(walls, 95),
      };
    });
}

function renderAttempts(groups: AttemptGroup[]): string {
  if (groups.length === 0) return "GenerationAttempt table: no rows yet (complete counts start once it is deployed).";
  const lines = ["GenerationAttempt table (complete, including retries and kills):"];
  for (const g of groups) {
    lines.push(
      `  [${g.key}] total=${g.total} ok=${g.ok} failed=${g.failed} killed=${g.killed} in-progress=${g.inProgress} short-or-failed=${g.short}` +
        (g.p95WallMs != null ? ` p95=${g.p95WallMs}ms` : "")
    );
  }
  return lines.join("\n");
}

function render(s: BaselineSummary, days: number): string {
  const lines: string[] = [];
  lines.push(`Generation baseline — sessions starting in the last ${days} days`);
  lines.push(`${s.sessionsInWindow} sessions, ${s.withGenMeta} with genMeta, ${s.unreadable} unreadable (older format)`);
  lines.push("");
  for (const t of s.tiers) {
    const pct = t.runs ? ` (${Math.round((100 * t.short) / t.runs)}%)` : "";
    lines.push(`[${t.tier}] runs=${t.runs} short(<10)=${t.short}${pct}` +
      (t.shortOfHistoricalTarget != null ? ` short(<5, old hard contract)=${t.shortOfHistoricalTarget}` : ""));
    const a = t.attempts;
    if (a.ok + a.failed + a.killed + a.started > 0) {
      lines.push(`  attempts: ok=${a.ok} failed=${a.failed} killed=${a.killed} in-progress=${a.started}`);
    }
    if (t.wallTimeMs.n > 0) lines.push(`  wall time: p50=${t.wallTimeMs.p50}ms p95=${t.wallTimeMs.p95}ms (n=${t.wallTimeMs.n})`);
    for (const c of t.failedDropCauses) lines.push(`  ${c.reason}: ${c.count}   e.g. "${c.example.slice(0, 80)}"`);
    if (t.malformedMentions > 0) lines.push(`  → ${t.malformedMentions} drop(s) name MALFORMED_FUNCTION_CALL`);
    const r = t.cascadeRejections;
    if (r.runs > 0) {
      lines.push(`  cascade rejections: ${r.total} over ${r.runs} run(s), ${r.perSet!.toFixed(1)}/set`);
      for (const x of r.byReason) lines.push(`    ${x.reason}: ${x.count} (${Math.round((100 * x.count) / Math.max(1, r.total))}%)`);
    }
  }
  lines.push("");
  lines.push("UNDERCOUNT: this is a floor, not a rate. Retried failures and 300s kills from before");
  lines.push("attempt tracking left no record, and the window is by session date, not generation date.");
  lines.push("Check Vercel logs for 'finishReason=MALFORMED_FUNCTION_CALL' while they are retained.");
  return lines.join("\n");
}

function arg(argv: string[], name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(["--email", "--user-id", "--days", "--json"]);
  const unknownFlag = argv.find((a) => a.startsWith("--") && !known.has(a));
  const email = arg(argv, "email");
  const userIdArg = arg(argv, "user-id");
  const days = Number(arg(argv, "days") ?? "60");
  if (unknownFlag || (!email && !userIdArg) || !Number.isFinite(days) || days <= 0) {
    console.error(
      (unknownFlag ? `Unknown flag ${unknownFlag}. ` : "") +
        "Usage: npm run gen:baseline -- (--email <email> | --user-id <id>) [--days 60] [--json]"
    );
    process.exit(1);
  }

  const prisma = new PrismaClient();
  try {
    const user = userIdArg
      ? await prisma.user.findUnique({ where: { id: userIdArg }, select: { id: true } })
      : await prisma.user.findUnique({ where: { email: email! }, select: { id: true } });
    if (!user) {
      console.error(`No user found for ${userIdArg ? `id ${userIdArg}` : email}. Check the value and DATABASE_URL.`);
      process.exit(1);
    }
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await prisma.session.findMany({
      where: { userId: user.id, start: { gte: since } },
      select: { id: true, start: true, genMeta: true },
    });
    const summary = summarize(
      rows.map((r) => ({ sessionId: r.id, start: r.start, genMeta: r.genMeta })),
      new Date()
    );
    // The attempt table is keyed by when generation ran, so its window is exact.
    let attempts: AttemptGroup[] = [];
    try {
      const attemptRows = await prisma.generationAttempt.findMany({
        where: { userId: user.id, startedAt: { gte: since } },
        select: { kind: true, pipeline: true, tier: true, status: true, startedAt: true, wallTimeMs: true, kept: true, asked: true },
      });
      attempts = summarizeAttempts(attemptRows, new Date());
    } catch {
      // Table not migrated yet: the genMeta summary above is all there is.
    }
    console.log(
      argv.includes("--json")
        ? JSON.stringify({ genMeta: summary, attempts }, null, 2)
        : `${render(summary, days)}\n\n${renderAttempts(attempts)}`
    );
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[gen:baseline]", e);
    process.exit(1);
  });
}
