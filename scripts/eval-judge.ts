// Independent correctness check for SHIPPED problems: Opus solves each problem an
// eval:generation run kept, blind, and scores the stored answer (rules: eval-judge-lib).
// No human rating and no writer involvement; the pipeline's own verification never
// sees these solves. Every problem is judged at once.
//
// SPENDS REAL API CREDIT (Anthropic, roughly $0.02-0.08 per problem); needs --yes.
//
//   npm run eval:judge -- --in runs/e2e.jsonl --out runs/judge.jsonl --yes
//   npm run eval:judge -- --summary runs/judge.jsonl
import Anthropic from "@anthropic-ai/sdk";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { RUBRICS } from "@/lib/generation-prompt";
import type { GenerationPlan, Tier } from "@/lib/generation/plan";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import type { SolveObs } from "@/lib/generation/cascade/verify-cheap";
import { opusSolve } from "./eval-accuracy-shared";
import { judgeKey, summarizeJudge, type JudgeVerdict } from "./eval-judge-lib";

type Args = { input?: string; out: string; yes: boolean; summary?: string; model: string; competition: string };
function parseArgs(argv: string[]): Args {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    input: value("in"),
    out: value("out") ?? "runs/judge.jsonl",
    yes: argv.includes("--yes"),
    summary: value("summary"),
    model: value("judge-model") ?? "claude-opus-5-5",
    competition: value("competition") ?? "AMC10",
  };
}

type Shipped = { id: string; sampleId: string; tier?: Tier; problems?: { problem: string; answer: string }[] };
type Row = { id: string; problem: string; answer: string; opus: SolveObs[]; verdict: JudgeVerdict; basis: string; dollars: number };

const readJsonl = <T>(f: string): T[] => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as T) : []);

function printSummary(rows: Row[]) {
  const s = summarizeJudge(rows.map((r) => r.verdict));
  const pct = (x: number | null) => (x == null ? "—" : `${(x * 100).toFixed(1)}%`);
  console.log(
    `\n${rows.length} shipped problems judged by Opus: correct ${s.correct}, wrong ${s.wrong}, ill-posed ${s.illPosed}, unresolved ${s.unresolved}` +
      `\nbad-key rate ${pct(s.badRate)} (${s.wrong + s.illPosed}/${s.judged}), 95% upper bound ${pct(s.upperBound)} | $${rows.reduce((n, r) => n + r.dollars, 0).toFixed(2)}`
  );
  for (const r of rows.filter((x) => x.verdict !== "correct")) {
    const got = r.opus.map((o) => (o.kind === "answer" ? o.answer : o.kind)).join(" / ");
    console.log(`\n[${r.verdict}] ${r.id}: key ${r.answer}, Opus ${got}\n  ${r.problem.replace(/\n+/g, " ").slice(0, 300)}`);
  }
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.summary) return printSummary(readJsonl<Row>(a.summary));
  if (!a.input) throw new Error("--in <eval:generation output> is required");
  const shipped = readJsonl<Shipped>(a.input).flatMap((r) =>
    (r.problems ?? []).map((p, i) => ({ id: `${r.sampleId}#${i}`, tier: r.tier ?? ("easy" as Tier), ...p }))
  );
  const done = new Set(readJsonl<Row>(a.out).map((r) => r.id));
  const todo = shipped.filter((p) => !done.has(p.id));
  console.log(`${shipped.length} shipped problems in ${a.input}; ${todo.length} to judge with ${a.model}.`);
  if (!a.yes) {
    console.error("eval:judge makes real Opus calls. Re-run with --yes.");
    process.exit(1);
  }
  const rubric = RUBRICS[a.competition] ?? "";
  const plan = { domain: `Competition math (${a.competition})`, rubric, answerFormat: "numeric" } as GenerationPlan;
  const client = new Anthropic({ maxRetries: 4 });
  let finished = 0;
  await Promise.all(
    todo.map(async (p) => {
      const accountant = new UsageAccountant();
      const opus: SolveObs[] = [];
      let step = judgeKey(p.answer, plan.answerFormat, opus);
      while ("need" in step) {
        opus.push(await opusSolve(client, a.model, { problem: p.problem, plan, tier: p.tier, accountant }));
        step = judgeKey(p.answer, plan.answerFormat, opus);
      }
      const row: Row = { id: p.id, problem: p.problem, answer: p.answer, opus, verdict: step.verdict, basis: step.basis, dollars: costForRun(accountant.perModelUsage()).total };
      appendFileSync(a.out, JSON.stringify(row) + "\n");
      console.log(`[${++finished}/${todo.length}] ${p.id}: ${step.verdict} (key ${p.answer})`);
    })
  );
  printSummary(readJsonl<Row>(a.out));
}

main().catch((e) => {
  console.error("[eval:judge]", e);
  process.exitCode = 1;
});
