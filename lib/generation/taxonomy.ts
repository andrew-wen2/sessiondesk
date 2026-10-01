// The corpus problem-type taxonomy (built offline by scripts/extract-taxonomy.ts into
// data/corpus-taxonomy.json) and the pure slot sampler over it.
//
// Why sample slots in code: the per-request type menu (problem-types.ts) listed types
// fresh each time, so "types this student already did" was an LLM's judgment, and two
// sets' types weren't comparable. Here every type has a fixed id, a real frequency at
// each problem number, and exclusion is an exact match against the types recent sets
// used (recorded in genMeta). Published pipelines do the same (KPDDS, MATH²,
// AttrPrompt: attribute sampling in code beat "be diverse" prompts at ~5% of the cost).
import table from "@/data/corpus-taxonomy.json";
import { stableHash } from "@/lib/generation/cascade/targets";

export type TaxonomyType = {
  id: string; // "algebra:3"
  name: string; // "word problem reduced to one quadratic equation"
  category: string;
  count: number; // corpus problems of this type
  numbers: Record<string, number[]>; // contest → problem numbers of this type
  methods: string[]; // up to three example solution methods (no numbers)
};
export type Taxonomy = {
  builtAt: string;
  labeler: string;
  clusterer: string;
  types: TaxonomyType[];
  problemTypes: Record<string, string>; // ReferenceProblem id → type id
};

const TAXONOMY = table as unknown as Partial<Taxonomy>;

export function taxonomyTypes(): TaxonomyType[] {
  return TAXONOMY.types ?? [];
}

// A corpus problem's type id, or undefined when the taxonomy didn't label it.
export function typeIdOf(problemId: string): string | undefined {
  return TAXONOMY.problemTypes?.[problemId];
}

// How typical a type is near a target band of one contest: occurrences within ±2 of
// the band, plus a small floor so a type the topic calls for but the band rarely shows
// can still be drawn.
export function bandWeight(t: TaxonomyType, competition: string | null, bandLow: number | null, bandHigh: number | null): number {
  if (!competition || bandLow == null || bandHigh == null) return 1 + t.count / 10;
  const nums = t.numbers[competition] ?? [];
  const near = nums.filter((n) => n >= bandLow - 2 && n <= bandHigh + 2).length;
  return 0.25 + near;
}

// Pick `count` slot types from the candidates (already filtered to today's topic):
// never a type a recent set used unless nothing else is left, each drawn once, and
// weighted by how typical it is at the band. Deterministic per rotation key (a seeded
// weighted draw without replacement), so a rerun of the same attempt reproduces.
export function sampleSlotTypes(args: {
  candidates: TaxonomyType[];
  count: number;
  recentTypeIds: string[];
  competition: string | null;
  bandLow: number | null;
  bandHigh: number | null;
  rotationKey: string;
}): TaxonomyType[] {
  const recent = new Set(args.recentTypeIds);
  const fresh = args.candidates.filter((t) => !recent.has(t.id));
  const stale = args.candidates.filter((t) => recent.has(t.id));
  const draw = (pool: TaxonomyType[], k: number, salt: string): TaxonomyType[] => {
    // Efraimidis–Spirakis: key = u^(1/w), take the k largest. u from a stable hash.
    return pool
      .map((t) => {
        const u = (stableHash(`${args.rotationKey}|${salt}|${t.id}`) + 1) / 4294967297;
        return { t, key: Math.log(u) / bandWeight(t, args.competition, args.bandLow, args.bandHigh) };
      })
      .sort((a, b) => b.key - a.key)
      .slice(0, k)
      .map((x) => x.t);
  };
  const picked = draw(fresh, args.count, "fresh");
  return picked.length >= args.count ? picked : [...picked, ...draw(stale, args.count - picked.length, "stale")];
}
