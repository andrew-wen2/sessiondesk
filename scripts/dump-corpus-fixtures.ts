// One-time export: sample ReferenceProblem rows with verified answers into a
// committed fixture file, so scripts/eval-solver.ts can validate the independent
// solver's accuracy WITHOUT connecting to the live database on every run.
//
// Why this exists (Eng S3): scripts here construct their own PrismaClient against
// DATABASE_URL, which is hosted production Neon — CLAUDE.md states there is no
// local DB. An eval that reads ReferenceProblem on every invocation is an eval
// connected to production on every invocation. Dumping once removes that.
//
// F=ma is excluded — its `answer` column is null by design (no answer key exists
// in the source AAPT PDFs), so it can't serve as ground truth for a solver check.
// Usable ground truth is AIME + AMC10 + AMC12: ~1,180 rows, not the ~1,480 the
// corpus holds in total (a correction made during Eng review of this plan).
//
// Standalone Node process (outside Next) → constructs its own PrismaClient, per
// the scripts/ exception in CLAUDE.md. Read-only.
//
//   npx tsx scripts/dump-corpus-fixtures.ts [--count 60]

import { PrismaClient } from "@prisma/client";
import { writeFileSync } from "node:fs";
import path from "node:path";

const prisma = new PrismaClient();

function shuffle<T>(a: T[]): T[] {
  const out = [...a];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

async function main() {
  const countArg = process.argv.indexOf("--count");
  const count = countArg !== -1 ? Number(process.argv[countArg + 1]) || 60 : 60;
  const perSource = Math.ceil(count / 3);

  const out: {
    id: string;
    source: string;
    number: number | null;
    statement: string;
    answer: string;
  }[] = [];

  for (const source of ["AIME", "AMC10", "AMC12"] as const) {
    const rows = await prisma.referenceProblem.findMany({
      where: { source, answer: { not: null } },
      select: { id: true, source: true, number: true, statement: true, answer: true },
      take: 500,
    });
    const sample = shuffle(rows).slice(0, perSource);
    for (const r of sample) {
      if (!r.answer) continue; // narrows the type; the where clause already excludes these
      out.push({ id: r.id, source: r.source, number: r.number, statement: r.statement, answer: r.answer });
    }
    console.log(`${source}: sampled ${sample.length}/${rows.length}`);
  }

  const outPath = path.join(__dirname, "eval-fixtures", "corpus-sample.json");
  writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n");
  console.log(`Wrote ${out.length} rows to ${outPath}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
