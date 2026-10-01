// Does the well-posedness screening catch broken problems without flagging good ones?
// (docs/designs/generation-research.md, phase 4.)
//   - "real": well-posed AMC problems from the corpus — every flag is a false flag.
//   - "broken": the same problems rewritten by a cheap model to drop one needed given or
//     to make two conditions contradict (MathTrap-style). The rewrite isn't verified, so
//     a few "broken" items may still be answerable; detection is a lower bound.
// Checks: the old one-question validity prompt (baseline, inlined below), the staged
// prompt (buildValidityPrompt), and the cheap solvers' assumption veto.
//
// SPENDS REAL API CREDIT (cheap); needs --yes.
//   npm run eval:validity -- --yes --items 40
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { buildValidityPrompt, ANSWER_FORMAT_RULES } from "@/lib/generation-prompt";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { parseRungSpec } from "@/lib/generation/cascade/ladder";
import { solveBlind, type ToolSpec } from "@/lib/generation/cascade/verify-cheap";
import { stableHash } from "@/lib/generation/cascade/targets";
import { callerFromEnv } from "./eval-difficulty-judge";

const OLD_VALIDITY = (problem: string) => ({
  system: `You review a Competition math practice problem before a student sees it. Decide only whether it is WELL-POSED, not how hard it is.
A problem is well-posed when:
- every quantity needed to answer it is given (nothing missing or left to guess);
- its conditions are consistent, so an answer actually exists (e.g. counts come out whole, equations have the real solutions the problem assumes);
- the asked quantity is uniquely determined (not a range, and every case is accounted for);
- it is self-contained text: no answer choices, no reference to a figure that isn't described.
Work it through as far as you need to decide, but do not write up a solution. The expected answer format is: ${ANSWER_FORMAT_RULES.numeric}
Call emit_validity with "wellPosed" (true or false) and "reason" (one sentence; for false, what exactly is wrong).`,
  user: `Problem:\n${problem}`,
});
const OLD_TOOL: ToolSpec = {
  name: "emit_validity",
  description: "Report whether the problem is well-posed.",
  parameters: { type: "object", properties: { wellPosed: { type: "boolean" }, reason: { type: "string" } }, required: ["wellPosed", "reason"] },
};
const NEW_TOOL: ToolSpec = {
  name: "emit_validity",
  description: "Report whether the problem is well-posed, stage by stage.",
  parameters: {
    type: "object",
    properties: {
      conditions: { type: "array", items: { type: "string" } },
      missing: { type: "string" },
      contradiction: { type: "string" },
      notUnique: { type: "string" },
      selfContained: { type: "boolean" },
      wellPosed: { type: "boolean" },
      reason: { type: "string" },
    },
    required: ["conditions", "missing", "contradiction", "notUnique", "selfContained", "wellPosed", "reason"],
  },
};
const BREAK_TOOL: ToolSpec = {
  name: "emit_broken",
  description: "Return the rewritten, broken problem.",
  parameters: { type: "object", properties: { problem: { type: "string" } }, required: ["problem"] },
};
const breakPrompt = (problem: string, how: "missing" | "contradiction") => ({
  system:
    how === "missing"
      ? "Rewrite the problem so it can NO LONGER be answered: delete exactly one given fact or number that the answer depends on. Change nothing else, and keep it reading naturally. Call emit_broken."
      : "Rewrite the problem so its conditions CONTRADICT each other and no answer exists: change exactly one given number or condition. Change nothing else, and keep it reading naturally. Call emit_broken.",
  user: problem,
});

function parseArgs(argv: string[]) {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    yes: argv.includes("--yes"),
    items: Number(value("items") ?? "40"),
    validity: value("validity") ?? "openweight:zai-org/GLM-5.3@low",
    solvers: (value("solvers") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash@low,openweight:zai-org/GLM-5.3@low").split(","),
    breaker: value("breaker") ?? "openweight:deepseek-ai/DeepSeek-V4.1-Flash@off",
    out: value("out") ?? "runs/validity.jsonl",
  };
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.yes) {
    console.error("eval:validity makes real model calls. Re-run with --yes.");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const rows = await prisma.referenceProblem.findMany({
    where: { source: { in: ["AMC10", "AMC12"] }, answer: { not: null }, number: { lte: 15 } },
    select: { id: true, statement: true },
  });
  await prisma.$disconnect();
  const real = rows.sort((x, y) => stableHash(`v${x.id}`) - stableHash(`v${y.id}`)).slice(0, a.items);
  const call = callerFromEnv();
  const accountant = new UsageAccountant();
  const rec = (r: { provider: string; model: string }) => (u: Parameters<Parameters<typeof solveBlind>[5]>[0]) => accountant.recordFor("verification", r.provider, r.model, u);
  const signal = () => AbortSignal.timeout(180_000);

  const breaker = parseRungSpec("easy", a.breaker);
  const broken = (
    await Promise.all(
      real.map(async (r, i) => {
        const res = await call(breaker, breakPrompt(r.statement, i % 2 ? "missing" : "contradiction"), BREAK_TOOL, signal(), rec(breaker));
        const p = res.ok ? (res.args as { problem?: unknown }).problem : null;
        return typeof p === "string" && p.trim() && p.trim() !== r.statement.trim() ? { id: r.id, statement: p, how: i % 2 ? "missing" : "contradiction" } : null;
      })
    )
  ).filter((x): x is { id: string; statement: string; how: string } => x !== null);
  console.log(`${real.length} real problems, ${broken.length} broken variants`);

  const validity = parseRungSpec("easy", a.validity);
  const solvers = a.solvers.map((s) => parseRungSpec("easy", s.trim()));
  const plan = { domain: "Competition math", rubric: "", answerFormat: "numeric" as const };
  const judge = async (statement: string) => {
    const [oldV, newV, ...solves] = await Promise.all([
      call(validity, OLD_VALIDITY(statement), OLD_TOOL, signal(), rec(validity)),
      call(validity, buildValidityPrompt({ problem: statement, domain: "Competition math", answerFormat: "numeric" }), NEW_TOOL, signal(), rec(validity)),
      ...solvers.map((s) => solveBlind(call, s, statement, plan, signal(), rec(s), true)),
    ]);
    const flag = (r: typeof oldV) => (r.ok ? (r.args as { wellPosed?: unknown }).wellPosed === false : null);
    return {
      old: flag(oldV),
      staged: flag(newV),
      veto: solves.some((o) => o.kind === "ambiguous"),
      vetoNotes: solves.filter((o) => o.kind === "ambiguous").map((o) => (o as { note: string }).note),
    };
  };
  const [realRes, brokenRes] = await Promise.all([Promise.all(real.map((r) => judge(r.statement))), Promise.all(broken.map((b) => judge(b.statement)))]);
  const rate = (xs: (boolean | null)[]) => {
    const known = xs.filter((x): x is boolean => x !== null);
    return `${known.filter(Boolean).length}/${known.length}`;
  };
  console.log(`\nFlagged (real = false flags; broken = detections):`);
  for (const k of ["old", "staged", "veto"] as const) console.log(`  ${k.padEnd(7)} real ${rate(realRes.map((r) => r[k]))}   broken ${rate(brokenRes.map((r) => r[k]))}`);
  const anyNew = (r: (typeof realRes)[number]) => r.staged === true || r.veto;
  const anyOld = (r: (typeof realRes)[number]) => r.old === true;
  console.log(`  current (old validity only)      real ${realRes.filter(anyOld).length}/${realRes.length}   broken ${brokenRes.filter(anyOld).length}/${brokenRes.length}`);
  console.log(`  new (staged validity OR veto)    real ${realRes.filter(anyNew).length}/${realRes.length}   broken ${brokenRes.filter(anyNew).length}/${brokenRes.length}`);
  console.log(`  cost $${costForRun(accountant.perModelUsage()).total.toFixed(3)}`);
  for (const r of realRes.filter((x) => x.veto).slice(0, 5)) console.log(`  real-problem veto: ${r.vetoNotes.join(" | ").slice(0, 160)}`);
  writeFileSync(a.out, JSON.stringify({ real: realRes, broken: brokenRes.map((r, i) => ({ ...r, how: broken[i].how })) }) + "\n");
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[eval:validity]", e);
    process.exitCode = 1;
  });
}
