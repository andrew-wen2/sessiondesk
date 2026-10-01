// Accuracy eval for cascade rungs: how often does a rung ship a WRONG answer key?
// Complements gen:admit (does the tool call work and LaTeX survive) and the human
// --rate pass in eval:generation (calibration). This is the automated first pass
// behind the design doc's correctness gate. The human pass stays the final word.
//
// Per rung under test: plan every fixture, keep the ones whose plan lands on the
// rung's tier, and have the rung write --per-tier single problems with the exact
// prompt the cascade sends (cascadeRequestBuilder). Items the cascade's own guards
// reject are counted but never judged, since they would never ship. Everything else
// is judged blind: cheap cross-family judge first, Opus only on disagreement plus an
// audit sample (see eval-accuracy-lib.ts for the protocol and why).
//
// SPENDS REAL API CREDIT — refuses to run without --yes; stops starting new items at
// --max-dollars. Needs DATABASE_URL for contest fixtures (anchors are read-only).
//
//   npm run eval:accuracy -- --dry-run --rung easy=openweight:deepseek-ai/DeepSeek-V4.1-Flash
//   npm run eval:accuracy -- --yes --rung easy=... --rung mid=... --out runs/accuracy.jsonl
//   npm run eval:accuracy -- --summary runs/accuracy.jsonl
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { countForTier } from "@/lib/calibration";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun, isPriced } from "@/lib/generation/pricing";
import { parseLadder } from "@/lib/generation/cascade/ladder";
import { buildSpecs } from "@/lib/generation/cascade/slots";
import { cascadeCheck, cascadeRequestBuilder, SPARES, writersFor } from "@/lib/generation/cascade/generate";
import { RungError } from "@/lib/generation/cascade/writers";
import { prisma } from "@/lib/prisma";
import type { Fixture } from "./eval-lib";
import {
  ACCURACY_USAGE,
  AccuracyArgError,
  auditPick,
  cheapJudgeFor,
  equivKey,
  estimateDollars,
  itemId,
  judgeStep,
  parseAccuracyArgs,
  summarizeAccuracy,
  type AccuracyArgs,
  type ItemRecord,
  type RungUnderTest,
} from "./eval-accuracy-lib";
import { equivalent, openWeightSolve, opusSolve, planFixtures, type Planned, type SolveArgs } from "./eval-accuracy-shared";

const FIXTURES = "scripts/eval-fixtures/generation-fixtures.json";

// ---------------------------------------------------------------------------
// One item: write, guard, judge
// ---------------------------------------------------------------------------

async function runItem(args: {
  test: RungUnderTest;
  index: number;
  round: number; // how many times this fixture has come round for this rung: picks its slot
  planned: Planned;
  a: AccuracyArgs;
  opus: Anthropic;
}): Promise<ItemRecord> {
  const { test, index, round, planned, a, opus } = args;
  const { plan, pool, mode, fixture } = planned;
  const accountant = new UsageAccountant();
  const id = itemId(test.tier, test.spec, index);
  const count = countForTier(plan.tier);
  const { specs } = buildSpecs({ plan, mode, seeds: mode === "variant" ? pool : [], total: count + SPARES });
  const slot = round % specs.length;
  const spec = specs[slot];
  const request = cascadeRequestBuilder({
    plan,
    profile: fixture.profile,
    topic: fixture.topic,
    recentTopics: fixture.recentTopics,
    pool,
    calibration: mode === "variant" ? pool.slice(0, 4) : pool,
    count,
  })({ objective: slot % count, spec, kept: [], rung: test.rung });

  const rung = a.timeoutS ? { ...test.rung, timeoutMs: a.timeoutS * 1000 } : test.rung;
  const writer = writersFor(new Set([rung.provider]))[rung.provider]!;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("rung-timeout"), rung.timeoutMs);
  const started = Date.now();
  const rec: ItemRecord = {
    id,
    tier: test.tier,
    rung: test.spec,
    index,
    fixtureId: fixture.id,
    answerFormat: plan.answerFormat,
    write: { ok: false, ms: 0, finish: "api-error", message: "" },
    guard: null,
    opus: [],
    audited: auditPick(id, a.audit),
    dollars: 0,
    unpriced: [],
  };
  const finish = () => {
    const cost = costForRun(accountant.perModelUsage());
    rec.dollars = cost.total;
    rec.unpriced = cost.unpriced;
    return rec;
  };

  try {
    const p = await writer({ rung, ...request, signal: controller.signal, recordUsage: (u) => accountant.recordFor("generation", rung.provider, rung.model, u) });
    rec.write = { ok: true, ms: Date.now() - started, problem: p.problem, answer: p.answer, solution: p.solution };
    rec.guard = cascadeCheck(plan)(p, spec);
  } catch (e) {
    rec.write = {
      ok: false,
      ms: Date.now() - started,
      finish: e instanceof RungError ? e.finish : "api-error",
      message: e instanceof Error ? e.message.slice(0, 200) : String(e),
    };
  } finally {
    clearTimeout(timer);
  }
  if (!rec.write.ok || rec.guard) return finish();

  const cheapSpec = cheapJudgeFor(rung.model, a.cheapJudge);
  const [cheapRung] = parseLadder(test.tier, `${cheapSpec},anthropic:claude-opus-5-5`);
  rec.cheapJudge = cheapSpec;
  const solveArgs: SolveArgs = { problem: rec.write.problem, plan, tier: test.tier, accountant };
  for (;;) {
    const step = judgeStep({ writerAnswer: rec.write.answer, format: plan.answerFormat, cheap: rec.cheap, opus: rec.opus, audit: rec.audited, equiv: rec.equiv });
    if ("verdict" in step) {
      rec.verdict = step.verdict;
      rec.basis = step.basis;
      return finish();
    }
    if (step.need === "equiv") {
      rec.equiv = { ...rec.equiv, [equivKey(step.a, step.b)]: await equivalent(step.a, step.b, rec.write.problem, accountant) };
    } else if (step.need === "cheap") rec.cheap = await openWeightSolve(cheapRung, solveArgs);
    else rec.opus.push(await opusSolve(opus, a.judgeModel, solveArgs));
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);

function printSummary(records: ItemRecord[]) {
  const rows = summarizeAccuracy(records);
  console.log(
    "\n" +
      [
        ["tier", "rung", "written", "guard-rej", "judged", "wrong", "ill-posed", "unresolved", "wrong rate", "95% upper", "audit caught", "opus solves", "$"].join(" | "),
        ...rows.map((r) =>
          [
            r.tier,
            r.rung,
            `${r.attempted - r.writeFailed}/${r.attempted}`,
            r.guardRejected,
            r.judged,
            r.wrong,
            r.illPosed,
            r.unresolved,
            pct(r.wrongRate),
            pct(r.upperBound),
            `${r.auditCaught}/${r.audited}`,
            r.opusSolves,
            `${r.dollars.toFixed(2)}${r.unpriced.length ? "+" : ""}`,
          ].join(" | ")
        ),
      ].join("\n")
  );
  const unpriced = [...new Set(rows.flatMap((r) => r.unpriced))];
  if (unpriced.length) console.log(`\nUNPRICED (dollar figures are partial): ${unpriced.join(", ")}`);
  const thin = rows.filter((r) => r.judged < 30);
  if (thin.length) console.log(`\nFewer than 30 judged items (the design doc's minimum): ${thin.map((r) => `${r.tier} ${r.rung}`).join("; ")}.`);
  if (rows.some((r) => r.auditCaught > 0)) {
    console.log("Audit caught a cheap-judge agreement on a wrong answer — the wrong rate above undercounts; raise --audit for that rung.");
  }
  console.log("Wrong rate = (wrong + ill-posed) / judged. Unresolved items are excluded; read them in the JSONL before trusting a low rate.");
}

function readRecords(file: string): ItemRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as ItemRecord);
}

// ---------------------------------------------------------------------------

async function main() {
  let a: AccuracyArgs;
  try {
    a = parseAccuracyArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof AccuracyArgError) {
      console.error(`${e.message}\n\n${ACCURACY_USAGE}`);
      process.exit(1);
    }
    throw e;
  }
  if (a.summary) {
    printSummary(readRecords(a.summary));
    return;
  }

  // Judges must be priced, or --max-dollars can't stop anything.
  const judgeSpecs = [...new Set(a.rungs.map((r) => cheapJudgeFor(r.rung.model, a.cheapJudge)))];
  const unpricedJudges = [`anthropic:${a.judgeModel}`, ...judgeSpecs.map((s) => s.replace(/@.*$/, ""))].filter((s) => {
    const i = s.indexOf(":");
    return !isPriced(s.slice(0, i), s.slice(i + 1));
  });
  const est = estimateDollars(a.rungs, a.perTier, a.audit);
  console.log(
    `Rungs: ${a.rungs.map((r) => `${r.tier}=${r.spec} (thinking=${r.rung.thinking} tool=${r.rung.toolChoice})`).join("; ")}\n` +
      `Judges: cheap ${judgeSpecs.join(", ")}; Opus ${a.judgeModel} on disagreement + ${Math.round(a.audit * 100)}% audit\n` +
      `${a.rungs.length * a.perTier} items. Estimated spend: ~$${est.expected.toFixed(0)} expected, $${est.worst.toFixed(0)} worst case; capped at $${a.maxDollars}.`
  );
  if (unpricedJudges.length) {
    console.error(`No price row for ${unpricedJudges.join(", ")} in lib/generation/pricing.ts — add one first so --max-dollars works.`);
    process.exit(1);
  }
  if (a.dryRun) return;
  if (!a.yes) {
    console.error("eval:accuracy makes real model calls. Re-run with --yes to spend.");
    process.exit(1);
  }
  for (const p of new Set([...a.rungs.map((r) => r.rung.provider), "openweight" as const])) {
    if (!writersFor(new Set([p]))[p]) {
      console.error(`No credentials for ${p}. Run npm run gen:check.`);
      process.exit(1);
    }
  }

  // Without this the Opus judge fails per item and every disagreement lands as
  // "unresolved", which reads like a result instead of a configuration error.
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set — the Opus judge needs it.");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set — contest fixtures read corpus anchors (read-only). Set it, ideally to a non-production database.");
    process.exit(1);
  }

  mkdirSync(path.dirname(a.out), { recursive: true });
  const fixtures = JSON.parse(readFileSync(FIXTURES, "utf8")) as Fixture[];
  const planned = await planFixtures(fixtures, `${a.out}.plans.json`);
  const done = new Set(readRecords(a.out).map((r) => r.id));
  let spent = readRecords(a.out).reduce((n, r) => n + r.dollars, 0);

  const queue: { test: RungUnderTest; index: number; round: number; planned: Planned }[] = [];
  for (const test of a.rungs) {
    const pool = planned.filter(
      (p) => p.plan.tier === test.tier && (!a.contestOnly || p.plan.competition) && (p.mode === "scratch" || p.pool.length > 0)
    );
    if (pool.length === 0) {
      console.error(`No ${a.contestOnly ? "contest " : ""}fixture plans to the ${test.tier} tier — skipping ${test.spec}.`);
      continue;
    }
    for (let i = 0; i < a.perTier; i++) {
      if (done.has(itemId(test.tier, test.spec, i))) continue;
      // Round-robin across the tier's fixtures, so every profile is represented.
      queue.push({ test, index: i, round: Math.floor(i / pool.length), planned: pool[i % pool.length] });
    }
  }
  console.log(`${queue.length} items to run (${done.size} already in ${a.out}).`);

  const opus = new Anthropic({ maxRetries: 2 });
  let stopped = false;
  let finished = 0;
  const workers = Array.from({ length: Math.min(a.concurrency, queue.length) }, async () => {
    for (;;) {
      if (spent >= a.maxDollars) {
        stopped = true;
        return;
      }
      const job = queue.shift();
      if (!job) return;
      const rec = await runItem({ ...job, a, opus });
      spent += rec.dollars;
      appendFileSync(a.out, JSON.stringify(rec) + "\n");
      finished++;
      const what = !rec.write.ok ? `write ${rec.write.finish}` : rec.guard ? `guard ${rec.guard}` : `${rec.verdict} (${rec.basis})`;
      console.log(`[${finished}/${finished + queue.length}] ${rec.tier} ${rec.rung} #${rec.index} ${rec.fixtureId}: ${what} — $${spent.toFixed(2)} so far`);
    }
  });
  await Promise.all(workers);
  if (stopped) console.log(`\nStopped at --max-dollars $${a.maxDollars} (spent $${spent.toFixed(2)}). Re-run the same command with a higher cap to resume.`);
  printSummary(readRecords(a.out));
}

main()
  .catch((e) => {
    console.error("[eval:accuracy]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
