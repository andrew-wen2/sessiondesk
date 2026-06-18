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
  // Anchor only on recent problems (post-2010). `gt` also drops null years,
  // which is intended: an unknown year can't be guaranteed to be after 2010.
  const recentWhere = { year: { gt: 2010 } };

  // Most specific → least specific. Stop once we have `count`.
  const tiers: Prisma.ReferenceProblemWhereInput[] = [];
  if (hasBand && category) tiers.push({ source: competition, ...bandWhere, ...recentWhere, category });
  if (hasBand) tiers.push({ source: competition, ...bandWhere, ...recentWhere });
  if (category) tiers.push({ source: competition, ...recentWhere, category });
  tiers.push({ source: competition, ...recentWhere });

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
