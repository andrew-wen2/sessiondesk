// Candidate specs for the cascade: what makes each separately-written problem
// different from its siblings, since no call sees the whole set. The first `count`
// specs seed the objectives in order (easy → hard); the rest are spares the scheduler
// hands to replacement candidates.
//
//   plan source / mode          spec per candidate
//   corpus, hard (variant)      one DISTINCT in-band seed each (seedIndex); if the band
//                               has fewer seeds than needed, the rest fall back to
//                               scratch specs — never to out-of-band seeds
//   corpus, easy/mid (scratch)  shared calibration anchors + a rotating angle
//   model plan with slots       one sub-skill each, cycled with angles if short
//   fallback / too few slots    a rotating angle, indexed
import type { GenerationPlan } from "@/lib/generation/plan";
import { slotHintForAngle, slotHintForSeed, slotHintForSubtopic } from "@/lib/generation-prompt";
import type { CandidateSpec } from "@/lib/generation/cascade/scheduler";
import type { Anchor } from "@/lib/types";

export type SpecPlan = { specs: CandidateSpec[]; seedsUsed: number };

const label = (a: Anchor) => `${a.source}${a.number != null ? ` #${a.number}` : ""}`;

export function buildSpecs(args: {
  plan: GenerationPlan;
  mode: "variant" | "scratch";
  seeds: Anchor[]; // variant mode: distinct in-band seeds; ignored otherwise
  total: number; // objectives + spares
  // Variant mode: the share of seed specs that REVERSE their seed (reverse.ts) instead of
  // transposing it, spread evenly through the list. Only seeds with a numeric answer.
  reverseShare?: number;
}): SpecPlan {
  const { plan, mode, seeds, total, reverseShare = 0 } = args;
  const specs: CandidateSpec[] = [];

  if (mode === "variant") {
    const usable = seeds.filter((s) => s.solution || s.answer).slice(0, total);
    usable.forEach((s, i) => {
      const reverse = reverseShare > 0 && /^-?\d+$/.test((s.answer ?? "").trim()) && Math.floor((i + 1) * reverseShare) > Math.floor(i * reverseShare);
      specs.push({ hint: `${slotHintForSeed(label(s))}${reverse ? ", reversed" : ""}`, seedIndex: seeds.indexOf(s), ...(reverse ? { reverse: true } : {}) });
    });
  }
  const seedsUsed = specs.length;

  const subtopics = plan.slots?.filter(Boolean) ?? [];
  for (let i = 0; specs.length < total; i++) {
    const hint =
      subtopics.length > 0
        ? i < subtopics.length
          ? slotHintForSubtopic(subtopics[i])
          : `${slotHintForSubtopic(subtopics[i % subtopics.length])}, approached as ${slotHintForAngle(i)}`
        : slotHintForAngle(i);
    specs.push({ hint });
  }
  return { specs, seedsUsed };
}

// Two-skill composition for the upper half of the set (MATH², Shah et al. 2024: models'
// success on problems needing two sampled skills was about the SQUARE of their success
// on one-skill problems, the one prompt-only lever with a measured difficulty effect).
// Slots from ceil(count/2) on get a partner type, taken from types no slot uses when
// there are any, so a partner doesn't turn into a repeat of a sibling's idea.
export function composeUpperSlots(types: string[], count: number): string[] {
  if (types.length < 2) return types;
  const firstComposed = Math.ceil(count / 2);
  const spare = types.slice(count);
  return types.map((t, i) => {
    if (i < firstComposed || i >= count) return t;
    const k = i - firstComposed;
    const partner = spare.length > 0 ? spare[k % spare.length] : types[(i + 1) % Math.min(count, types.length)];
    return partner === t ? t : `${t}, COMBINED WITH ${partner} (the problem must need both ideas)`;
  });
}
