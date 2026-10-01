// How often does the blind program solver compute a real problem's answer, and how
// often is a program it produces WRONG? Real AMC/AIME problems with known answers, so
// no generation. A wrong value on a correct problem is a false rejection once the
// program's vote counts, so "wrong among answered" is the number that matters; an
// abstention costs nothing.
//
// SPENDS REAL API CREDIT; needs --yes. Every call runs at once.
//
//   npm run eval:program-solver -- --yes --models openweight:deepseek-ai/DeepSeek-V4.1-Flash@off,gemini:gemini-3.8-flash@low --items 80
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { evaluateAnswer } from "@/lib/generation/answer-match";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { parseRungSpec } from "@/lib/generation/cascade/ladder";
import { programSolve } from "@/lib/generation/cascade/program-solver";
import { stableHash } from "@/lib/generation/cascade/targets";
import { callerFromEnv } from "./eval-difficulty-judge";

function parseArgs(argv: string[]) {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    yes: argv.includes("--yes"),
    models: (value("models") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash@off").split(",").map((s) => s.trim()),
    items: Number(value("items") ?? "80"),
    sources: (value("sources") ?? "AMC10,AMC12").split(","),
    maxNumber: Number(value("max-number") ?? "15"),
    out: value("out") ?? "runs/program-solver.jsonl",
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.yes) {
    console.error("eval:program-solver makes real model calls. Re-run with --yes.");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const rows = await prisma.referenceProblem.findMany({
    where: { source: { in: a.sources }, answer: { not: null }, number: { lte: a.maxNumber } },
    select: { id: true, source: true, number: true, statement: true, answer: true },
  });
  await prisma.$disconnect();
  const items = rows
    .filter((r) => evaluateAnswer(r.answer!) !== null)
    .sort((x, y) => stableHash(x.id) - stableHash(y.id))
    .slice(0, a.items);
  console.log(`${items.length} problems from ${a.sources.join("/")} #1–${a.maxNumber} with numeric answers`);
  const call = callerFromEnv();
  const out: object[] = [];
  await Promise.all(
    a.models.map(async (spec) => {
      const rung = parseRungSpec("easy", spec);
      const accountant = new UsageAccountant();
      const start = Date.now();
      const results = await Promise.all(
        items.map(async (it) => {
          const r = await programSolve({
            call,
            rung,
            problem: it.statement,
            domain: "competition math",
            signal: AbortSignal.timeout(120_000),
            recordUsage: (u) => accountant.recordFor("solve", rung.provider, rung.model, u),
          });
          const truth = evaluateAnswer(it.answer!)!;
          const correct = r.kind === "value" ? Math.abs(r.value - truth) <= 1e-6 * Math.max(1, Math.abs(truth)) : null;
          return { id: it.id, source: it.source, number: it.number, answer: it.answer, ...r, correct };
        })
      );
      const answered = results.filter((r) => r.kind === "value");
      const wrong = answered.filter((r) => r.correct === false);
      const reasons: Record<string, number> = {};
      for (const r of results) if (r.kind === "abstain") reasons[r.reason.split(":")[0]] = (reasons[r.reason.split(":")[0]] ?? 0) + 1;
      console.log(
        `\n[${spec}] ${Math.round((Date.now() - start) / 1000)}s $${costForRun(accountant.perModelUsage()).total.toFixed(3)}` +
          `\n  computed a value: ${answered.length}/${results.length}; wrong among those: ${wrong.length} (${answered.length ? ((100 * wrong.length) / answered.length).toFixed(0) : "-"}%)` +
          `\n  abstained: ${JSON.stringify(reasons)}`
      );
      for (const w of wrong.slice(0, 4)) console.log(`  wrong: ${w.source} #${w.number} truth=${w.answer} got=${(w as { value: number }).value}`);
      out.push({ model: spec, results });
    })
  );
  writeFileSync(a.out, out.map((o) => JSON.stringify(o)).join("\n") + "\n");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[eval:program-solver]", e);
    process.exitCode = 1;
  });
}
