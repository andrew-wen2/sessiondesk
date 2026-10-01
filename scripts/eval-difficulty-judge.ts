// Can a difficulty judge place a problem's difficulty at all? Tested on REAL, held-out
// contest problems with known human difficulty (E2H-AMC ratings), so no generation is
// involved: if a judge can't order real problems, it can't order generated ones either,
// and nothing downstream is built on it (docs/designs/generation-research.md, phase 0).
//
// Reports, per judge and mode:
//  - Spearman(judge score, human rating) on the test items — the headline;
//  - the same for problem NUMBER, the proxy we use today, as the bar to beat;
//  - AUC separating #6–10 from #11–15 test items (by number), next to the AUC the human
//    ratings themselves give (real problems only separate those bands at about 0.74).
// Caveat: real problems may be memorized; generated ones are not. A pass here is
// necessary, not sufficient.
//
// SPENDS REAL API CREDIT; needs --yes. Every placement runs at once.
//
//   npm run eval:difficulty-judge -- --yes --judges gemini:gemini-3.8-flash@low --modes pairwise,ladder --items 30 --out runs/judge-val.jsonl
//   (--source AIME --range 1-15 for another contest or the whole range)
import Anthropic from "@anthropic-ai/sdk";
import { writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { corpusDifficulty } from "@/lib/generation/corpus-difficulty";
import { geminiClient } from "@/lib/generation/gemini-call";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun } from "@/lib/generation/pricing";
import { parseRungSpec, type RungConfig } from "@/lib/generation/cascade/ladder";
import { openWeightCaller, type CallOpenWeight } from "@/lib/generation/cascade/verify-cheap";
import { anthropicToolCaller, geminiToolCaller, multiProviderCaller } from "@/lib/generation/cascade/tool-caller";
import { isJudgeAnchorId, placeProblem, spreadAnchors, type JudgeMode } from "@/lib/generation/cascade/difficulty-judge";
import { stableHash } from "@/lib/generation/cascade/targets";
import { aucOf, spearman } from "./eval-difficulty-judge-lib";

function parseArgs(argv: string[]) {
  const value = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i === -1 ? undefined : argv[i + 1];
  };
  return {
    yes: argv.includes("--yes"),
    judges: (value("judges") ?? "gemini:gemini-3.8-flash@low").split(",").map((s) => s.trim()).filter(Boolean),
    modes: (value("modes") ?? "pairwise,ladder").split(",").map((s) => s.trim()) as JudgeMode[],
    items: Number(value("items") ?? "30"),
    anchors: Number(value("anchors") ?? "8"),
    source: value("source") ?? "AMC10",
    // Test-item problem numbers, "lo-hi" (default 3-20, the band the judge is used on).
    range: (value("range") ?? "3-20").split("-").map(Number) as [number, number],
    out: value("out") ?? "runs/difficulty-judge.jsonl",
  };
}

export function callerFromEnv(openWeightTimeoutMs?: number): CallOpenWeight {
  const baseUrl = process.env.OPENWEIGHT_BASE_URL ?? "";
  const apiKey = process.env.OPENWEIGHT_API_KEY ?? "";
  return multiProviderCaller({
    ...(process.env.ANTHROPIC_API_KEY ? { anthropic: anthropicToolCaller(new Anthropic({ maxRetries: 4 })) } : {}),
    ...(process.env.GOOGLE_API_KEY ? { gemini: geminiToolCaller(geminiClient()) } : {}),
    ...(baseUrl && apiKey ? { openweight: openWeightCaller(baseUrl, apiKey, openWeightTimeoutMs) } : {}),
  });
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  if (!a.yes) {
    console.error("eval:difficulty-judge makes real model calls. Re-run with --yes.");
    process.exit(1);
  }
  const prisma = new PrismaClient();
  const rows = await prisma.referenceProblem.findMany({
    where: { source: a.source, number: { not: null } },
    select: { id: true, number: true, statement: true, year: true },
    orderBy: { id: "asc" },
  });
  await prisma.$disconnect();
  const rated = rows
    .map((r) => ({ ...r, rating: corpusDifficulty(r.id)?.rating }))
    .filter((r): r is typeof r & { rating: number } => typeof r.rating === "number");
  // Deterministic split: a third of the pool can be anchors, the rest test items.
  const anchorPool = rated.filter((r) => isJudgeAnchorId(r.id));
  const testPool = rated.filter((r) => !isJudgeAnchorId(r.id) && r.number! >= a.range[0] && r.number! <= a.range[1]);
  const anchors = spreadAnchors(anchorPool, a.anchors).map((r) => ({ statement: r.statement, rating: r.rating, label: `#${r.number} ${r.year}` }));
  // Stratified by number so both bands are well represented.
  const items = [...testPool].sort((x, y) => stableHash(`t${x.id}`) - stableHash(`t${y.id}`)).sort((x, y) => x.number! - y.number!);
  const step = Math.max(1, items.length / a.items);
  const test = Array.from({ length: Math.min(a.items, items.length) }, (_, i) => items[Math.floor(i * step)]);
  console.log(`${a.source}: ${rated.length} rated; anchors ${anchors.map((x) => `${x.label}=${x.rating.toFixed(3)}`).join(", ")}; ${test.length} test items (#${test[0].number}–#${test.at(-1)!.number})`);

  const call = callerFromEnv();
  const level = a.source.replace(/(\D+)(\d+)/, "$1 $2");
  const records: object[] = [];
  const configs = a.judges.flatMap((spec) => a.modes.map((mode) => ({ spec, mode, rung: parseRungSpec("easy", spec) as RungConfig })));
  await Promise.all(
    configs.map(async ({ spec, mode, rung }) => {
      const accountant = new UsageAccountant();
      const start = Date.now();
      const placed = await Promise.all(
        test.map(async (t) => ({
          t,
          p: await placeProblem({
            problem: t.statement,
            anchors,
            mode,
            level,
            call,
            rung,
            signal: AbortSignal.timeout(180_000),
            recordUsage: (u) => accountant.recordFor("verification", rung.provider, rung.model, u),
          }),
        }))
      );
      const ok = placed.filter((x) => x.p !== null);
      const humans = ok.map((x) => x.t.rating);
      const judge = ok.map((x) => x.p!.score);
      const numbers = ok.map((x) => x.t.number!);
      const lo = ok.filter((x) => x.t.number! >= 6 && x.t.number! <= 10);
      const hi = ok.filter((x) => x.t.number! >= 11 && x.t.number! <= 15);
      const summary = {
        judge: spec,
        mode,
        placed: `${ok.length}/${test.length}`,
        spearmanJudgeVsHuman: spearman(judge, humans),
        spearmanNumberVsHuman: spearman(numbers, humans),
        aucJudge_6to10_vs_11to15: aucOf(lo.map((x) => x.p!.score), hi.map((x) => x.p!.score)),
        aucHuman_6to10_vs_11to15: aucOf(lo.map((x) => x.t.rating), hi.map((x) => x.t.rating)),
        dollars: costForRun(accountant.perModelUsage()).total,
        seconds: Math.round((Date.now() - start) / 1000),
      };
      records.push({ ...summary, source: a.source, items: ok.map((x) => ({ number: x.t.number, human: x.t.rating, score: x.p!.score, rating: x.p!.rating })) });
      console.log(
        `\n[${spec} ${mode}] placed ${summary.placed} in ${summary.seconds}s, $${summary.dollars.toFixed(3)}` +
          `\n  Spearman vs human rating: judge ${summary.spearmanJudgeVsHuman.toFixed(2)}  (problem number: ${summary.spearmanNumberVsHuman.toFixed(2)})` +
          `\n  AUC #6–10 vs #11–15: judge ${summary.aucJudge_6to10_vs_11to15.toFixed(2)}  (human ratings: ${summary.aucHuman_6to10_vs_11to15.toFixed(2)}; n=${lo.length}+${hi.length})`
      );
    })
  );
  writeFileSync(a.out, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  console.log(`\nWrote ${a.out}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[eval:difficulty-judge]", e);
    process.exitCode = 1;
  });
}
