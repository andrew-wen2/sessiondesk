// The generation pipeline eval — the instrument the whole plan runs on. Captures
// a baseline before any change, then compares a candidate run against it so
// "better and cheaper" is a number, not an impression.
//
// DEVIATION FROM THE ORIGINAL REVIEW FINDING, noted honestly: DX/Eng review said
// this script should take "no Prisma import at all." That's true for
// scripts/eval-solver.ts (ground-truth checking needs no live retrieval), but NOT
// fully achievable here without mocking: contest-anchored fixtures (AIME/AMC/F=ma)
// legitimately exercise generateProblems() → getAnchors() → Prisma, because
// retrieval quality IS part of what this eval measures. What the finding actually
// protects against — a fresh contributor needing a 30-60 min corpus-ingest
// bootstrap before the eval means anything — still holds for the non-contest
// fixtures (Spanish, AP Bio, etc.), which never touch the corpus at all
// (calibrationFor finds no competition → seedPool is always []). Committed
// fixtures avoid re-typing test cases, not avoiding the DB the system under test
// legitimately reads.
//
// Headline metric is NOT automated (Eng/CEO: agreement rate and kept/asked are
// both gameable by this plan's own guard-loosening in Stage 2) — it's Andrew's
// 1-5 rating on individual PROBLEMS via the separate --rate pass. Automated
// numbers here are diagnostics. --rate previously asked for one rating per
// 10-problem SET without ever printing the problems themselves — fixed: the run
// file now stores the actual problem/answer/solution, and --rate walks them one
// at a time, ~30 of them (the plan's target), not ~15 set-level guesses.
//
//   npx tsx scripts/eval-generation.ts --dry-run
//   npx tsx scripts/eval-generation.ts --yes --out runs/baseline.jsonl
//   npx tsx scripts/eval-generation.ts --rate runs/baseline.jsonl
//   npx tsx scripts/eval-generation.ts --rate runs/baseline.jsonl --count 30
//   npx tsx scripts/eval-generation.ts --compare runs/baseline.jsonl runs/candidate.jsonl

import Anthropic from "@anthropic-ai/sdk";
import { readFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { generateProblems } from "@/lib/generation/problems";
import { costForRun } from "@/lib/generation/pricing";
import type { Problem } from "@/lib/types";

type Fixture = { id: string; profile: string; topic: string; recentTopics: string[] };
type RunRecord = {
  id: string;
  ok: boolean;
  error?: string;
  tier?: string;
  planSource?: string;
  kept?: number;
  asked?: number;
  dropsByReason?: Record<string, number>;
  verdictCounts?: Record<string, number>;
  dollars?: number;
  wallTimeMs: number;
  // The actual generated content — without this, --rate has nothing to show.
  problems?: Pick<Problem, "problem" | "answer" | "solution" | "solutionSketch">[];
};
type Rating = { id: string; index: number; rating: number | null }; // rating: null = explicitly skipped

function parseArgs() {
  const argv = process.argv.slice(2);
  const flag = (name: string) => argv.includes(`--${name}`);
  const value = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i !== -1 ? argv[i + 1] : undefined;
  };
  const compareIdx = argv.indexOf("--compare");
  return {
    dryRun: flag("dry-run"),
    yes: flag("yes"),
    resume: flag("resume"),
    fixtures: value("fixtures") ?? "scripts/eval-fixtures/generation-fixtures.json",
    out: value("out") ?? "runs/generation-eval.jsonl",
    rate: value("rate"),
    rateCount: value("count") ? Number(value("count")) : 30, // the plan's "~30 problems" target
    compare: compareIdx !== -1 ? [argv[compareIdx + 1], argv[compareIdx + 2]] : undefined,
  };
}

function readJsonl<T>(p: string): T[] {
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as T);
}

function ratingsPathFor(runPath: string): string {
  return runPath.replace(/\.jsonl$/, ".ratings.jsonl");
}

async function runEval(args: ReturnType<typeof parseArgs>) {
  const fixturesPath = path.join(process.cwd(), args.fixtures);
  if (!existsSync(fixturesPath)) {
    console.error(`No fixture file at ${fixturesPath}.`);
    process.exit(1);
  }
  const fixtures: Fixture[] = JSON.parse(readFileSync(fixturesPath, "utf8"));

  console.log(`Fixtures: ${fixtures.length}.`);
  console.log(
    `Estimated cost: hard to pin exactly (fan-out + escalation vary), but budget ~$8-15 for a full run — verify against a single fixture first if unsure.`
  );

  if (args.dryRun) {
    console.log("--dry-run: no calls made. Fixture ids:", fixtures.map((f) => f.id).join(", "));
    return;
  }
  if (!args.yes) {
    console.error("This spends real Anthropic API credit. Re-run with --yes to proceed (or --dry-run to preview).");
    process.exit(1);
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is not set.");
    process.exit(1);
  }

  const outPath = path.join(process.cwd(), args.out);
  mkdirSync(path.dirname(outPath), { recursive: true });

  const already = args.resume ? new Set(readJsonl<RunRecord>(outPath).map((r) => r.id)) : new Set<string>();
  if (already.size > 0) console.log(`--resume: skipping ${already.size} already-completed fixtures.`);

  const client = new Anthropic({ maxRetries: 4, timeout: 300_000 });

  for (const f of fixtures) {
    if (already.has(f.id)) continue;
    const start = Date.now();
    const accountant = new UsageAccountant();
    let record: RunRecord;
    try {
      const result = await generateProblems({
        client,
        profile: f.profile,
        topic: f.topic,
        recentTopics: f.recentTopics,
        accountant,
      });
      const dropsByReason: Record<string, number> = {};
      for (const d of result.meta.drops) dropsByReason[d.reason] = (dropsByReason[d.reason] ?? 0) + 1;
      const verdictCounts: Record<string, number> = {};
      for (const v of result.meta.verdicts) verdictCounts[v] = (verdictCounts[v] ?? 0) + 1;
      record = {
        id: f.id,
        ok: result.ok,
        error: result.ok ? undefined : result.error,
        tier: result.meta.tier,
        planSource: result.meta.planSource,
        kept: result.meta.kept,
        asked: result.meta.asked,
        dropsByReason,
        verdictCounts,
        dollars: costForRun(result.meta.usage),
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
      record = { id: f.id, ok: false, error: e instanceof Error ? e.message : String(e), wallTimeMs: Date.now() - start };
    }
    appendFileSync(outPath, JSON.stringify(record) + "\n");
    console.log(`[${f.id}] ok=${record.ok} kept=${record.kept ?? 0}/${record.asked ?? 0} $${(record.dollars ?? 0).toFixed(3)} ${record.wallTimeMs}ms`);
  }
  console.log(`\nDone. Results: ${outPath}`);
  console.log(`Next: npx tsx scripts/eval-generation.ts --rate ${args.out}`);
}

// --rate: walk INDIVIDUAL problems (not whole sets) across the run, printing each
// one's statement/answer/solution, and collect a 1-5 calibration rating. Writes
// incrementally to a sibling .ratings.jsonl (one line per rated problem) so
// quitting at any point ('q') loses nothing and re-running skips what's already
// rated. Defaults to stopping after --count (30, the plan's target) real ratings,
// not counting skips — you can always run it again for more.
async function rateRun(runPath: string, targetCount: number) {
  const full = path.join(process.cwd(), runPath);
  const records = readJsonl<RunRecord>(full);
  const ratingsFull = ratingsPathFor(full);
  const already = new Set(readJsonl<Rating>(ratingsFull).map((r) => `${r.id}:${r.index}`));

  const todo: { fixtureId: string; index: number; p: NonNullable<RunRecord["problems"]>[number] }[] = [];
  for (const r of records) {
    if (!r.ok || !r.problems) continue;
    r.problems.forEach((p, i) => {
      if (!already.has(`${r.id}:${i}`)) todo.push({ fixtureId: r.id, index: i, p });
    });
  }
  if (todo.length === 0) {
    console.log(already.size > 0 ? "Every problem in this run is already rated." : "No generated problems found in this run — did it complete with --yes?");
    return;
  }
  console.log(`${todo.length} unrated problems available. Target: ${targetCount} ratings this session ('q' to stop early, 's' to skip one).`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((resolve) => rl.question(q, resolve));

  let rated = 0;
  for (const item of todo) {
    if (rated >= targetCount) break;
    console.log(`\n=== ${item.fixtureId} #${item.index + 1} (${rated}/${targetCount} rated so far) ===`);
    console.log(`PROBLEM:  ${item.p.problem}`);
    console.log(`ANSWER:   ${item.p.answer}`);
    console.log(`SOLUTION: ${item.p.solution || item.p.solutionSketch || "(none)"}`);

    let rating: number | null | undefined;
    while (rating === undefined) {
      const ans = (await ask("Rate 1-5 (1=wrong/too easy, 5=well-calibrated), 's' skip, 'q' quit: ")).trim().toLowerCase();
      if (ans === "q") {
        rl.close();
        console.log(`\nStopped early. ${rated} rated this session, saved to ${ratingsFull}.`);
        return;
      }
      if (ans === "s") {
        rating = null;
        break;
      }
      const n = Number(ans);
      if (n >= 1 && n <= 5) rating = n;
    }
    appendFileSync(ratingsFull, JSON.stringify({ id: item.fixtureId, index: item.index, rating } satisfies Rating) + "\n");
    if (rating !== null) rated++;
  }
  rl.close();

  const all = readJsonl<Rating>(ratingsFull).filter((r) => r.rating != null);
  const avg = all.length ? all.reduce((s, r) => s + (r.rating ?? 0), 0) / all.length : 0;
  console.log(`\nDone. ${ratingsFull} now has ${all.length} rated problems. Average: ${avg.toFixed(2)}/5.`);
  if (all.length < 30) console.log(`Fewer than 30 rated — run this again to continue where you left off.`);
}

function avgRatingByFixture(ratingsPath: string): Map<string, number> {
  const ratings = readJsonl<Rating>(ratingsPath).filter((r) => r.rating != null);
  const byFixture = new Map<string, number[]>();
  for (const r of ratings) {
    const arr = byFixture.get(r.id) ?? [];
    arr.push(r.rating as number);
    byFixture.set(r.id, arr);
  }
  const out = new Map<string, number>();
  for (const [id, arr] of byFixture) out.set(id, arr.reduce((s, n) => s + n, 0) / arr.length);
  return out;
}

// --compare: the actual deliverable. A delta table, not two JSON files someone
// has to diff by hand (DX D4). Ratings are per-fixture averages pulled from each
// run's sibling .ratings.jsonl — individual problems aren't 1:1 comparable across
// two separately-generated runs, but "this fixture's average quality" is.
function compareRuns(baselinePath: string, candidatePath: string) {
  const base = readJsonl<RunRecord>(path.join(process.cwd(), baselinePath));
  const cand = readJsonl<RunRecord>(path.join(process.cwd(), candidatePath));
  const baseRatings = avgRatingByFixture(ratingsPathFor(path.join(process.cwd(), baselinePath)));
  const candRatings = avgRatingByFixture(ratingsPathFor(path.join(process.cwd(), candidatePath)));
  const byId = <T extends { id: string }>(rows: T[]) => new Map(rows.map((r) => [r.id, r]));
  const baseById = byId(base);
  const candById = byId(cand);
  const ids = [...new Set([...baseById.keys(), ...candById.keys()])].sort();

  const fmt = (n: number | undefined) => (n == null ? "-" : n.toFixed(2));
  console.log("id".padEnd(20), "kept/asked (before -> after)".padEnd(30), "$ (before -> after)".padEnd(24), "avg rating (before -> after)");
  let baseDollars = 0;
  let candDollars = 0;
  let baseRatingSum = 0;
  let candRatingSum = 0;
  let ratingN = 0;
  for (const id of ids) {
    const b = baseById.get(id);
    const c = candById.get(id);
    const br = baseRatings.get(id);
    const cr = candRatings.get(id);
    baseDollars += b?.dollars ?? 0;
    candDollars += c?.dollars ?? 0;
    if (br != null && cr != null) {
      baseRatingSum += br;
      candRatingSum += cr;
      ratingN++;
    }
    console.log(
      id.padEnd(20),
      `${b?.kept ?? "-"}/${b?.asked ?? "-"} -> ${c?.kept ?? "-"}/${c?.asked ?? "-"}`.padEnd(30),
      `${fmt(b?.dollars)} -> ${fmt(c?.dollars)}`.padEnd(24),
      `${fmt(br)} -> ${fmt(cr)}`
    );
  }
  console.log("\n=== TOTALS ===");
  console.log(`Dollars: ${fmt(baseDollars)} -> ${fmt(candDollars)} (Δ ${fmt(candDollars - baseDollars)})`);
  if (ratingN > 0) {
    console.log(`Avg rating (${ratingN} fixtures rated on both): ${(baseRatingSum / ratingN).toFixed(2)} -> ${(candRatingSum / ratingN).toFixed(2)}`);
  } else {
    console.log("No fixtures rated on both runs — run --rate on each before comparing quality.");
  }
}

async function main() {
  const args = parseArgs();
  if (args.compare) {
    if (!args.compare[0] || !args.compare[1]) {
      console.error("--compare needs two run files: --compare baseline.jsonl candidate.jsonl");
      process.exit(1);
    }
    compareRuns(args.compare[0], args.compare[1]);
    return;
  }
  if (args.rate) {
    await rateRun(args.rate, args.rateCount);
    return;
  }
  await runEval(args);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
