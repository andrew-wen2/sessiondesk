// Ingest F=ma problems into the ReferenceProblem corpus from AAPT exam PDFs.
//
// F=ma has no clean dataset, so we extract from the official AAPT problems-only
// exam PDFs. Caveats handled here:
//   - Many F=ma problems depend on a figure that doesn't survive PDF→text — we
//     drop those (keyword filter); the rest are self-contained text problems.
//   - The exam PDFs are problems-only (no answer key), so `answer` is null.
//     That's fine: anchors convey *difficulty* via the statement + problem number.
//
// Run: npm run ingest:fma

import { createHash } from "crypto";
import { PDFParse } from "pdf-parse";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Confirmed-reachable AAPT F=ma problems-only exam PDFs.
const SOURCES: { year: number; url: string }[] = [
  { year: 2024, url: "https://aapt.org/physicsteam/upload/2024_F-ma_Exam.pdf" },
  { year: 2023, url: "https://aapt.org/physicsteam/upload/2023_F-ma_Exam.pdf" },
  { year: 2021, url: "https://aapt.org/physicsteam/upload/F-ma-2021.pdf" },
  { year: 2010, url: "https://www.aapt.org/physicsteam/2010/upload/2010_Fma.pdf" },
  { year: 2009, url: "https://www.aapt.org/physicsteam/2010/upload/2009_F-ma.pdf" },
];

const FIGURE = /\b(shown|figure|diagram|graph|as shown|following shows|depicted|below|above|picture|sketch|in the diagram|pictured)\b/i;

function hid(...parts: (string | number)[]): string {
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 24);
}

async function extractProblems(year: number, url: string) {
  const res = await fetch(url);
  if (!res.ok) {
    console.log(`  ${year}: download failed (HTTP ${res.status}) — skipped`);
    return [];
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const parsed = await new PDFParse({ data: buf }).getText();
  const text = parsed.text
    .replace(/Copyright[^\n]*American Association of Physics Teachers/g, "")
    .replace(/\d{4} F ?= ?ma Exam ?\d*/g, "")
    .replace(/Do not (open|distribute)[^\n]*/gi, "");

  const blocks = [...text.matchAll(/\n(\d{1,2})\.\s([\s\S]*?)(?=\n\d{1,2}\.\s|$)/g)];
  const out: { number: number; statement: string }[] = [];
  for (const b of blocks) {
    const number = Number(b[1]);
    const statement = b[2].replace(/\s+/g, " ").trim();
    if (number < 1 || number > 25) continue;
    if (statement.length < 60 || statement.length > 1500) continue;
    if (FIGURE.test(statement)) continue; // figure-dependent → unusable as text anchor
    out.push({ number, statement });
  }
  return out;
}

async function main() {
  let total = 0;
  for (const { year, url } of SOURCES) {
    const problems = await extractProblems(year, url);
    for (const p of problems) {
      await prisma.referenceProblem.upsert({
        where: { id: hid("fma", year, p.number) },
        create: {
          id: hid("fma", year, p.number),
          source: "Fma",
          year,
          number: p.number,
          category: "mechanics",
          statement: p.statement,
          answer: null,
        },
        update: { statement: p.statement, category: "mechanics" },
      });
    }
    console.log(`  ${year}: ${problems.length} text-only problems ingested`);
    total += problems.length;
  }

  const count = await prisma.referenceProblem.count({ where: { source: "Fma" } });
  console.log(`Done. F=ma corpus now: ${count} (this run added/updated ${total}).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
