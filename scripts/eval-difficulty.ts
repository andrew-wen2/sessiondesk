// Difficulty calibration: how hard do generated problems play, compared with real
// contest problems of known position? Scoring and the curve: eval-difficulty-lib.ts.
//
// A weak solver from a different family than the writer answers --per-number real
// corpus problems at every position (verified answers, read-only from the corpus),
// --trials times each, then the generated problems the same way. Real accuracy by
// band is the curve; generated accuracy placed on it is the position they play like.
// Only generated problems whose solvers agreed (and, for a backward-built problem, the
// writer too) are used, with that agreed answer as the key.
//
// SPENDS REAL API CREDIT (open-weight only, no Opus); refuses to run without --yes.
//
//   npm run eval:difficulty -- --dry-run
//   npm run eval:difficulty -- --yes --generated runs/ab-lean.jsonl --out runs/difficulty-lean.jsonl
//   npm run eval:difficulty -- --summary runs/difficulty-lean.jsonl
//   npm run eval:difficulty -- --summary runs/difficulty-lean.jsonl --expect-band 1-15   (gate: exit 1 if off-band)
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { parseLadder } from "@/lib/generation/cascade/ladder";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { stripChoices } from "@/lib/generation-prompt";
import type { GenerationPlan } from "@/lib/generation/plan";
import { prisma } from "@/lib/prisma";
import { answerMatch, equivKey } from "./eval-accuracy-lib";
import { equivalent, openWeightSolve } from "./eval-accuracy-shared";
import type { SolveFirstRecord } from "./eval-solve-first-lib";
import { accuracy, bandCurve, curveSpread, gateVerdict, pickPerNumber, placeOnCurve, type DifficultyItem, type Trial } from "./eval-difficulty-lib";

type Args = {
  yes: boolean;
  dryRun: boolean;
  generated: string;
  solver: string;
  competition: string;
  lo: number;
  hi: number;
  perNumber: number;
  trials: number;
  band: number;
  out: string;
  summary?: string;
  expectBand?: [number, number]; // gate: fail unless the generated set plays inside this range
};

function parseArgs(argv: string[]): Args {
  const value = (name: string) => {
    const i = argv.indexOf(`--${name}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  const int = (name: string, fallback: number) => {
    const n = value(name) === undefined ? fallback : Number(value(name));
    if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive integer`);
    return n;
  };
  return {
    yes: argv.includes("--yes"),
    dryRun: argv.includes("--dry-run"),
    generated: value("generated") ?? "runs/ab-lean.jsonl",
    solver: value("solver") ?? "openweight:zai-org/GLM-5.3-Flash",
    competition: value("competition") ?? "AMC10",
    lo: int("from", 1),
    hi: int("to", 25),
    perNumber: int("per-number", 3),
    trials: int("trials", 3),
    band: int("band", 5),
    out: value("out") ?? "runs/difficulty.jsonl",
    summary: value("summary"),
    expectBand: (() => {
      const v = value("expect-band");
      if (v === undefined) return undefined;
      const m = /^(\d+)-(\d+)$/.exec(v);
      if (!m) throw new Error("--expect-band must look like 1-15");
      return [Number(m[1]), Number(m[2])] as [number, number];
    })(),
  };
}

type Job = { id: string; kind: DifficultyItem["kind"]; number: number | null; problem: string; answer: string };
type ResultRow = DifficultyItem & { answers: string[]; dollars: number };

async function runJob(a: Args, job: Job, plan: GenerationPlan): Promise<ResultRow> {
  const rung = parseLadder("easy", `${a.solver},anthropic:claude-opus-5-5`)[0];
  const accountant = new UsageAccountant();
  const equiv: { [k: string]: boolean } = {};
  const obs = await Promise.all(
    Array.from({ length: a.trials }, () => openWeightSolve(rung, { problem: job.problem, plan, tier: "easy", accountant }))
  );
  const trials: Trial[] = [];
  for (const o of obs) {
    if (o.kind === "error") trials.push({ error: o.message });
    else if (o.kind === "ambiguous") trials.push({ correct: false });
    else {
      let m = answerMatch(o.answer, job.answer, "numeric", equiv);
      if (m === undefined) {
        equiv[equivKey(o.answer, job.answer)] = await equivalent(o.answer, job.answer, job.problem, accountant);
        m = answerMatch(o.answer, job.answer, "numeric", equiv);
      }
      trials.push({ correct: m === true });
    }
  }
  return {
    id: job.id,
    kind: job.kind,
    number: job.number,
    trials,
    answers: obs.map((o) => (o.kind === "answer" ? o.answer : o.kind)),
    dollars: costForRun(accountant.perModelUsage()).total,
  };
}

const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(0)}%`);

// Returns whether the --expect-band gate passed (true when no gate was asked for).
function printSummary(a: Args, records: ResultRow[]): boolean {
  const real = records.filter((r) => r.kind === "real");
  const gen = records.filter((r) => r.kind === "generated");
  const curve = bandCurve(real, a.band, a.lo, a.hi);
  console.log(`\nWeak solver ${a.solver}, ${a.trials} trials per problem.\n\nReal ${a.competition} problems (the curve):`);
  for (const p of curve) console.log(`  #${p.lo}-${p.hi}: ${pct(p.rate)} (${p.correct}/${p.answered})`);
  const spread = curveSpread(curve);
  console.log(`  spread ${pct(spread)} between the easiest and hardest band`);
  if (spread != null && spread < 0.25) console.log("  WARNING: the curve is too flat to tell positions apart; use a weaker solver.");
  const g = accuracy(gen);
  console.log(`\nGenerated problems: ${pct(g.rate)} (${g.correct}/${g.answered}) across ${gen.length} problems`);
  const place = g.rate == null ? null : placeOnCurve(curve, g.rate);
  if (place)
    console.log(
      place.kind === "at"
        ? `  plays like ${a.competition} #${place.number.toFixed(1)}`
        : place.kind === "easier-than"
          ? `  plays EASIER than the easiest band (#${a.lo}-${a.lo + a.band - 1})`
          : `  plays HARDER than the hardest band`
    );
  const perProblem = gen.map((r) => accuracy([r]).rate).filter((x): x is number => x != null);
  const buckets = [0, 1, 2, 3].map((k) => perProblem.filter((x) => Math.round(x * a.trials) === k).length);
  if (a.trials === 3) console.log(`  per problem, trials solved 0/1/2/3: ${buckets.join(" / ")}`);
  const errs = records.flatMap((r) => r.trials).filter((t) => "error" in t).length;
  console.log(`\n${errs} trial errors (excluded) | ${records.reduce((n, r) => n + r.dollars, 0).toFixed(3)}`);
  if (!a.expectBand) return true;
  const verdict = gateVerdict(place, spread, a.expectBand);
  console.log(`\nGATE ${verdict.pass ? "PASS" : "FAIL"}: ${verdict.reason}`);
  return verdict.pass;
}

function readRecords(file: string): ResultRow[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as ResultRow);
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  parseLadder("easy", `${a.solver},anthropic:claude-opus-5-5`); // validates the spec
  if (a.summary) {
    if (!printSummary(a, readRecords(a.summary))) process.exitCode = 1;
    return;
  }

  const plans = JSON.parse(readFileSync(`${a.generated}.plans.json`, "utf8")) as { [id: string]: GenerationPlan };
  const plan = Object.values(plans).find((p) => p.competition === a.competition && p.tier === "easy") ?? Object.values(plans)[0];
  const generated = (readFileSync(a.generated, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) as SolveFirstRecord[]).filter(
    (r) => r.write.ok && r.compared?.selfCross && r.self?.kind === "answer" && (r.write.intended === undefined || r.compared.intendedSelf)
  );
  const genJobs: Job[] = generated.map((r) => ({
    id: `gen|${r.index}`,
    kind: "generated",
    number: null,
    problem: r.write.ok ? r.write.problem : "",
    // The writer's intended answer when it built the problem backward, else the
    // answer both blind solvers agreed on.
    answer: r.write.ok && r.write.intended !== undefined ? r.write.intended : r.self?.kind === "answer" ? r.self.answer : "",
  }));

  const rows = await prisma.referenceProblem.findMany({
    where: { source: a.competition, number: { gte: a.lo, lte: a.hi }, answer: { not: null } },
    select: { id: true, number: true, statement: true, answer: true },
  });
  const realJobs: Job[] = pickPerNumber(rows, a.perNumber, a.lo, a.hi).map((r) => ({
    id: `real|${r.id}`,
    kind: "real",
    number: r.number,
    problem: stripChoices(r.statement),
    answer: r.answer!,
  }));

  const done = new Set(readRecords(a.out).map((r) => r.id));
  const jobs = [...realJobs, ...genJobs].filter((j) => !done.has(j.id));
  console.log(
    `Solver ${a.solver} (thinking=${parseLadder("easy", `${a.solver},anthropic:claude-opus-5-5`)[0].thinking}), ${a.trials} trials each.\n` +
      `${realJobs.length} real ${a.competition} #${a.lo}-${a.hi} + ${genJobs.length} generated (from ${a.generated}); ${jobs.length} to run, ${(realJobs.length + genJobs.length) * a.trials} solves in all.`
  );
  if (a.dryRun) return;
  if (!a.yes) {
    console.error("eval:difficulty makes real model calls. Re-run with --yes to spend.");
    process.exit(1);
  }
  let finished = 0;
  await Promise.all(
    jobs.map(async (job) => {
      const rec = await runJob(a, job, plan);
      appendFileSync(a.out, JSON.stringify(rec) + "\n");
      finished++;
      const ok = rec.trials.filter((t) => "correct" in t && t.correct).length;
      console.log(`[${finished}/${jobs.length}] ${rec.kind === "real" ? `real #${rec.number}` : `generated ${rec.id.split("|")[1]}`}: ${ok}/${a.trials} (key ${job.answer}; got ${rec.answers.join(", ")})`);
    })
  );
  if (!printSummary(a, readRecords(a.out))) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error("[eval:difficulty]", e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
