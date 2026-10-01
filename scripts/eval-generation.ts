// The generation pipeline eval — the instrument the plan runs on. Captures a
// baseline, then compares a candidate run against it so "better and cheaper" is a
// number, not an impression. The pure logic lives in scripts/eval-lib.ts (tested).
//
// Contest fixtures exercise generateProblems() → getAnchors() → Prisma, because
// retrieval quality is part of what this measures; non-contest fixtures never touch
// the corpus.
//
// Headline metric is NOT automated (Eng/CEO: agreement rate and kept/asked are both
// gameable by loosening guards) — it's the human --rate pass: a 1-5 calibration
// rating AND a separate "is the answer right?" judgement per problem, so a wrong
// answer and a too-easy problem are no longer folded into one number. The short-set
// rate, p95 wall time and $/set are diagnostics, and --gate applies the cutover rule.
//
// Every record carries its sample id (`fixture#repeat`), pipeline and experiment id
// (a hash of pipeline, ladder env, git revision and the fixture file), so --resume
// never skips a repeat that didn't run, never mixes two configurations in one file,
// and --compare lines up samples correctly.
import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { generateProblems } from "@/lib/generation/problems";
import { costForRun } from "@/lib/generation/pricing";
import { ROUTE_BUDGET_MS } from "@/lib/generation/cascade/deadline";
import {
  ArgError,
  USAGE,
  cohortOf,
  experimentId,
  gateByTier,
  interleave,
  parseArgs,
  ratingKey,
  recordSampleId,
  sampleIdOf,
  summarizeRun,
  type Args,
  type Fixture,
  type Rating,
  type RunRecord,
} from "./eval-lib";

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

const ratingsPathFor = (runPath: string) => runPath.replace(/\.jsonl$/, ".ratings.jsonl");

function gitRev(): string {
  try {
    return execSync("git rev-parse --short HEAD", { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return "unknown";
  }
}

function ladderEnv(): string {
  return Object.keys(process.env)
    .filter((k) => k.startsWith("GENERATION_") || k.startsWith("CASCADE_") || k === "OPENWEIGHT_BASE_URL")
    .sort()
    .map((k) => `${k}=${process.env[k]}`)
    .join(";");
}

async function runEval(args: Args) {
  const fixturesPath = path.join(process.cwd(), args.fixtures);
  if (!existsSync(fixturesPath)) {
    console.error(`No fixture file at ${fixturesPath}.`);
    process.exit(1);
  }
  const fixturesJson = readFileSync(fixturesPath, "utf8");
  const fixtures: Fixture[] = JSON.parse(fixturesJson);
  if (args.pipeline) process.env.GENERATION_PIPELINE = args.pipeline;
  const pipeline = (process.env.GENERATION_PIPELINE as "legacy" | "cascade" | undefined) ?? "legacy";
  const expId = experimentId({ pipeline, ladderEnv: ladderEnv(), gitRev: gitRev(), fixturesJson });

  const samples = fixtures.flatMap((f) => Array.from({ length: args.repeat }, (_, r) => ({ f, repeat: r })));
  console.log(`Fixtures: ${fixtures.length} × repeat ${args.repeat} = ${samples.length} sets. Pipeline: ${pipeline}. Experiment: ${expId}.`);
  console.log(
    `Cost: roughly $0.3–1.5 per set depending on tier and ladder — about $${(samples.length * 0.3).toFixed(0)}–$${(samples.length * 1.5).toFixed(0)} for this run. ` +
      `Use --max-dollars to cap it.`
  );

  if (args.dryRun) {
    console.log("--dry-run: no calls made. Samples:", samples.map((s) => sampleIdOf(s.f.id, s.repeat)).join(", "));
    return;
  }
  if (!args.yes) {
    console.error("This spends real API credit. Re-run with --yes to proceed (or --dry-run to preview).");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set. Run `npm run gen:check` to see everything that's missing.");
    process.exit(1);
  }

  const outPath = path.join(process.cwd(), args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });
  const existing = readJsonl<RunRecord>(outPath);
  if (existing.length > 0 && !args.resume && !args.append) {
    console.error(`${args.out} already has ${existing.length} records. Pass --resume to continue it, --append to add to it, or choose a new --out.`);
    process.exit(1);
  }
  if (args.resume) {
    const other = existing.find((r) => r.experimentId && r.experimentId !== expId);
    if (other) {
      console.error(
        `${args.out} was written by experiment ${other.experimentId}, not ${expId} (pipeline, ladder env, code or fixtures differ). Resume refused — use a new --out.`
      );
      process.exit(1);
    }
  }
  const done = new Set(existing.map(recordSampleId));
  const todo = samples.filter((s) => !done.has(sampleIdOf(s.f.id, s.repeat)));
  if (done.size > 0) console.log(`Skipping ${samples.length - todo.length} samples already in ${args.out}.`);

  const client = new Anthropic({ maxRetries: 4, timeout: 300_000 });
  let spent = existing.reduce((s, r) => s + (r.dollars ?? 0), 0);
  let stoppedForBudget = false;

  async function runOne({ f, repeat }: (typeof samples)[number]): Promise<void> {
    const start = Date.now();
    const accountant = new UsageAccountant();
    const base = {
      id: f.id,
      sampleId: sampleIdOf(f.id, repeat),
      repeat,
      experimentId: expId,
      pipeline,
      cohort: cohortOf(f),
    };
    let record: RunRecord;
    try {
      const result = await generateProblems({
        client,
        profile: f.profile,
        topic: f.topic,
        recentTopics: f.recentTopics,
        accountant,
        startedAt: start,
      });
      const dropsByReason: Record<string, number> = {};
      for (const d of result.meta.drops) dropsByReason[d.reason] = (dropsByReason[d.reason] ?? 0) + 1;
      const verdictCounts: Record<string, number> = {};
      for (const v of result.meta.verdicts) verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
      const rungsKept: Record<string, number> = {};
      const cascade = result.meta.cascade;
      for (const it of cascade?.items ?? []) {
        const key = `${cascade!.ladder[it.rung]?.provider ?? "?"}:${it.model}`;
        rungsKept[key] = (rungsKept[key] ?? 0) + 1;
      }
      const cost = costForRun(result.meta.usage);
      record = {
        ...base,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        tier: result.meta.tier,
        planSource: result.meta.planSource,
        kept: result.meta.kept,
        asked: result.meta.asked,
        dropsByReason,
        verdictCounts,
        ...(Object.keys(rungsKept).length ? { rungsKept } : {}),
        ...(cascade
          ? { cascadeStats: { candidatesLaunched: cascade.candidatesLaunched, callsMade: cascade.callsMade, ...(cascade.answerChecks ? { answerChecks: cascade.answerChecks } : {}), ...(cascade.programSolves ? { programSolves: cascade.programSolves } : {}), ...(cascade.items.some((it) => it.placement) ? { placements: cascade.items.map((it) => it.placement ?? null) } : {}), ...(cascade.items.some((it) => it.seedId) ? { seedIds: cascade.items.map((it) => it.seedId ?? null) } : {}), ...(cascade.timings?.length ? { timings: cascade.timings } : {}) } }
          : {}),
        dollars: cost.total,
        ...(cost.unpriced.length ? { unpricedStages: cost.unpriced } : {}),
        wallTimeMs: Date.now() - start,
        problems: result.ok
          ? result.problems.map((p) => ({
              problem: p.problem,
              answer: p.answer,
              solution: p.solution,
              ...(p.solutionSketch ? { solutionSketch: p.solutionSketch } : {}),
            }))
          : undefined,
      };
    } catch (e) {
      // A thrown run still counts: it lands in the denominator as a failure.
      record = { ...base, ok: false, error: e instanceof Error ? e.message : String(e), wallTimeMs: Date.now() - start };
    }
    spent += record.dollars ?? 0;
    appendFileSync(outPath, JSON.stringify(record) + "\n");
    const partial = record.unpricedStages?.length ? "+" : "";
    console.log(
      `[${record.sampleId}] ok=${record.ok} kept=${record.kept ?? 0}/${record.asked ?? 0} $${(record.dollars ?? 0).toFixed(3)}${partial} ${record.wallTimeMs}ms`
    );
  }

  // A small worker pool: --concurrency sets in flight at once.
  const queue = [...todo];
  const worker = async () => {
    while (queue.length > 0) {
      if (args.maxDollars !== undefined && spent >= args.maxDollars) {
        stoppedForBudget = true;
        return;
      }
      const next = queue.shift()!;
      await runOne(next);
    }
  };
  await Promise.all(Array.from({ length: Math.min(args.concurrency, todo.length) }, worker));

  if (stoppedForBudget) {
    console.log(`\nStopped: priced spend reached --max-dollars ${args.maxDollars}. ${queue.length} samples not run; --resume continues.`);
  }
  console.log(`\nDone. Results: ${outPath}`);
  console.log(`Next: npm run eval:generation -- --rate ${args.out}   then   --gate ${args.out}`);
}

// --rate: walk individual problems interleaved across samples, never showing which
// pipeline or model wrote them, and record two separate judgements: is the answer
// correct, and how well calibrated is the problem (1-5).
async function rateRun(runPath: string, targetCount: number) {
  const full = path.join(process.cwd(), runPath);
  const records = readJsonl<RunRecord>(full);
  const ratingsFull = ratingsPathFor(full);
  const already = new Set(readJsonl<Rating>(ratingsFull).map(ratingKey));

  type Item = { sampleId: string; fixtureId: string; index: number; p: NonNullable<RunRecord["problems"]>[number] };
  const groups: Item[][] = records
    .filter((r) => r.ok && r.problems)
    .map((r) =>
      r
        .problems!.map((p, index) => ({ sampleId: recordSampleId(r), fixtureId: r.id, index, p }))
        .filter((it) => !already.has(`${it.sampleId}:${it.index}`))
    );
  const todo = interleave(groups);
  if (todo.length === 0) {
    console.log(already.size > 0 ? "Every problem in this run is already rated." : "No generated problems found in this run — did it complete with --yes?");
    return;
  }
  console.log(`${todo.length} unrated problems. Target: ${targetCount} this session ('q' stops, 's' skips).`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  let rated = 0;
  for (const item of todo) {
    if (rated >= targetCount) break;
    console.log(`\n=== problem ${rated + 1}/${targetCount} ===`);
    console.log(`PROBLEM:  ${item.p.problem}`);
    console.log(`ANSWER:   ${item.p.answer}`);
    console.log(`SOLUTION: ${item.p.solution || item.p.solutionSketch || "(none)"}`);

    let correct: boolean | null | undefined;
    let skipped = false;
    while (correct === undefined && !skipped) {
      const ans = (await ask("Is the stored answer correct? y / n / ? (can't tell), 's' skip, 'q' quit: ")).trim().toLowerCase();
      if (ans === "q") {
        rl.close();
        console.log(`\nStopped early. ${rated} rated this session, saved to ${ratingsFull}.`);
        return;
      }
      if (ans === "s") skipped = true;
      else if (ans === "y") correct = true;
      else if (ans === "n") correct = false;
      else if (ans === "?") correct = null;
    }
    if (skipped) {
      appendFileSync(
        ratingsFull,
        JSON.stringify({ id: item.fixtureId, sampleId: item.sampleId, index: item.index, rating: null, correct: null } satisfies Rating) + "\n"
      );
      continue;
    }
    let rating: number | null | undefined;
    while (rating === undefined) {
      const ans = (await ask("Calibration 1-5 (1 = far off the student's level, 5 = exactly right), 's' skip: ")).trim().toLowerCase();
      if (ans === "s") rating = null;
      else if (Number(ans) >= 1 && Number(ans) <= 5) rating = Number(ans);
    }
    appendFileSync(
      ratingsFull,
      JSON.stringify({ id: item.fixtureId, sampleId: item.sampleId, index: item.index, rating, correct: correct ?? null } satisfies Rating) + "\n"
    );
    rated++;
  }
  rl.close();
  const all = readJsonl<Rating>(ratingsFull);
  const scored = all.filter((r) => r.rating != null);
  const judged = all.filter((r) => r.correct != null);
  const wrong = judged.filter((r) => r.correct === false).length;
  console.log(
    `\nDone. ${scored.length} rated, average ${scored.length ? (scored.reduce((s, r) => s + (r.rating ?? 0), 0) / scored.length).toFixed(2) : "-"}/5; ` +
      `${wrong}/${judged.length} answers judged wrong.`
  );
}

function compareRuns(baselinePath: string, candidatePath: string) {
  const load = (p: string) => {
    const full = path.join(process.cwd(), p);
    if (!existsSync(full)) {
      console.error(`No run file at ${p}.`);
      process.exit(1);
    }
    return summarizeRun(readJsonl<RunRecord>(full), readJsonl<Rating>(ratingsPathFor(full)));
  };
  const base = load(baselinePath);
  const cand = load(candidatePath);
  const ids = [...new Set([...base.keys(), ...cand.keys()])].sort();
  const pct = (n: number | null | undefined) => (n == null ? "-" : `${Math.round(n * 100)}%`);
  const num = (n: number | null | undefined, d = 2) => (n == null ? "-" : n.toFixed(d));
  const secs = (n: number | null | undefined) => (n == null ? "-" : `${Math.round(n / 1000)}s`);
  console.log(["fixture".padEnd(18), "short".padEnd(12), "p95".padEnd(12), "$/set".padEnd(14), "wrong ans".padEnd(12), "rating"].join(" "));
  for (const id of ids) {
    const b = base.get(id);
    const c = cand.get(id);
    console.log(
      [
        id.padEnd(18),
        `${pct(b?.shortRate)}→${pct(c?.shortRate)}`.padEnd(12),
        `${secs(b?.p95WallMs)}→${secs(c?.p95WallMs)}`.padEnd(12),
        `${num(b?.dollarsPerSet)}→${num(c?.dollarsPerSet)}`.padEnd(14),
        `${pct(b?.wrongAnswerRate)}→${pct(c?.wrongAnswerRate)}`.padEnd(12),
        `${num(b?.avgRating)}→${num(c?.avgRating)}`,
      ].join(" ")
    );
  }
  const rungs: Record<string, number> = {};
  for (const r of cand.values()) for (const [k, v] of Object.entries(r.rungsKept)) rungs[k] = (rungs[k] ?? 0) + v;
  const totalKept = Object.values(rungs).reduce((s, n) => s + n, 0);
  if (totalKept > 0) {
    console.log("\nCandidate: kept problems by rung");
    for (const [k, v] of Object.entries(rungs).sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(40)} ${v} (${pct(v / totalKept)})`);
  }
}

function gateRun(runPath: string, minPerTier: number): number {
  const records = readJsonl<RunRecord>(path.join(process.cwd(), runPath));
  const { tiers, verdict } = gateByTier(records, { minPerTier, maxP95Ms: ROUTE_BUDGET_MS - 30_000 });
  for (const t of tiers) {
    console.log(
      `[${t.cohort}] n=${t.n} short=${t.short} (95% upper bound on the short-set rate: ${(t.upperBound * 100).toFixed(1)}%) p95=${
        t.p95WallMs == null ? "-" : `${Math.round(t.p95WallMs / 1000)}s`
      } → ${t.verdict}`
    );
  }
  console.log(`Gate: ${verdict}. (Quality and answer correctness come from --rate/--compare, not this gate.)`);
  return verdict === "pass" ? 0 : verdict === "fail" ? 1 : 2;
}

async function main() {
  let args: Args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    if (e instanceof ArgError) {
      console.error(`${e.message}\n\n${USAGE}`);
      process.exit(1);
    }
    throw e;
  }
  if (args.help) {
    console.log(USAGE);
    return;
  }
  if (args.compare) return compareRuns(args.compare[0], args.compare[1]);
  if (args.gate) process.exit(gateRun(args.gate, args.minPerTier));
  if (args.rate) return rateRun(args.rate, args.rateCount);
  await runEval(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
