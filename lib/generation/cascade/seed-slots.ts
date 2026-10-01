// Seeded slots for contest scratch sets: each slot is a variant of one REAL in-band
// corpus problem instead of a problem invented from scratch. Pure: no Prisma, no env.
//
// Why: asking a cheap writer to "make it play like #13" doesn't work. GLM sets judged
// ~0.18 on the human-difficulty scale against a 0.236 target (about #3–5 instead of
// #10–15), and only 3 of 28 kept problems reached the target. A variant inherits its
// difficulty from the real problem it transforms: in the first seeded run, 6 of 11
// seeded items reached the target against 6 of 48 scratch items in the same sets.
//
// Which real problems: those at the set's target positions plus any rated problem from
// the same contest whose human rating sits in the targets' window (the caller
// merges both), whose corpus-taxonomy type fits today's topic (the selection call's
// answer), never one a recent set was built on, and at most one per type so the set
// stays varied. Types the student's recent sets used go last.
import { stableHash } from "@/lib/generation/cascade/targets";
import { answerOkFor } from "@/lib/generation/verifier";
import type { GenerationPlan } from "@/lib/generation/plan";
import type { Anchor } from "@/lib/types";

// Contests a student's seeds may come from, matched by human rating. Only AIME borrows:
// HMMT problems rated inside an AIME band (E2H's rating is fitted to each contest's own
// students) roughly double what AIME #10–15 has (+72 on 104). AMC 12 problems rated like
// AMC 10 #10–15 made variants judged far easier than their seeds (0.191 vs 0.241), so AMC
// stays own-contest. The HMMT/AIME equivalence is a decision, not a measurement: check it
// with the difficulty judge before relying on it for calibration.
export const SEED_SOURCES: Record<string, string[]> = { AIME: ["AIME", "HMMT-Nov", "HMMT-Feb"] };
export const seedSourcesFor = (competition: string): string[] => SEED_SOURCES[competition] ?? [competition];

// A seed from another contest must have an answer of the student's contest's kind. For
// AIME that is any integer: many HMMT answers are fractions, radicals or pairs, whose
// structure doesn't carry over, but an integer outside 0–999 is fine, since the variant
// writer picks its own answer (adds 57 seeds at AIME #1–9 and 34 at #10–15 over 0–999).
export function seedFitsContest(seed: Anchor, plan: Pick<GenerationPlan, "answerFormat" | "competition">): boolean {
  if (!plan.competition || seed.source === plan.competition) return true;
  const answer = (seed.answer ?? "").trim();
  if (plan.competition === "AIME" || plan.answerFormat === "integer") return /^-?\d+$/.test(answer);
  return answerOkFor({ problem: seed.statement, answer, solution: "" }, plan);
}

export type SeedPick = { seed: Anchor & { id: string }; typeId: string; rating?: number };

export function pickSeeds(args: {
  candidates: Anchor[];
  typeOf: (id: string) => string | undefined;
  ratingOf?: (id: string) => number | undefined;
  fittingTypeIds: Set<string>;
  recentSeedIds: string[];
  recentTypeIds: string[];
  rotationKey: string;
  max: number;
}): SeedPick[] {
  const recentSeeds = new Set(args.recentSeedIds);
  const recentTypes = new Set(args.recentTypeIds);
  const byType = new Map<string, (Anchor & { id: string })[]>();
  const seen = new Set<string>();
  for (const r of args.candidates) {
    if (!r.id || !r.answer || recentSeeds.has(r.id) || seen.has(r.id)) continue;
    seen.add(r.id);
    const typeId = args.typeOf(r.id);
    if (!typeId || !args.fittingTypeIds.has(typeId)) continue;
    const list = byType.get(typeId) ?? [];
    list.push(r as Anchor & { id: string });
    byType.set(typeId, list);
  }
  const key = (s: string) => stableHash(`${args.rotationKey}|seed|${s}`);
  // One problem per type, chosen by the rotation key; fresh types before recent ones.
  return [...byType.entries()]
    .map(([typeId, list]) => {
      const seed = [...list].sort((a, b) => key(a.id) - key(b.id))[0];
      const rating = args.ratingOf?.(seed.id);
      return { typeId, seed, ...(rating !== undefined ? { rating } : {}) };
    })
    .sort((a, b) => Number(recentTypes.has(a.typeId)) - Number(recentTypes.has(b.typeId)) || key(a.typeId) - key(b.typeId))
    .slice(0, args.max);
}

// Roughly one AMC position per 0.01 of rating near the middle of the AMC 10 (medians
// run 0.19 at #6 to 0.24 at #11), so the two distances are comparable.
const RATING_PER_POSITION = 0.01;

// Which objective each seed fills. Objectives are ordered easy → hard; each seed, easiest
// first, takes the free objective nearest it: by human rating when both the seed and the
// objective's target are rated, else by problem number (same contest only; an unrated
// seed from another contest can't be placed and is left as a spare). Returns objective
// index → pick; objectives left out are written from scratch.
export function assignSeeds(
  picks: SeedPick[],
  targets: number[],
  targetRatings: (number | null)[] = [],
  competition: string | null = null
): Map<number, SeedPick> {
  const out = new Map<number, SeedPick>();
  const distance = (p: SeedPick, i: number): number | null => {
    const tr = targetRatings[i];
    if (p.rating !== undefined && tr != null) return Math.abs(p.rating - tr) / RATING_PER_POSITION;
    if (p.seed.number == null || (competition && p.seed.source !== competition)) return null;
    return Math.abs(targets[i] - p.seed.number);
  };
  const order = (p: SeedPick) => (p.rating !== undefined ? p.rating / RATING_PER_POSITION : (p.seed.number ?? 0));
  for (const p of [...picks].sort((a, b) => order(a) - order(b))) {
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < targets.length; i++) {
      if (out.has(i)) continue;
      const d = distance(p, i);
      if (d !== null && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    if (best !== -1) out.set(best, p);
  }
  return out;
}
