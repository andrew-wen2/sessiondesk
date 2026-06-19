// One-time cleanup of the ReferenceProblem corpus.
//
// Removes two classes of low-quality rows:
//   - year < 2010              → stylistically dated; retrieval prefers recent.
//   - year == null OR number == null → AMC rows where the ingest regex failed to
//     parse the source path. Null `number` means no difficulty-band signal, so
//     they only ever match the broad source/category fallback tiers — drop them.
//
// The ingest scripts now apply the same guard at write time (see
// scripts/ingest-corpus.ts), so re-running ingestion won't bring these back.
//
// Run: npm run cleanup:corpus

import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function snapshot(label: string) {
  const total = await prisma.referenceProblem.count();
  const bySource = await prisma.referenceProblem.groupBy({ by: ["source"], _count: { _all: true } });
  const nullYear = await prisma.referenceProblem.count({ where: { year: null } });
  const nullNumber = await prisma.referenceProblem.count({ where: { number: null } });
  const pre2010 = await prisma.referenceProblem.count({ where: { year: { lt: 2010 } } });
  console.log(`\n${label}: total=${total}`);
  for (const s of bySource) console.log(`  ${s.source}: ${s._count._all}`);
  console.log(`  nullYear=${nullYear} nullNumber=${nullNumber} pre2010=${pre2010}`);
}

async function main() {
  await snapshot("Before");

  const { count } = await prisma.referenceProblem.deleteMany({
    where: { OR: [{ year: { lt: 2010 } }, { year: null }, { number: null }] },
  });
  console.log(`\nDeleted ${count} rows (pre-2010 + null year/number).`);

  await snapshot("After");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
