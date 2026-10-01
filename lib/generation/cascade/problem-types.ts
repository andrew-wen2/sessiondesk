// Typed slots: before writing, one cheap call lists distinct problem TYPES for the
// topic, and each slot of the set gets a different one (they become plan.slots, which
// buildSpecs already spreads across the set). The list's starting point rotates with
// the session, so a student seen weekly on one topic doesn't get the same first types
// every time; the call is also shown their recent problems and puts unused types first.
//
// Why: contest sets used to differ only by a generic "angle" per slot, and a writer on
// a narrow topic fell back to its favorites. In an eval, two Opus sets on "linear and
// quadratic equations" shared a word-for-word problem, both had a split-the-rental and
// a two-pipes problem, and one set held three shared-root problems.
//
// Non-blocking: any failure returns [] and the set keeps the old angle hints.
import type Anthropic from "@anthropic-ai/sdk";
import { envOr } from "@/lib/generation/config";
import { buildProblemTypesPrompt, buildRecentTypesPrompt } from "@/lib/generation-prompt";
import type { GenerationPlan, Tier } from "@/lib/generation/plan";
import { LadderConfigError, parseRungSpec, type RungConfig } from "@/lib/generation/cascade/ladder";
import { stableHash } from "@/lib/generation/cascade/targets";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";

// Thinking off: two fast calls (name the recent problems' types, then list new types
// excluding those names) instead of one slow one. Asked to avoid the types of 20 raw
// problems in one call, the model with thinking off echoed them back as the list
// (a whole session of repeats), and with thinking on took 53s, past its budget.
// Thinking is pinned off here and whenever CASCADE_TYPES_MODEL names no level: without a
// level a rung takes its tier's default, and mid's is "high", so on the mid tier every
// type call ran past its 30s limit, no set got types or topic fit, and no slot was seeded.
export const DEFAULT_TYPES_MODEL = "openweight:deepseek-ai/DeepSeek-V4.1-Flash@off";
export const TYPES_WANTED = 16;

export function typesModelFromEnv(tier: Tier): RungConfig | null {
  const spec = envOr("CASCADE_TYPES_MODEL", DEFAULT_TYPES_MODEL).trim();
  if (spec === "off") return null;
  const r = parseRungSpec(tier, /@[a-z]+$/.test(spec) ? spec : `${spec}@off`);
  if (r.provider !== "openweight") throw new LadderConfigError(`CASCADE_TYPES_MODEL must be an openweight model, got ${r.provider}`);
  return r;
}

const TYPES_TOOL: ToolSpec = {
  name: "emit_types",
  description: "Return the distinct problem types for this set.",
  parameters: {
    type: "object",
    properties: { types: { type: "array", items: { type: "string" } } },
    required: ["types"],
  },
};

// The menu call itself asks for a typicality estimate per type (Verbalized Sampling,
// Zhang et al. 2025: asking for candidates WITH probabilities and drawing from the tail
// recovered ~2x the diversity of direct prompting, and direct-prompted synthetic math
// questions trained worse than no data). The least typical types go first, so the set's
// slots start away from the model's favorite setups.
const MENU_TOOL: ToolSpec = {
  name: "emit_types",
  description: "Return the distinct problem types for this set, each with its typicality.",
  parameters: {
    type: "object",
    properties: {
      types: {
        type: "array",
        items: { type: "object", properties: { type: { type: "string" }, typicality: { type: "number" } }, required: ["type", "typicality"] },
      },
    },
    required: ["types"],
  },
};

// Least typical first; a type with no usable estimate sorts as most typical. Stable.
export function byTypicality(raw: unknown): unknown[] {
  if (!Array.isArray(raw)) return [];
  const p = (x: unknown) => {
    const t = x && typeof x === "object" ? Number((x as { typicality?: unknown }).typicality) : NaN;
    return Number.isFinite(t) ? t : Infinity;
  };
  return raw.map((x, i) => ({ x, i, p: p(x) })).sort((a, b) => a.p - b.p || a.i - b.i).map((e) => e.x);
}

// Clean the model's list: trimmed, non-empty, short, case-insensitively distinct.
export function cleanTypes(raw: unknown, max = 20): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const t = item && typeof item === "object" ? (item as { type?: unknown }).type : item;
    if (typeof t !== "string") continue;
    const s = t.trim().replace(/\s+/g, " ");
    const key = s.toLowerCase();
    if (!s || s.length > 160 || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length >= max) break;
  }
  return out;
}

// Start the list at a session-dependent offset. The first entries (fresh types, per
// the prompt) stay near the front: rotation is over the first half only when the list
// is long enough, so a session never starts deep in the "already used" tail.
export function rotateTypes(types: string[], rotationKey: string): string[] {
  if (types.length < 2) return types;
  const span = Math.max(1, Math.ceil(types.length / 2));
  const k = stableHash(rotationKey) % span;
  return [...types.slice(k), ...types.slice(0, k)];
}

// Backstop for the exclusion: drop a listed type whose content words mostly match an
// excluded type's (half or more of the smaller phrase's words).
const STOP = new Set(["with", "from", "that", "this", "into", "then", "given", "using", "find", "solve", "value", "values", "number", "numbers", "problem", "type"]);
const words = (s: string) => new Set(s.toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) ?? []);
export function excludeSimilar(types: string[], excluded: string[]): string[] {
  const ex = excluded.map(words);
  return types.filter((t) => {
    const w = words(t);
    return !ex.some((e) => {
      const shared = [...w].filter((x) => e.has(x)).length;
      return shared >= 2 && shared >= Math.min(w.size, e.size) / 2;
    });
  });
}

export async function problemTypes(args: {
  call: CallOpenWeight;
  rung: RungConfig;
  plan: Pick<GenerationPlan, "domain" | "competition" | "bandLow" | "bandHigh">;
  profile: string;
  topic: string;
  recentProblems: string[];
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
}): Promise<string[]> {
  const { call, rung, plan, profile, topic, recentProblems, signal, recordUsage } = args;
  const typesOf = (r: Awaited<ReturnType<CallOpenWeight>>) => (r.ok ? cleanTypes((r.args as { types?: unknown } | null)?.types) : []);
  // Step 1: what the student already practiced, by name. If it fails, step 2 simply
  // runs without exclusions; keep-time dedup still guards against repeats.
  const excluded =
    recentProblems.length > 0 ? typesOf(await call(rung, buildRecentTypesPrompt({ domain: plan.domain, recentProblems }), TYPES_TOOL, signal, recordUsage)) : [];
  const menu = await call(rung, buildProblemTypesPrompt({ ...plan, profile, topic, excludedTypes: excluded, count: TYPES_WANTED }), MENU_TOOL, signal, recordUsage);
  const listed = menu.ok ? cleanTypes(byTypicality((menu.args as { types?: unknown } | null)?.types)) : [];
  return excludeSimilar(listed, excluded);
}
