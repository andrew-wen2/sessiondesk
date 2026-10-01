// One real generation through the configured pipeline, for a quick end-to-end check.
// SPENDS REAL API CREDIT — refuses to run without --yes. Needs DATABASE_URL (corpus
// anchors) and the keys `npm run gen:check` lists. Writes nothing to the database.
//
//   npm run gen:smoke -- --yes [--tier easy|mid|hard] [--pipeline legacy|cascade]
import Anthropic from "@anthropic-ai/sdk";
import { generateProblems } from "@/lib/generation/problems";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { costForRun, formatRunCost } from "@/lib/generation/pricing";
import { checkGenerationConfig } from "@/lib/generation/check-config";
import { prisma } from "@/lib/prisma";

const PROFILES = {
  easy: "AMC 10, problems 1-15",
  mid: "AMC 10, problems 16-25",
  hard: "AIME, problems 10-15",
} as const;

async function main() {
  const argv = process.argv.slice(2);
  const known = new Set(["--yes", "--tier", "--pipeline"]);
  const bad = argv.find((a) => a.startsWith("--") && !known.has(a));
  const val = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const tier = (val("tier") ?? "mid") as keyof typeof PROFILES;
  const pipeline = val("pipeline");
  if (bad || !(tier in PROFILES) || (pipeline && pipeline !== "legacy" && pipeline !== "cascade")) {
    console.error("Usage: npm run gen:smoke -- --yes [--tier easy|mid|hard] [--pipeline legacy|cascade]");
    process.exit(1);
  }
  if (pipeline) process.env.GENERATION_PIPELINE = pipeline;
  const check = checkGenerationConfig();
  if (check.errors.length > 0) {
    for (const e of check.errors) console.error(`ERROR: ${e}`);
    process.exit(1);
  }
  if (!argv.includes("--yes")) {
    console.error(`gen:smoke makes real model calls (one ${tier} set). Re-run with --yes to spend.`);
    process.exit(1);
  }
  const accountant = new UsageAccountant();
  const started = Date.now();
  const r = await generateProblems({
    client: new Anthropic({ maxRetries: 4, timeout: 300_000 }),
    profile: PROFILES[tier],
    topic: "",
    recentTopics: [],
    accountant,
    startedAt: started,
  });
  const cost = costForRun(r.meta.usage);
  console.log(
    `${r.ok ? "OK" : `FAILED: ${r.error}`} pipeline=${r.meta.pipeline ?? "legacy"} tier=${r.meta.tier} kept=${r.meta.kept}/${r.meta.asked} wall=${Date.now() - started}ms cost=${formatRunCost(cost)}`
  );
  if (r.meta.cascade) console.log(JSON.stringify(r.meta.cascade, null, 2));
  await prisma.$disconnect();
  process.exit(r.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("[gen:smoke]", e);
  process.exit(1);
});
