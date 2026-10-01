// Join Easy2Hard-Bench's human difficulty (E2H-AMC, NeurIPS 2024 D&B, CC-BY-SA 4.0)
// onto the ReferenceProblem corpus. E2H fits a 1PL IRT model to the PUBLISHED share of
// students who solved each AMC/AIME problem, so its `rating` is real human difficulty,
// where our `number` is only a position proxy that shifts year to year.
//
// Read-only against the database: the result is written to data/corpus-difficulty.json
// (keyed by ReferenceProblem id), not to a column, so it needs no migration and never
// writes to the shared corpus. Re-run after the corpus is re-ingested.
//
//   npm run join:e2h            # writes data/corpus-difficulty.json and prints coverage
//
// Matching: same contest and year, then the best whole-statement similarity
// (statementSimilarity, the dedup kernel), preferring the same problem number. Neither
// side's key is unique on its own (AMC 10A/10B and AIME I/II share numbers).
import { writeFileSync, mkdirSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { statementSimilarity } from "@/lib/generation/verifier";
import type { CorpusDifficulty } from "@/lib/generation/corpus-difficulty";

const BASE = "https://datasets-server.huggingface.co/rows";
const DATASET = "furonghuang-lab/Easy2Hard-Bench";

type E2HRow = { contest: string; tag: string; subtest: string; year: number; index: number; problem: string; rating: number; item_difficulty: number | null };

async function fetchSplit(split: string): Promise<E2HRow[]> {
  const out: E2HRow[] = [];
  for (let offset = 0; ; offset += 100) {
    const res = await fetch(`${BASE}?dataset=${encodeURIComponent(DATASET)}&config=E2H-AMC&split=${split}&offset=${offset}&length=100`);
    if (!res.ok) throw new Error(`E2H-AMC ${split} fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { rows: { row: E2HRow }[]; num_rows_total: number };
    out.push(...json.rows.map((r) => r.row));
    if (offset + 100 >= json.num_rows_total || json.rows.length === 0) break;
  }
  return out;
}

// Which E2H rows can be the same problem as a corpus row of this source.
const SOURCE_TAG: Record<string, (r: E2HRow) => boolean> = {
  AMC10: (r) => r.tag === "AMC10",
  AMC12: (r) => r.tag === "AMC12",
  AIME: (r) => r.contest === "AIME",
  AMC8: (r) => r.tag === "AMC8",
  "HMMT-Nov": (r) => r.tag === "HMMT-Nov",
  "HMMT-Feb": (r) => r.tag === "HMMT-Feb",
};

// Same number: a looser bar, since the position already agrees. Any number: the
// statement alone has to carry the match.
const SAME_NUMBER_MIN = 0.35;
const ANY_NUMBER_MIN = 0.6;

export function matchRow(
  ref: { source: string; year: number | null; number: number | null; statement: string },
  e2h: E2HRow[]
): { row: E2HRow; score: number } | null {
  const pool = e2h.filter((r) => SOURCE_TAG[ref.source]?.(r) && r.year === ref.year);
  let best: { row: E2HRow; score: number } | null = null;
  for (const r of pool) {
    const score = statementSimilarity(ref.statement, r.problem);
    const min = r.index === ref.number ? SAME_NUMBER_MIN : ANY_NUMBER_MIN;
    if (score >= min && (!best || score > best.score)) best = { row: r, score };
  }
  return best;
}

function spearman(xs: number[], ys: number[]): number {
  const rank = (v: number[]) => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(v.length);
    order.forEach(([, i], k) => (r[i] = k));
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const mean = (n - 1) / 2;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) {
    num += (rx[i] - mean) * (ry[i] - mean);
    dx += (rx[i] - mean) ** 2;
    dy += (ry[i] - mean) ** 2;
  }
  return num / Math.sqrt(dx * dy);
}

async function main() {
  const e2h = [...(await fetchSplit("train")), ...(await fetchSplit("eval"))];
  console.log(`E2H-AMC: ${e2h.length} rows (${e2h.filter((r) => r.contest === "AMC").length} AMC, ${e2h.filter((r) => r.contest === "AIME").length} AIME)`);
  const prisma = new PrismaClient();
  try {
    const refs = await prisma.referenceProblem.findMany({
      where: { source: { in: Object.keys(SOURCE_TAG) } },
      select: { id: true, source: true, year: true, number: true, statement: true },
    });
    const out: Record<string, CorpusDifficulty> = {};
    const bySource = new Map<string, { n: number; matched: number; numbers: number[]; ratings: number[] }>();
    for (const ref of refs) {
      const s = bySource.get(ref.source) ?? { n: 0, matched: 0, numbers: [], ratings: [] };
      s.n++;
      const m = matchRow(ref, e2h);
      if (m) {
        s.matched++;
        out[ref.id] = {
          rating: Number(m.row.rating.toFixed(4)),
          solvedPct: m.row.item_difficulty ?? null,
          label: `${m.row.tag} ${m.row.subtest} ${m.row.year} #${m.row.index}`,
          source: ref.source,
          number: ref.number,
        };
        if (ref.number != null) (s.numbers.push(ref.number), s.ratings.push(m.row.rating));
      }
      bySource.set(ref.source, s);
    }
    mkdirSync("data", { recursive: true });
    writeFileSync("data/corpus-difficulty.json", JSON.stringify(out, null, 0) + "\n");
    for (const [source, s] of bySource) {
      console.log(
        `${source}: matched ${s.matched}/${s.n}` +
          (s.numbers.length > 2 ? `; Spearman(problem number, human rating) = ${spearman(s.numbers, s.ratings).toFixed(2)}` : "")
      );
    }
    console.log(`Wrote data/corpus-difficulty.json (${Object.keys(out).length} rows).`);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[join:e2h]", e);
    process.exit(1);
  });
}
