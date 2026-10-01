// Slot types from the corpus taxonomy (lib/generation/taxonomy.ts): one cheap call
// selects the catalog types that fit today's topic, then code samples the set's slots,
// excluding the types this student's recent sets used. Replaces the two-call type menu
// (problem-types.ts) for contest students whenever enough fresh types fit; the menu
// stays as the fallback for narrow topics and non-contest subjects.
//
// Non-blocking, like the menu: any failure returns null and the caller falls back.
import type Anthropic from "@anthropic-ai/sdk";
import { buildTypeSelectionPrompt } from "@/lib/generation-prompt";
import { sampleSlotTypes, taxonomyTypes, type TaxonomyType } from "@/lib/generation/taxonomy";
import type { GenerationPlan } from "@/lib/generation/plan";
import type { RungConfig } from "@/lib/generation/cascade/ladder";
import type { CallOpenWeight, ToolSpec } from "@/lib/generation/cascade/verify-cheap";

const SELECT_TOOL: ToolSpec = {
  name: "emit_selection",
  description: "Return the numbers of the catalog types that fit today's topic.",
  parameters: { type: "object", properties: { types: { type: "array", items: { type: "integer" } } }, required: ["types"] },
};

// Which catalog categories a contest draws from.
export function catalogFor(competition: string | null, all: TaxonomyType[] = taxonomyTypes()): TaxonomyType[] {
  if (!competition) return [];
  return competition === "Fma" ? all.filter((t) => t.category === "mechanics") : all.filter((t) => t.category !== "mechanics");
}

export async function taxonomySlots(args: {
  call: CallOpenWeight;
  rung: RungConfig;
  plan: Pick<GenerationPlan, "competition" | "bandLow" | "bandHigh">;
  profile: string;
  topic: string;
  recentTypeIds: string[];
  rotationKey: string;
  count: number;
  signal: AbortSignal;
  recordUsage: (u: Anthropic.Usage) => void;
  catalog?: TaxonomyType[]; // tests inject one
}): Promise<{ types: TaxonomyType[]; fitting: number; fresh: number; fittingIds: string[] } | null> {
  const { plan, count } = args;
  const catalog = args.catalog ?? catalogFor(plan.competition);
  if (catalog.length < count) return null;
  const level = plan.competition && plan.bandLow != null ? `${plan.competition} problems #${plan.bandLow}–${plan.bandHigh}` : "the student's level";
  const r = await args.call(
    args.rung,
    buildTypeSelectionPrompt({ profile: args.profile, topic: args.topic, level, types: catalog.map((t) => t.name) }),
    SELECT_TOOL,
    args.signal,
    args.recordUsage
  );
  if (!r.ok) return null;
  const raw = (r.args as { types?: unknown } | null)?.types;
  if (!Array.isArray(raw)) return null;
  const fitting = [...new Set(raw.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < catalog.length))].map((i) => catalog[i]);
  const recent = new Set(args.recentTypeIds);
  const fresh = fitting.filter((t) => !recent.has(t.id)).length;
  // Fewer fresh fitting types than slots: return just the fresh ones (never a recent
  // type) and let the caller top the set up from the type menu — a narrow topic has
  // only ~12–15 catalog types, so after one session most are recent.
  const types = sampleSlotTypes({
    candidates: fitting.filter((t) => !recent.has(t.id)),
    count: Math.min(count, fresh),
    recentTypeIds: args.recentTypeIds,
    competition: plan.competition,
    bandLow: plan.bandLow,
    bandHigh: plan.bandHigh,
    rotationKey: args.rotationKey,
  });
  return { types, fitting: fitting.length, fresh, fittingIds: fitting.map((t) => t.id) };
}
