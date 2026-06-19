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

// Confirmed-reachable AAPT F=ma problems-only exam PDFs (each HTTP 200 verified).
// 2010–2025. From 2018 on (and 2020/2022) AAPT runs two versions per year (A/B);
// the `variant` keeps their ids distinct since both number 1–25. Pre-2010 exams
// exist but are intentionally excluded (corpus is cleaned to 2010+).
const SOURCES: { year: number; variant?: string; url: string }[] = [
  { year: 2010, url: "https://www.aapt.org/physicsteam/2010/upload/2010_Fma.pdf" },
  { year: 2011, url: "https://www.aapt.org/physicsteam/2012/upload/WebAssign-exam1-2011-1-4.pdf" },
  { year: 2012, url: "https://www.aapt.org/physicsteam/2013/upload/exam1-2012-unlocked.pdf" },
  { year: 2013, url: "https://www.aapt.org/physicsteam/2014/upload/exam1-2013-1-6-unlocked.pdf" },
  { year: 2014, url: "https://www.aapt.org/physicsteam/2015/upload/exam1-2014-2-2.pdf" },
  { year: 2015, url: "https://www.aapt.org/physicsteam/2015/upload/exam1-2015-1-8.pdf" },
  { year: 2016, url: "https://www.aapt.org/physicsteam/2016/upload/exam1-2016-3-1-2.pdf" },
  { year: 2017, url: "https://www.aapt.org/physicsteam/2018/upload/2017-Fma-exam.pdf" },
  { year: 2018, variant: "A", url: "https://www.aapt.org/physicsteam/2019/upload/Fma-2018-A.pdf" },
  { year: 2018, variant: "B", url: "https://www.aapt.org/physicsteam/2019/upload/Fma-2018-B.pdf" },
  { year: 2019, variant: "A", url: "https://www.aapt.org/physicsteam/2020/upload/2019_Fma_A.pdf" },
  { year: 2019, variant: "B", url: "https://www.aapt.org/physicsteam/2020/upload/2019_Fma_B.pdf" },
  { year: 2020, variant: "A", url: "https://www.aapt.org/physicsteam/upload/2020_Fma_A_v2.pdf" },
  { year: 2020, variant: "B", url: "https://www.aapt.org/physicsteam/upload/2020_Fma_B.pdf" },
  { year: 2021, url: "https://aapt.org/physicsteam/upload/F-ma-2021.pdf" },
  { year: 2022, variant: "A", url: "https://www.aapt.org/physicsteam/upload/2022_Fma_Exam_A-2.pdf" },
  { year: 2022, variant: "B", url: "https://www.aapt.org/physicsteam/upload/2022_Fma_Exam_B.pdf" },
  { year: 2023, url: "https://aapt.org/physicsteam/upload/2023_F-ma_Exam.pdf" },
  { year: 2024, url: "https://aapt.org/physicsteam/upload/2024_F-ma_Exam.pdf" },
  { year: 2025, url: "https://www.aapt.org/physicsteam/upload/FMA-exam.pdf" },
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
  for (const { year, variant, url } of SOURCES) {
    const label = `${year}${variant ? variant : ""}`;
    const problems = await extractProblems(year, url);
    for (const p of problems) {
      // Variant-less years keep the original id shape (hid("fma", year, number))
      // so re-runs update in place; A/B exams add the variant to stay distinct.
      const id = variant ? hid("fma", year, variant, p.number) : hid("fma", year, p.number);
      await prisma.referenceProblem.upsert({
        where: { id },
        create: {
          id,
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
    console.log(`  ${label}: ${problems.length} text-only problems ingested`);
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
