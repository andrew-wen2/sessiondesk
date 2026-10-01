// The model ladder for the per-slot cascade (docs/designs/generation-cascade.md).
// Each problem slot starts on rung 0 and escalates one rung at a time when its output
// fails; the last rung is the reliability backstop.
//
// Rung behavior is configuration, not code: a vendor's quirks (whether it accepts a
// forced tool call, whether thinking can be turned off) live in PROVIDER_CAPS, and a
// rung that contradicts them is rejected at parse time rather than failing at 2am.
import { envOr } from "@/lib/generation/config";
import type { Tier } from "@/lib/generation/plan";

export type RungProvider = "anthropic" | "gemini" | "openweight";
export type Thinking = "off" | "low" | "medium" | "high" | "max";
// "forced": the call must return the tool; "auto": the model may answer in prose,
// and a missing tool call is treated as a normal escalation trigger.
export type ToolChoice = "forced" | "auto";

export type RungConfig = {
  provider: RungProvider;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  thinking: Thinking;
  toolChoice: ToolChoice;
};

type ProviderCaps = {
  // Thinking levels this provider accepts. Researched 2026-09 (design doc, "Ladder research").
  thinking: readonly Thinking[];
  // Whether a forced tool call is accepted, given the thinking level.
  forcedToolOk: (thinking: Thinking) => boolean;
};

export const PROVIDER_CAPS: Record<RungProvider, ProviderCaps> = {
  // Anthropic: adaptive thinking requires tool_choice auto (call-tool.ts).
  anthropic: { thinking: ["off", "low", "medium", "high", "max"], forcedToolOk: (t) => t === "off" },
  gemini: { thinking: ["low", "medium", "high"], forcedToolOk: () => true },
  // OpenAI-compatible open-weight hosts. DeepSeek rejects forced tool_choice while
  // thinking is on; GLM-5.3 accepts only "auto" and cannot turn thinking off. The
  // conservative common rule: forced only with thinking off, per-model below.
  openweight: { thinking: ["off", "low", "medium", "high", "max"], forcedToolOk: (t) => t === "off" },
};

// Models known to reject a forced tool call regardless of thinking, and models whose
// thinking cannot be disabled. Matched by prefix of the model id.
const AUTO_ONLY_MODELS = ["glm-5.3", "zai-org/glm-5.3", "z-ai/glm-5.3"];
// Opus 5.5 rejects "thinking.type.disabled" (HTTP 400), so a tier default of "off"
// (the easy tier) would fail every Opus call, escalations to the top rung included.
const ALWAYS_THINKING_MODELS = ["glm-5.3", "zai-org/glm-5.3", "z-ai/glm-5.3", "claude-opus-5-5"];

// Case-insensitive: hosts spell the same model differently ("glm-5.3", "zai-org/GLM-5.3").
const matches = (model: string, prefixes: string[]) => prefixes.some((p) => model.toLowerCase().startsWith(p));

// Per-tier defaults for fields an env override doesn't spell out. Placeholders until
// the spike measures p95 per rung. Hard's cheap-rung timeout is sized so rung 0 plus
// its verification plus the top rung fits the 285s budget (75+40 + 120+40 = 275s);
// deadline.test.ts fails if a change here makes any default ladder infeasible.
const TIER_DEFAULTS: Record<Tier, { timeoutMs: number; topTimeoutMs: number; maxTokens: number; thinking: Thinking }> = {
  easy: { timeoutMs: 60_000, topTimeoutMs: 90_000, maxTokens: 6_000, thinking: "off" },
  // mid maxTokens 10k, not 12k: a GLM write that thinks through the cap never writes a
  // problem, so the lower cap ends it sooner; no passing write in the probe used over 9.7k.
  mid: { timeoutMs: 90_000, topTimeoutMs: 120_000, maxTokens: 10_000, thinking: "high" },
  hard: { timeoutMs: 75_000, topTimeoutMs: 120_000, maxTokens: 16_000, thinking: "high" },
};

export const TOP_RUNG_MODEL = "claude-opus-5-5";

// Rung deadlines are per candidate, not per set: every candidate runs concurrently, so
// a slow rung costs its time once, not once per problem. What bounds them is that a
// candidate's path (a cheap rung, then the top rung, plus verification) must fit the
// route budget — gen:check and ladderFeasibility enforce that. Override per tier, in
// seconds: CASCADE_RUNG_TIMEOUT_<TIER> (cheap rungs), CASCADE_TOP_TIMEOUT_<TIER>.
function timeoutEnv(name: string, fallbackMs: number): number {
  const s = Number(envOr(name, ""));
  return Number.isFinite(s) && s > 0 ? Math.round(s * 1000) : fallbackMs;
}

function rung(tier: Tier, provider: RungProvider, model: string, isTop: boolean, thinkingOverride?: Thinking): RungConfig {
  const base = TIER_DEFAULTS[tier];
  const T = tier.toUpperCase();
  const d = {
    ...base,
    timeoutMs: timeoutEnv(`CASCADE_RUNG_TIMEOUT_${T}`, base.timeoutMs),
    topTimeoutMs: timeoutEnv(`CASCADE_TOP_TIMEOUT_${T}`, base.topTimeoutMs),
  };
  const wanted = thinkingOverride ?? d.thinking;
  const thinking: Thinking = matches(model, ALWAYS_THINKING_MODELS) && wanted === "off" ? "low" : wanted;
  const forcedOk = PROVIDER_CAPS[provider].forcedToolOk(thinking) && !matches(model, AUTO_ONLY_MODELS);
  return {
    provider,
    model,
    timeoutMs: isTop ? d.topTimeoutMs : d.timeoutMs,
    maxTokens: d.maxTokens,
    thinking,
    toolChoice: forcedOk ? "forced" : "auto",
  };
}

// Interim default: Opus only. Open-weight rungs go in front via GENERATION_LADDER_*
// once each passes admission (hosting/PII decision, LaTeX escape test, correctness
// gate, exact pricing row) — see the design doc's "Final gate decisions".
export function defaultLadder(tier: Tier): RungConfig[] {
  return [rung(tier, "anthropic", TOP_RUNG_MODEL, true)];
}

export class LadderConfigError extends Error {}

const PROVIDERS: readonly RungProvider[] = ["anthropic", "gemini", "openweight"];

const THINKING_LEVELS: readonly Thinking[] = ["off", "low", "medium", "high", "max"];

// "provider:model[@thinking][,provider:model[@thinking]]" → rungs. The last entry is the
// top rung. The optional @thinking overrides the tier's default thinking level for that
// rung — e.g. a verbose open-weight model that times out at the tier's "high".
export function parseLadder(tier: Tier, spec: string): RungConfig[] {
  const entries = spec.split(",").map((s) => s.trim()).filter(Boolean);
  if (entries.length === 0) throw new LadderConfigError(`GENERATION_LADDER_${tier.toUpperCase()} is empty.`);
  return entries.map((entry, i) => parseRungSpec(tier, entry, i === entries.length - 1));
}

// One "provider:model[@thinking]" entry → a rung with the tier's defaults. Also used for
// the cascade's cheap solvers (verify-cheap.ts), which are configured the same way.
export function parseRungSpec(tier: Tier, entry: string, isTop = false): RungConfig {
  const sep = entry.indexOf(":");
  const provider = sep > 0 ? entry.slice(0, sep) : "";
  const rest = sep > 0 ? entry.slice(sep + 1).trim() : "";
  const at = rest.lastIndexOf("@");
  const model = at > 0 ? rest.slice(0, at) : rest;
  const thinking = at > 0 ? rest.slice(at + 1) : undefined;
  if (!(PROVIDERS as readonly string[]).includes(provider) || !model) {
    throw new LadderConfigError(
      `GENERATION_LADDER_${tier.toUpperCase()} entry "${entry}" must look like provider:model[@thinking], with provider one of ${PROVIDERS.join(", ")}.`
    );
  }
  if (thinking !== undefined && !(THINKING_LEVELS as readonly string[]).includes(thinking)) {
    throw new LadderConfigError(`GENERATION_LADDER_${tier.toUpperCase()} entry "${entry}": thinking must be one of ${THINKING_LEVELS.join(", ")}.`);
  }
  return rung(tier, provider as RungProvider, model, isTop, thinking as Thinking | undefined);
}

// Checks a rung against its provider's capabilities. Returns the problems found.
export function rungProblems(r: RungConfig): string[] {
  const out: string[] = [];
  const caps = PROVIDER_CAPS[r.provider];
  if (!caps.thinking.includes(r.thinking)) out.push(`${r.model}: thinking "${r.thinking}" is not supported by ${r.provider}.`);
  if (r.toolChoice === "forced" && (!caps.forcedToolOk(r.thinking) || matches(r.model, AUTO_ONLY_MODELS))) {
    out.push(`${r.model}: a forced tool call is not accepted with thinking "${r.thinking}".`);
  }
  if (r.thinking === "off" && matches(r.model, ALWAYS_THINKING_MODELS)) {
    out.push(`${r.model}: thinking cannot be turned off for this model.`);
  }
  if (!(r.timeoutMs > 0) || !(r.maxTokens > 0)) out.push(`${r.model}: timeout and max tokens must be positive.`);
  return out;
}

// The ladder a tier actually runs: env override or default, minus any provider named in
// GENERATION_DISABLE_RUNGS (a fast way to pull a misbehaving vendor without a rewrite).
// Throws LadderConfigError with a message naming the bad entry; never silently defaults.
export function ladderFor(tier: Tier): RungConfig[] {
  const spec = envOr(`GENERATION_LADDER_${tier.toUpperCase()}`, "");
  const ladder = spec ? parseLadder(tier, spec) : defaultLadder(tier);
  const disabled = new Set(
    envOr("GENERATION_DISABLE_RUNGS", "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
  );
  const kept = ladder.filter((r) => !disabled.has(r.provider) && !disabled.has(r.model));
  if (kept.length === 0) {
    throw new LadderConfigError(`GENERATION_DISABLE_RUNGS removes every rung of the ${tier} ladder.`);
  }
  const problems = kept.flatMap(rungProblems);
  if (problems.length > 0) throw new LadderConfigError(problems.join(" "));
  return kept;
}
