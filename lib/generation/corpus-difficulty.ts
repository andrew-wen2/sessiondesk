// Human difficulty for corpus problems, from Easy2Hard-Bench (E2H-AMC): an IRT rating
// in [0, 1] fitted to the published share of students who solved each AMC/AIME problem.
// Built offline by scripts/join-e2h.ts into data/corpus-difficulty.json, keyed by
// ReferenceProblem id; a problem with no match has no entry. Problem number stays the
// retrieval key; this is the finer scale the difficulty judge (difficulty-judge.ts) and
// the difficulty evals measure against.
import table from "@/data/corpus-difficulty.json";

export type CorpusDifficulty = {
  rating: number; // E2H `rating`, 0 = easiest, 1 = hardest across AMC 8 → AIME
  solvedPct: number | null; // E2H `item_difficulty`: percent of real students correct
  label: string; // the matched E2H item, e.g. "AMC10 10A 2015 #12"
  source: string; // our corpus row's contest and number, so targets need no query
  number: number | null;
};

const TABLE = table as Record<string, CorpusDifficulty>;

export function corpusDifficulty(id: string): CorpusDifficulty | null {
  return TABLE[id] ?? null;
}

export function corpusDifficultyCount(): number {
  return Object.keys(TABLE).length;
}

// Contest years whose difficulty defines a position's target. AMC 10 problems from
// 2010–2015 rate 0.007–0.018 below their position's median and 2016–2021 up to 0.015
// above it (#10–15: 0.222 for 2010–14 against 0.244 for 2015+), so "#12" means the
// modern contest. AMC 12 and AIME show no year trend; the floor is harmless there.
export const TARGET_SINCE_YEAR = 2015;

export function yearOf(d: CorpusDifficulty): number | null {
  const m = /\b(20\d\d|19\d\d)\b/.exec(d.label);
  return m ? Number(m[1]) : null;
}

// The human difficulty of a contest position: the median rating of rated corpus problems
// within ±1 of that number from TARGET_SINCE_YEAR on (any year when fewer than three).
// Null when nothing is rated nearby. This is what a slot aiming at "AMC10 #12" is
// judged against.
export function targetRating(source: string, number: number, sinceYear: number = TARGET_SINCE_YEAR): number | null {
  const at = (lo: number, hi: number, since: number) =>
    Object.values(TABLE)
      .filter((d) => d.source === source && d.number != null && d.number >= lo && d.number <= hi && (yearOf(d) ?? 0) >= since)
      .map((d) => d.rating)
      .sort((a, b) => a - b);
  // Always the ±1 window: from one contest era there are only 3–4 rated problems per
  // position, and a single position's median jumped around (#11 above #14).
  let pool = at(number - 1, number + 1, sinceYear);
  if (pool.length < 3) pool = at(number - 1, number + 1, 0);
  return pool.length ? pool[Math.floor(pool.length / 2)] : null;
}

// Rated corpus ids from any of `sources` whose human rating falls in [lo, hi]: the seeded
// slots' pool (seed-slots.ts). By rating rather than position, so a problem outside the
// band's positions that real students found as hard still qualifies.
export function idsInRatingWindow(sources: string[], lo: number, hi: number): { id: string; rating: number }[] {
  return Object.entries(TABLE)
    .filter(([, d]) => sources.includes(d.source) && d.rating >= lo && d.rating <= hi)
    .map(([id, d]) => ({ id, rating: d.rating }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// Rated corpus ids for one contest within a problem-number window: the judge's anchors.
export function ratedIds(source: string, lo: number, hi: number): { id: string; rating: number; number: number }[] {
  return Object.entries(TABLE)
    .filter(([, d]) => d.source === source && d.number != null && d.number >= lo && d.number <= hi)
    .map(([id, d]) => ({ id, rating: d.rating, number: d.number! }))
    .sort((a, b) => a.id.localeCompare(b.id));
}
