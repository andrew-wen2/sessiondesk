import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import type { Competition } from "@/lib/calibration";

// Retrieve real same-difficulty "anchor" problems from the ReferenceProblem
// corpus to calibrate generation. Difficulty = competition + problem-number band;
// category is a soft topic filter that we drop if it starves the result.

export type Anchor = {
  source: string;
  number: number | null;
  statement: string;
  answer: string | null;
};

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
  // Prefer recent problems (2010 onward). `gte` also drops null years. This is a
  // soft preference: the recent-only tiers run first, then the same tiers WITHOUT
  // the recency filter as a fallback, so a source with sparse recent data is never
  // starved of anchors entirely. (The corpus is cleaned to 2010+, so this now
  // matches the kept range — see scripts/cleanup-corpus.ts.)
  const recentWhere = { year: { gte: 2010 } };

  // Most specific → least specific; recent-preferred first, then any-year fallback.
  // Stop once we have `count`.
  const tiers: Prisma.ReferenceProblemWhereInput[] = [];
  for (const yearWhere of [recentWhere, {}]) {
    if (hasBand && category) tiers.push({ source: competition, ...bandWhere, ...yearWhere, category });
    if (hasBand) tiers.push({ source: competition, ...bandWhere, ...yearWhere });
    if (category) tiers.push({ source: competition, ...yearWhere, category });
    tiers.push({ source: competition, ...yearWhere });
  }

  const seen = new Set<string>();
  const picked: Anchor[] = [];

  for (const where of tiers) {
    if (picked.length >= count) break;
    const rows = await prisma.referenceProblem.findMany({
      where,
      select: { id: true, source: true, number: true, statement: true, answer: true },
      take: 200,
    });
    for (const r of shuffle(rows)) {
      if (picked.length >= count) break;
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      picked.push({ source: r.source, number: r.number, statement: r.statement, answer: r.answer });
    }
  }
  return picked;
}
