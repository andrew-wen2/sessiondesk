import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Competition } from "@/lib/calibration";
import type { Anchor } from "@/lib/types";

// Retrieve real same-difficulty "anchor" problems from the ReferenceProblem
// corpus to calibrate generation. Difficulty = competition + problem-number band;
// category is a soft topic filter that we drop if it starves the result.
// Anchor is canonical in @/lib/types — callers import it from there directly.

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export async function getAnchors(opts: {
  competition: Competition;
  bandLow: number | null;
  bandHigh: number | null;
  category: string | null;
  count?: number;
}): Promise<Anchor[]> {
  const { competition, bandLow, bandHigh, category, count = 2 } = opts;
  const hasBand = bandLow != null && bandHigh != null;
  const bandWhere = hasBand ? { number: { gte: bandLow, lte: bandHigh } } : {};
  // Generation undershoots difficulty, so anchor it to the HARD end of the band:
  // pull from the upper half first (e.g. AIME 11–15 → 13–15, AMC 12–25 → 19–25),
  // then fall back to the full band so a sparse ceiling is never starved. Uniform
  // sampling across the whole band averaged the references to mid-band, which the
  // model then matched — leaving top-tier students' sets too easy.
  const ceilLow = hasBand ? bandLow + Math.ceil((bandHigh - bandLow) / 2) : null;
  const ceilWhere =
    hasBand && ceilLow != null ? { number: { gte: ceilLow, lte: bandHigh } } : {};
  // Prefer recent problems (2010 onward). `gte` also drops null years. This is a
  // soft preference: the recent-only tiers run first, then the same tiers WITHOUT
  // the recency filter as a fallback, so a source with sparse recent data is never
  // starved of anchors entirely. (The corpus is cleaned to 2010+, so this now
  // matches the kept range — see scripts/cleanup-corpus.ts.)
  const recentWhere = { year: { gte: 2010 } };

  // Hardest → easiest, most specific → least specific; recent-preferred first,
  // then any-year fallback. The upper-half (ceiling) tiers run ahead of the
  // full-band tiers so anchors come from the band's hard end whenever it has
  // enough rows. Stop once we have `count`.
  const tiers: Prisma.ReferenceProblemWhereInput[] = [];
  for (const yearWhere of [recentWhere, {}]) {
    if (hasBand && category) tiers.push({ source: competition, ...ceilWhere, ...yearWhere, category });
    if (hasBand) tiers.push({ source: competition, ...ceilWhere, ...yearWhere });
    if (hasBand && category) tiers.push({ source: competition, ...bandWhere, ...yearWhere, category });
    if (hasBand) tiers.push({ source: competition, ...bandWhere, ...yearWhere });
    if (category) tiers.push({ source: competition, ...yearWhere, category });
    tiers.push({ source: competition, ...yearWhere });
  }

  const seen = new Set<string>();
  // Also dedupe by normalized statement, not just id: the variant path anchors each
  // generated problem to a DISTINCT seed, so two corpus rows with identical text must
  // not both be picked (they'd yield duplicate variants).
  const seenStatements = new Set<string>();
  const normStatement = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const picked: Anchor[] = [];

  for (const where of tiers) {
    if (picked.length >= count) break;
    const rows = await prisma.referenceProblem.findMany({
      where,
      // `solution` feeds the adapt path (the model transforms the seed's real
      // solution instead of re-deriving). AIME/AMC are fully populated; F=ma is null.
      select: { id: true, source: true, number: true, statement: true, answer: true, solution: true },
      take: 200,
    });
    for (const r of shuffle(rows)) {
      if (picked.length >= count) break;
      if (seen.has(r.id)) continue;
      const key = normStatement(r.statement);
      if (seenStatements.has(key)) continue;
      seen.add(r.id);
      seenStatements.add(key);
      picked.push({
        source: r.source,
        number: r.number,
        statement: r.statement,
        answer: r.answer,
        solution: r.solution,
      });
    }
  }
  return picked;
}
