// Reproduce ONE cascade slot without a full paid set: plan the profile, build the
// candidate specs exactly as the pipeline would, then run a single spec on a single
// rung and print the raw outcome, the guard verdicts and the latency.
// SPENDS REAL API CREDIT (one call, plus the plan call for non-contest profiles) —
// refuses to run without --yes. Needs DATABASE_URL for contest profiles (anchors).
//
//   npm run gen:slot -- --yes --profile "AMC 10, problems 16-25" [--topic counting] [--slot 3] [--rung 0] [--trace]
import Anthropic from "@anthropic-ai/sdk";
import { planFor } from "@/lib/generation/plan";
import { getAnchors } from "@/lib/corpus-retrieval";
import { countForTier } from "@/lib/calibration";
import { UsageAccountant } from "@/lib/generation/usage-accounting";
import { ladderFor } from "@/lib/generation/cascade/ladder";
import { buildSpecs } from "@/lib/generation/cascade/slots";
import { cascadeCheck, cascadeRequestBuilder, SPARES, writersFor } from "@/lib/generation/cascade/generate";
import { RungError } from "@/lib/generation/cascade/writers";
import { prisma } from "@/lib/prisma";

async function main() {
  const argv = process.argv.slice(2);
  const val = (n: string) => {
    const i = argv.indexOf(`--${n}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const known = new Set(["--yes", "--trace", "--profile", "--topic", "--slot", "--rung"]);
  const bad = argv.find((a) => a.startsWith("--") && !known.has(a));
  const profile = val("profile");
  if (bad || !profile) {
    console.error('Usage: npm run gen:slot -- --yes --profile "<student profile>" [--topic t] [--slot N] [--rung R] [--trace]');
    process.exit(1);
  }
  if (!argv.includes("--yes")) {
    console.error("gen:slot makes a real model call. Re-run with --yes to spend.");
    process.exit(1);
  }
  const topic = val("topic") ?? "";
  const accountant = new UsageAccountant();
  const plan = await planFor({ client: new Anthropic(), profile, topic, recentTopics: [], recordUsage: (u) => accountant.record("plan", u) });
  const count = countForTier(plan.tier);
  const mode = plan.tier === "hard" && plan.competition ? "variant" : "scratch";
  const pool = plan.competition
    ? await getAnchors({
        competition: plan.competition,
        bandLow: plan.bandLow,
        bandHigh: plan.bandHigh,
        category: plan.category,
        count: mode === "variant" ? count + SPARES : 4,
        strictBand: mode === "variant",
      })
    : [];
  const { specs } = buildSpecs({ plan, mode, seeds: mode === "variant" ? pool : [], total: count + SPARES });
  const ladder = ladderFor(plan.tier);
  const slot = Number(val("slot") ?? "0");
  const rungIndex = Number(val("rung") ?? "0");
  const spec = specs[slot];
  const rung = ladder[rungIndex];
  if (!spec || !rung) {
    console.error(`--slot must be 0-${specs.length - 1} and --rung 0-${ladder.length - 1} for this ${plan.tier} ladder.`);
    process.exit(1);
  }
  const writer = writersFor(new Set([rung.provider]))[rung.provider];
  if (!writer) {
    console.error(`No credentials for ${rung.provider}. Run npm run gen:check.`);
    process.exit(1);
  }
  const request = cascadeRequestBuilder({ plan, profile, topic, recentTopics: [], pool, calibration: mode === "variant" ? pool.slice(0, 4) : pool, count })({
    objective: slot,
    spec,
    kept: [],
    rung,
  });
  console.log(`plan: tier=${plan.tier} source=${plan.source} answerFormat=${plan.answerFormat}`);
  console.log(`slot ${slot}: ${spec.hint}${spec.seedIndex !== undefined ? ` (seed ${spec.seedIndex})` : ""}`);
  console.log(`rung ${rungIndex}: ${rung.provider}:${rung.model} thinking=${rung.thinking} tool=${rung.toolChoice} timeout=${rung.timeoutMs}ms`);
  if (argv.includes("--trace")) console.log(`\n--- system ---\n${request.system}\n--- user ---\n${request.user}\n`);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort("rung-timeout"), rung.timeoutMs);
  const started = Date.now();
  try {
    const p = await writer({ rung, ...request, signal: controller.signal, recordUsage: (u) => accountant.recordFor("generation", rung.provider, rung.model, u) });
    const rejection = cascadeCheck(plan)(p, spec);
    console.log(`finish=ok in ${Date.now() - started}ms; guards: ${rejection ?? "pass"}`);
    console.log(`\nPROBLEM:  ${p.problem}\nANSWER:   ${p.answer}\nSOLUTION: ${p.solution}`);
  } catch (e) {
    const finish = e instanceof RungError ? e.finish : "api-error";
    console.log(`finish=${finish} in ${Date.now() - started}ms: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    clearTimeout(timer);
    console.log(`\nusage: ${JSON.stringify(accountant.perModelUsage())}`);
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error("[gen:slot]", e);
  process.exit(1);
});
