// Ingest real competition problems into the ReferenceProblem corpus, used to
// retrieve same-difficulty "anchor" examples for generation calibration.
//
// Sources (HuggingFace datasets-server JSON API — no `datasets` lib needed):
//   - AIME:  gneubig/aime-1983-2024        (933, Year + Problem Number + Answer)
//   - AMC#:  AI-MO/aimo-validation-amc     (83, year/contest/number parsed from AoPS url)
//   - AMC:   kaggle-aimo/amc_filtered      (1081, year+number parsed from the `id` AoPS path)
// F=ma is sourced separately (AAPT PDFs) — see scripts/README.md.
//
// Idempotent: each row gets a deterministic id, so re-running upserts in place.
//
// Run: npm run ingest:corpus

import { createHash } from "crypto";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const BASE = "https://datasets-server.huggingface.co/rows";

type Row = Record<string, unknown>;

async function fetchAllRows(dataset: string, config = "default", split = "train"): Promise<Row[]> {
  const out: Row[] = [];
  let offset = 0;
  const length = 100;
  // First call to learn the total.
  for (;;) {
    const url = `${BASE}?dataset=${encodeURIComponent(dataset)}&config=${config}&split=${split}&offset=${offset}&length=${length}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${dataset} fetch failed: HTTP ${res.status}`);
    const json = (await res.json()) as { rows: { row: Row }[]; num_rows_total: number };
    out.push(...json.rows.map((r) => r.row));
    offset += length;
    if (offset >= json.num_rows_total || json.rows.length === 0) break;
  }
  return out;
}

function hid(...parts: (string | number | null | undefined)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
}

function deriveCategory(statement: string): string | null {
  const s = statement.toLowerCase();
  if (/triangle|circle|\bangle|polygon|\barea\b|perimeter|radius|tangent|parallel|perpendicular|hexagon|rectangle|\bquadrilateral|vertices|vertex|isosceles|circumscrib|inscrib/.test(s))
    return "geometry";
  if (/how many ways|number of ways|probability|permutation|combination|arrange|distinct ways|ways (can|to)|\bsubsets?\b|count the number/.test(s))
    return "combinatorics";
  if (/divisor|\bprime\b|modulo|remainder|\bdigits?\b|\bgcd\b|\blcm\b|divisible|congruen|\bbase[- ]?\d|integer solutions|relatively prime/.test(s))
    return "number_theory";
  if (/polynomial|\bequation|\broots?\b|function|f\(x\)|logarithm|\blog_|exponent|sequence|\bseries\b|arithmetic|geometric progression/.test(s))
    return "algebra";
  return null;
}

type Ref = {
  id: string;
  source: string;
  year: number | null;
  number: number | null;
  category: string | null;
  statement: string;
  answer: string | null;
};

function str(v: unknown): string {
  return v == null ? "" : String(v);
}

async function adapterAIME(): Promise<Ref[]> {
  const rows = await fetchAllRows("gneubig/aime-1983-2024");
  return rows
    .map((r): Ref | null => {
      const statement = str(r["Question"]);
      if (!statement) return null;
      const year = Number(r["Year"]) || null;
      const number = Number(r["Problem Number"]) || null;
      const part = str(r["Part"]); // "I"/"II" for 2000+, distinguishes the two exams
      return {
        id: hid("AIME", year, part, number, statement.slice(0, 40)),
        source: "AIME",
        year,
        number,
        category: deriveCategory(statement),
        statement,
        answer: str(r["Answer"]) || null,
      };
    })
    .filter((x): x is Ref => x !== null);
}

async function adapterAMCNumbered(): Promise<Ref[]> {
  const rows = await fetchAllRows("AI-MO/aimo-validation-amc");
  const re = /(\d{4})_AMC_(\d{2})[AB]?_Problems\/Problem_(\d+)/;
  return rows
    .map((r): Ref | null => {
      const statement = str(r["problem"]);
      const url = str(r["url"]);
      if (!statement) return null;
      const m = re.exec(url);
      const year = m ? Number(m[1]) : null;
      const source = m ? `AMC${m[2]}` : "AMC10";
      const number = m ? Number(m[3]) : null;
      return {
        id: hid("amcval", url || statement.slice(0, 60)),
        source,
        year,
        number,
        category: deriveCategory(statement),
        statement,
        answer: str(r["answer"]) || null,
      };
    })
    .filter((x): x is Ref => x !== null);
}

async function adapterAMCFiltered(): Promise<Ref[]> {
  const rows = await fetchAllRows("kaggle-aimo/amc_filtered");
  // The dataset's `id` is the AoPS path, e.g. "2023_AMC_10A_Problems/Problem_1",
  // which carries the year, contest (10/12), and problem number — the difficulty
  // proxy retrieval bands on. Parse it (same shape adapterAMCNumbered parses from
  // `url`); fall back to amc_level with no number only when it doesn't match.
  const re = /(\d{4})_AMC_(\d{2})[AB]?_Problems\/Problem_(\d+)/;
  return rows
    .map((r): Ref | null => {
      const statement = str(r["task"]);
      if (!statement) return null;
      const m = re.exec(str(r["id"]));
      const source = m ? `AMC${m[2]}` : str(r["amc_level"]).replace(/_/g, ""); // "AMC_10" → "AMC10"
      if (source !== "AMC10" && source !== "AMC12") return null;
      return {
        id: hid("amcfiltered", statement.slice(0, 200)),
        source,
        year: m ? Number(m[1]) : null,
        number: m ? Number(m[3]) : null,
        category: deriveCategory(statement),
        statement,
        answer: str(r["answer"]) || null,
      };
    })
    .filter((x): x is Ref => x !== null);
}

async function upsertAll(refs: Ref[]) {
  let done = 0;
  const CONC = 12;
  for (let i = 0; i < refs.length; i += CONC) {
    const batch = refs.slice(i, i + CONC);
    await Promise.all(
      batch.map((p) =>
        prisma.referenceProblem.upsert({
          where: { id: p.id },
          create: p,
          update: {
            source: p.source,
            year: p.year,
            number: p.number,
            category: p.category,
            statement: p.statement,
            answer: p.answer,
          },
        })
      )
    );
    done += batch.length;
  }
  return done;
}

async function main() {
  console.log("Fetching sources…");
  const [aime, amcNum, amcLevel] = await Promise.all([
    adapterAIME(),
    adapterAMCNumbered(),
    adapterAMCFiltered(),
  ]);
  console.log(`  AIME: ${aime.length}, AMC(numbered): ${amcNum.length}, AMC(level): ${amcLevel.length}`);

  const raw = [...aime, ...amcNum, ...amcLevel];
  // Drop parse failures (null year/number → no difficulty-band signal for
  // retrieval) and pre-2010 problems (stylistically dated). Keeps re-ingests
  // consistent with scripts/cleanup-corpus.ts so old/broken rows never return.
  const all = raw.filter((r) => r.year != null && r.number != null && r.year >= 2010);
  console.log(`Upserting ${all.length} reference problems (dropped ${raw.length - all.length} null/pre-2010)…`);
  const n = await upsertAll(all);

  const bySource = await prisma.referenceProblem.groupBy({ by: ["source"], _count: true });
  console.log("Done. Corpus by source:");
  for (const s of bySource) console.log(`  ${s.source}: ${s._count}`);
  console.log(`Total upserted this run: ${n}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
