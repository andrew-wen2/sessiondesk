// Solver configuration — the escape hatches for lib/generation/solve.ts (DX D8).
// Existing generation-stage env vars stay where they are (read inline in plan.ts /
// problems.ts, per the repo's established pattern); this file only centralizes the
// NEW knobs this plan introduces, so they have one documented home instead of
// being scattered across call sites as they're added.
//
// Mirrors the repo's GENERATION_NO_* kill-switch pattern (GENERATION_NO_ADAPT,
// GENERATION_NO_PLAN, GENERATION_NO_SEED_SKETCH) rather than inventing a new one.

import { parseEffort } from "@/lib/generation/call-tool";
import type { Tier } from "@/lib/generation/plan";

export type SolverConfig = {
  enabled: boolean;
  model: string;
  escalateModel: string;
  effort: "low" | "medium" | "high";
  maxEscalations: number;
  tiers: Set<Tier>;
};

const ALL_TIERS: Tier[] = ["easy", "mid", "hard"];

function parseTiers(v: string | undefined): Set<Tier> {
  if (!v) return new Set(ALL_TIERS);
  const parsed = v
    .split(",")
    .map((s) => s.trim())
    .filter((s): s is Tier => (ALL_TIERS as string[]).includes(s));
  return parsed.length > 0 ? new Set(parsed) : new Set(ALL_TIERS);
}

// First non-blank value among the named env vars, else `fallback`. `??` alone is not
// enough: .env.example ships these overrides as `NAME=""`, and an empty string is not
// nullish, so a freshly copied env file used to send model "" to every call.
export function envOr(names: string | string[], fallback: string): string {
  for (const name of Array.isArray(names) ? names : [names]) {
    const v = process.env[name]?.trim();
    if (v) return v;
  }
  return fallback;
}

export function solverConfig(): SolverConfig {
  return {
    enabled: process.env.GENERATION_NO_SOLVE !== "1",
    model: envOr("SOLVER_MODEL", "claude-opus-5"),
    escalateModel: envOr(["SOLVER_MODEL_ESCALATE", "SOLVER_MODEL"], "claude-opus-5"),
    effort: parseEffort(process.env.GENERATION_EFFORT_SOLVE, "high"),
    // Hard cap on Opus escalation calls per generation request — mirrors the
    // existing audit-escalation cap in problems.ts (failIdx.slice(0, 3)). Without
    // this, worst case is unbounded: every item in a set could disagree and
    // escalate, and the 300s function ceiling is shared with generation itself.
    maxEscalations: Number(envOr("SOLVE_MAX_ESCALATIONS", "3")) || 3,
    tiers: parseTiers(process.env.SOLVE_TIERS),
  };
}

// Per-call timeout for the solver's Anthropic client. Deliberately separate from
// (and much shorter than) the generation route's client, which is pinned to
// maxDuration * 1000 (300s) — see route.ts's comment on why. A solver reusing that
// client would let one hung solve eat the entire function budget before
// session.update ever runs. 30-45s is generous for a single-problem solve.
export const SOLVER_CLIENT_TIMEOUT_MS = 40_000;

// Which vendor writes the problem statements — plan derivation, tiered generation,
// seed-sketch, expand, and lessons. Per-stage (Eng D2), not a single on/off switch:
// the HARD tier is the one reasoning-critical generation call (AIME #10-15 variants
// or a non-contest student's hardest material), so it stays on Claude Opus; every
// other stage runs on Gemini Flash, which is cheaper and was measured clean on
// LaTeX-heavy structured output in function-calling mode (see gemini-call.ts).
// GENERATION_PROVIDER="anthropic"/"gemini" is an escape hatch that forces EVERY
// stage to one vendor — for an eval `--compare` run against a single-vendor
// baseline, or to roll back without a deploy if the mixed policy misbehaves.
// The solver (lib/generation/solve.ts) is UNAFFECTED by any of this and always
// stays on Anthropic: Premise 3 requires the oracle be a different model family
// from whichever one is writing problems, and flipping both together would
// silently turn the oracle into self-consistency checking. (The hard tier writing
// on Opus alongside an Opus solver is the one place that independence narrows to
// "different model, same vendor" — same as this pipeline's pre-Gemini baseline,
// not a new regression.)
export type GenerationProvider = "anthropic" | "gemini";
export type GenModelStage = "plan" | "easy" | "mid" | "hard" | "expand" | "seedSketch" | "lesson";

export function providerForStage(stage: GenModelStage): GenerationProvider {
  const override = process.env.GENERATION_PROVIDER;
  if (override === "anthropic" || override === "gemini") return override;
  return stage === "hard" ? "anthropic" : "gemini";
}

// Which problem pipeline a tier runs: "legacy" (chunked, lib/generation/problems.ts)
// or "cascade" (per-slot ladder, lib/generation/cascade). Default legacy until the
// cascade passes its eval; GENERATION_PIPELINE_{EASY,MID,HARD} overrides per tier so
// cutover (and rollback) can be staged tier by tier. An unknown value is an error,
// never a silent default. Read once per request.
export type Pipeline = "legacy" | "cascade";
export class PipelineConfigError extends Error {}
export function pipelineFor(tier: "easy" | "mid" | "hard"): Pipeline {
  const name = `GENERATION_PIPELINE_${tier.toUpperCase()}`;
  const v = envOr([name, "GENERATION_PIPELINE"], "legacy");
  if (v !== "legacy" && v !== "cascade") {
    throw new PipelineConfigError(`${name} / GENERATION_PIPELINE must be "legacy" or "cascade", got "${v}".`);
  }
  return v;
}

// Anthropic-path model per stage, with the same env overrides the pipeline has always
// read (GENERATION_MODEL wins for the generation tiers and lessons). One home for the
// defaults so the routes' genMeta provenance names the model that actually ran.
const ANTHROPIC_DEFAULTS = {
  plan: "claude-haiku-4-5",
  easy: "claude-haiku-4-5",
  mid: "claude-sonnet-4-6",
  hard: "claude-opus-5",
  lesson: "claude-sonnet-4-6",
} as const;
export function anthropicModelFor(stage: keyof typeof ANTHROPIC_DEFAULTS): string {
  switch (stage) {
    case "plan":
      return envOr("GENERATION_MODEL_PLAN", ANTHROPIC_DEFAULTS.plan);
    case "lesson":
      return envOr(["GENERATION_MODEL", "GENERATION_MODEL_MID"], ANTHROPIC_DEFAULTS.lesson);
    case "easy":
      return envOr(["GENERATION_MODEL", "GENERATION_MODEL_EASY"], ANTHROPIC_DEFAULTS.easy);
    case "mid":
      return envOr(["GENERATION_MODEL", "GENERATION_MODEL_MID"], ANTHROPIC_DEFAULTS.mid);
    case "hard":
      return envOr(["GENERATION_MODEL", "GENERATION_MODEL_HARD"], ANTHROPIC_DEFAULTS.hard);
  }
}

// Gemini model defaults — one model for every tier to start (real per-tier tuning
// is Stage 4 territory, once the eval has a baseline to tune against). Function-
// calling mode ONLY (see gemini-call.ts's header) — never raw JSON mode.
export function geminiModelFor(stage: GenModelStage): string {
  const perStage: Record<typeof stage, string> = {
    plan: "GEMINI_MODEL_PLAN",
    easy: "GEMINI_MODEL_EASY",
    mid: "GEMINI_MODEL_MID",
    hard: "GEMINI_MODEL_HARD",
    expand: "GEMINI_MODEL_EXPAND",
    seedSketch: "GEMINI_MODEL_EXPAND", // seed-sketch reuses the expand model, same as the Anthropic path
    lesson: "GEMINI_MODEL_MID",
  };
  return envOr(["GEMINI_MODEL", perStage[stage]], "gemini-3.8-flash");
}
