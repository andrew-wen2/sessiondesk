// Import Easy2Hard-Bench's contest problems (E2H-AMC, NeurIPS 2024 D&B, CC-BY-SA 4.0)
// into the ReferenceProblem corpus. Every E2H row carries the statement, the answer, a
// worked solution and a human difficulty rating fitted to real students' solve rates,
// which is what seeded slots and targets run on (docs/designs/generation-research.md).
// Before this, only the 670 corpus problems E2H happened to match were rated; E2H also
// holds ~550 more 2010+ AMC 10/12 problems, 31 more AIME, and all of AMC 8 and HMMT.
//
// Steps:
//   1. Download every E2H-AMC row (both splits) to runs/e2h-amc.json (cached).
//   2. Plan: keep AMC 8/10/12, AIME and HMMT rows from 2010 on (--all-years keeps
//      earlier ones; the corpus is kept 2010+ and scripts/cleanup-corpus.ts deletes
//      older rows), and drop any row already in the corpus: its label is in
//      data/corpus-difficulty.json, or its statement matches a corpus row of the same
//      contest and year (join-e2h.ts's matchRow thresholds).
//   3. With --write, upsert the rest with deterministic ids, so a re-run changes nothing.
//
// Without --write it only reports what it would do. After --write, run `npm run
// join:e2h` to rate the new rows, then `npm run extract:taxonomy -- --yes --assign-new`
// to give them problem types.
//
//   npm run ingest:e2h [-- --write] [--all-years]
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { PrismaClient } from "@prisma/client";
import { statementSimilarity } from "@/lib/generation/verifier";

const BASE = "https://datasets-server.huggingface.co";
const DATASET = "furonghuang-lab/Easy2Hard-Bench";
const CACHE = "runs/e2h-amc.json";

export type E2HRow = {
  contest: string;
  tag: string;
  subtest: string;
  year: number;
  index: number;
  problem: string;
  answer: string | null;
  solution: string | null;
  rating: number;
};

// E2H tag → corpus `source`. HMMT's two tournaments differ a lot in difficulty, so they
// stay separate sources. HMMT numbers problems within a round (guts, team, algebra...),
// so its `number` is a label, not a difficulty position; its rating carries difficulty.
export const SOURCE_FOR_TAG: Record<string, string> = {
  AMC8: "AMC8",
  AMC10: "AMC10",
  AMC12: "AMC12",
  AIME: "AIME",
  "HMMT-Nov": "HMMT-Nov",
  "HMMT-Feb": "HMMT-Feb",
};

// HMMT subject rounds name their area; everything else is left for the taxonomy labels.
const CATEGORY_FOR_SUBTEST: Record<string, string> = { alg: "algebra", comb: "combinatorics", geo: "geometry" };

export const e2hLabel = (r: Pick<E2HRow, "tag" | "subtest" | "year" | "index">) => `${r.tag} ${r.subtest} ${r.year} #${r.index}`;
const hash = (...parts: (string | number)[]) => createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
// The id by contest, test, year and number alone. Not unique: 2021 had a spring and a
// fall AMC and E2H labels both "10B 2021", so 56 rows share a label with a different
// problem. The first --write keyed on this and each fall problem overwrote its twin.
export const e2hId = (r: Pick<E2HRow, "tag" | "subtest" | "year" | "index">) => hash("e2h", r.tag, r.subtest, r.year, r.index);

// The id a row is stored under: the label id when the label is unique in E2H, else one
// that also hashes the statement, so twins sharing a label stay separate rows.
export function idsFor(rows: E2HRow[]): { idOf: (r: E2HRow) => string; shared: Set<string> } {
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(e2hLabel(r), (counts.get(e2hLabel(r)) ?? 0) + 1);
  const shared = new Set([...counts].filter(([, n]) => n > 1).map(([label]) => label));
  return { idOf: (r) => (shared.has(e2hLabel(r)) ? hash("e2h", r.tag, r.subtest, r.year, r.index, r.problem.trim().slice(0, 300)) : e2hId(r)), shared };
}

// Same contest and year, then statement similarity (join-e2h.ts's bars: looser when the
// problem number agrees). Returns the corpus row this E2H row duplicates, if any.
export function duplicateOf(
  row: E2HRow,
  corpus: { id: string; source: string; year: number | null; number: number | null; statement: string }[]
): string | null {
  const source = SOURCE_FOR_TAG[row.tag];
  for (const c of corpus) {
    if (c.source !== source || c.year !== row.year) continue;
    const score = statementSimilarity(c.statement, row.problem);
    if (score >= (c.number === row.index ? 0.35 : 0.6)) return c.id;
  }
  return null;
}

async function download(): Promise<E2HRow[]> {
  if (existsSync(CACHE)) return JSON.parse(readFileSync(CACHE, "utf8")) as E2HRow[];
  const out: E2HRow[] = [];
  for (const split of ["train", "eval"]) {
    for (let offset = 0; ; offset += 100) {
      const res = await fetch(`${BASE}/rows?dataset=${encodeURIComponent(DATASET)}&config=E2H-AMC&split=${split}&offset=${offset}&length=100`);
      if (!res.ok) throw new Error(`E2H-AMC ${split} fetch failed: HTTP ${res.status}`);
      const json = (await res.json()) as { rows: { row: E2HRow }[]; num_rows_total: number };
      out.push(...json.rows.map((r) => r.row));
      if (offset + 100 >= json.num_rows_total || json.rows.length === 0) break;
    }
  }
  mkdirSync("runs", { recursive: true });
  writeFileSync(CACHE, JSON.stringify(out));
  return out;
}

async function main() {
  const argv = process.argv.slice(2);
  const write = argv.includes("--write");
  const allYears = argv.includes("--all-years");
  const e2h = await download();
  console.log(`E2H-AMC: ${e2h.length} rows, saved in ${CACHE}`);

  const { idOf, shared } = idsFor(e2h);
  const prisma = new PrismaClient();
  try {
    const corpus = await prisma.referenceProblem.findMany({ select: { id: true, source: true, year: true, number: true, statement: true } });
    const existingIds = new Set(corpus.map((c) => c.id));
    // Rows the first --write stored under a shared label's id: each holds whichever twin
    // was written last. Only this script ever creates e2hId ids, so they are removed and
    // both twins re-imported under their own ids.
    const collided = [...new Set(e2h.filter((r) => shared.has(e2hLabel(r))).map(e2hId))].filter((id) => existingIds.has(id));
    // Duplicates are judged only against rows that were in the corpus before any E2H
    // import; rows this script created are recognised by id instead.
    const e2hIds = new Set(e2h.flatMap((r) => [e2hId(r), idOf(r)]));
    const original = corpus.filter((c) => !e2hIds.has(c.id));
    const report = new Map<string, { total: number; oldYears: number; imported: number; inCorpus: number; missingText: number; add: number }>();
    const toAdd: E2HRow[] = [];
    for (const r of e2h) {
      const source = SOURCE_FOR_TAG[r.tag];
      if (!source) continue;
      const s = report.get(source) ?? { total: 0, oldYears: 0, imported: 0, inCorpus: 0, missingText: 0, add: 0 };
      s.total++;
      if (!allYears && r.year < 2010) s.oldYears++;
      else if (!r.problem?.trim() || !String(r.answer ?? "").trim()) s.missingText++;
      else if (existingIds.has(idOf(r))) s.imported++;
      else if (duplicateOf(r, original)) s.inCorpus++;
      else {
        s.add++;
        toAdd.push(r);
      }
      report.set(source, s);
    }
    for (const [source, s] of report) {
      console.log(`${source.padEnd(9)} ${String(s.total).padStart(4)} rows: ${s.add} to import, ${s.imported} already imported, ${s.inCorpus} already in the corpus, ${s.oldYears} before 2010 (skipped), ${s.missingText} without text or answer`);
    }
    console.log(`${toAdd.length} new rows to import${collided.length ? `; ${collided.length} rows stored under a shared label's id to replace` : ""}.`);
    if (!write) {
      console.log("Report only. Re-run with --write to insert them.");
      return;
    }
    if (collided.length) {
      const { count } = await prisma.referenceProblem.deleteMany({ where: { id: { in: collided } } });
      console.log(`Removed ${count} rows stored under a shared label's id.`);
    }
    const CONC = 12;
    for (let i = 0; i < toAdd.length; i += CONC) {
      await Promise.all(
        toAdd.slice(i, i + CONC).map((r) => {
          const data = {
            source: SOURCE_FOR_TAG[r.tag],
            year: r.year,
            number: r.index,
            category: CATEGORY_FOR_SUBTEST[r.subtest] ?? null,
            statement: r.problem,
            answer: String(r.answer).trim(),
            solution: r.solution?.trim() || null,
          };
          return prisma.referenceProblem.upsert({ where: { id: idOf(r) }, create: { id: idOf(r), ...data }, update: data });
        })
      );
    }
    const bySource = await prisma.referenceProblem.groupBy({ by: ["source"], _count: true });
    console.log(`Inserted ${toAdd.length}. Corpus by source: ${bySource.map((b) => `${b.source}=${b._count}`).join(", ")}`);
    console.log("Next: npm run join:e2h, then npm run extract:taxonomy -- --yes --assign-new");
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => {
    console.error("[ingest:e2h]", e);
    process.exit(1);
  });
}
