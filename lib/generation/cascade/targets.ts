// Per-slot difficulty targets for contest students. Pure: no Prisma, no env.
//
// Without a target, every writer aimed at "the band" and landed wherever its own
// sense of difficulty put it: on the same easy AMC 10 student (#1–15), DeepSeek
// wrote problems that played like #3 and Opus like #17 (eval:difficulty). So each
// objective gets a concrete position, spread across the band in set order, and the
// writer sees ONE real problem at that position as a feel for its difficulty.
//
// The real problem is a reference, never a template: its topic, setup and numbers
// are off limits, and the session topic decides the content. That keeps repeat
// students from seeing recycled skeletons (only ~17 corpus problems exist per
// position, fewer within a topic). Which reference a candidate sees rotates with
// the session, the objective and the candidate's spec, so sessions differ and a
// replacement candidate doesn't get the reference its predecessor failed on.
import type { Competition } from "@/lib/calibration";
import type { ConstructTarget } from "@/lib/generation-prompt";
import type { CandidateSpec } from "@/lib/generation/cascade/scheduler";
import type { Anchor } from "@/lib/types";

// Highest problem number per contest (AIME has 15, the others 25).
export function maxNumberFor(competition: Competition): number {
  return competition === "AIME" ? 15 : 25;
}

// Objective i of `count` → a position spread evenly from bandLow to bandHigh, shifted
// by `offset` (a measured per-writer correction: positive when a writer plays easy)
// and clamped to the contest's range.
export function targetNumbers(bandLow: number, bandHigh: number, count: number, offset: number, maxNumber: number): number[] {
  return Array.from({ length: count }, (_, i) => {
    const t = count === 1 ? bandHigh : bandLow + ((bandHigh - bandLow) * i) / (count - 1);
    return Math.min(maxNumber, Math.max(1, Math.round(t + offset)));
  });
}

// FNV-1a: stable across processes, so the same key always picks the same reference.
export function stableHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

// The per-candidate target function the request builder calls. `refsByNumber` must be
// in a stable order (sorted by id) for the rotation to be reproducible.
export function buildTargetFor(args: {
  targets: number[];
  refsByNumber: Map<number, Anchor[]>;
  rotationKey: string;
}): (objective: number, spec: CandidateSpec) => ConstructTarget | undefined {
  const { targets, refsByNumber, rotationKey } = args;
  return (objective, spec) => {
    const number = targets[objective];
    if (number === undefined) return undefined;
    const refs = refsByNumber.get(number) ?? [];
    const reference = refs.length > 0 ? refs[stableHash(`${rotationKey}|${objective}|${spec.hint}`) % refs.length] : undefined;
    return { number, reference };
  };
}
