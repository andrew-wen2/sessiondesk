// Configuration check for problem generation, with no model calls and no spend:
// what each tier would run, whether its ladder fits the time budget, whether every
// provider it needs has credentials, and whether every model it would bill for has a
// price. Backs `npm run gen:check`; kept pure over process.env so it is unit-tested.
import { envOr, pipelineFor, providerForStage, solverConfig, type Pipeline } from "@/lib/generation/config";
import { ladderFor, type RungConfig, type RungProvider } from "@/lib/generation/cascade/ladder";
import { ladderFeasibility } from "@/lib/generation/cascade/deadline";
import { validateOpenWeightBaseUrl } from "@/lib/generation/cascade/writers";
import { isPriced } from "@/lib/generation/pricing";

export type CheckReport = { lines: string[]; errors: string[]; warnings: string[] };

const TIERS = ["easy", "mid", "hard"] as const;

function credentialProblem(p: RungProvider): string | null {
  if (p === "anthropic") return envOr("ANTHROPIC_API_KEY", "") ? null : "ANTHROPIC_API_KEY is not set";
  if (p === "gemini") return envOr("GOOGLE_API_KEY", "") ? null : "GOOGLE_API_KEY is not set";
  const key = envOr("OPENWEIGHT_API_KEY", "");
  const url = envOr("OPENWEIGHT_BASE_URL", "");
  if (!key || !url) return "OPENWEIGHT_API_KEY and OPENWEIGHT_BASE_URL must both be set";
  try {
    validateOpenWeightBaseUrl(url);
  } catch (e) {
    return (e as Error).message;
  }
  return null;
}

export function checkGenerationConfig(): CheckReport {
  const lines: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];

  if (!envOr("ANTHROPIC_API_KEY", "")) errors.push("ANTHROPIC_API_KEY is not set — the route refuses to generate without it.");
  if (providerForStage("plan") === "gemini" && !envOr("GOOGLE_API_KEY", "")) {
    warnings.push("The plan stage runs on Gemini but GOOGLE_API_KEY is not set: non-contest students will silently get the keyword fallback plan.");
  }

  const solver = solverConfig();
  if (solver.enabled && !isPriced("anthropic", solver.model)) warnings.push(`Solver model ${solver.model} has no price row in pricing.ts.`);

  for (const tier of TIERS) {
    let pipeline: Pipeline;
    try {
      pipeline = pipelineFor(tier);
    } catch (e) {
      errors.push((e as Error).message);
      continue;
    }
    if (pipeline === "legacy") {
      lines.push(`${tier}: legacy pipeline (provider ${providerForStage(tier)})`);
      continue;
    }
    let ladder: RungConfig[];
    try {
      ladder = ladderFor(tier);
    } catch (e) {
      errors.push(`${tier}: ${(e as Error).message}`);
      continue;
    }
    lines.push(
      `${tier}: cascade — ${ladder
        .map((r) => `${r.provider}:${r.model} (${r.timeoutMs / 1000}s, thinking ${r.thinking}, tool ${r.toolChoice})`)
        .join(" → ")}`
    );
    // Hard is the only tier that can be solver-verified (adapt path).
    const verified = tier === "hard" && solver.enabled;
    const f = ladderFeasibility(ladder, verified, tier);
    // A ladder whose cheap rungs can never start is almost certainly a timeout set too
    // high: the whole point of the ladder is lost, so it is an error, not a warning.
    if (!f.topRungFits) errors.push(f.message);
    else if (ladder.length > 1 && !f.cheapRungsUsable) errors.push(f.message);
    else lines.push(`  budget: ${f.message}`);

    for (const p of new Set(ladder.map((r) => r.provider))) {
      const problem = credentialProblem(p);
      if (problem) errors.push(`${tier}: ${problem}.`);
    }
    for (const r of ladder) {
      if (!isPriced(r.provider, r.model)) errors.push(`${tier}: ${r.provider}/${r.model} has no price row in pricing.ts — spend on it would be invisible.`);
    }
  }
  return { lines, errors, warnings };
}
