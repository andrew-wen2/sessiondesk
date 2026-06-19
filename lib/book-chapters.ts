// Shared helper for the Books chapter table. The table shows only chapter titles;
// the section/concept detail stays in Book.chapters / Book.contents but is never
// displayed. Used by the server page (from the DB row) and by BookDetail (from the
// parse-pdf response), so it lives in a plain module with no client-only imports.

export type DisplayChapter = { number: string; title: string };

// Reduce a structured chapter outline — or a legacy `contents` text blob from a
// book parsed before the structured column existed — to its chapter titles.
export function toDisplayChapters(chapters: unknown, contents = ""): DisplayChapter[] {
  if (Array.isArray(chapters)) {
    return chapters
      .map((c) => {
        const obj = (c ?? {}) as { number?: unknown; title?: unknown };
        return {
          number: typeof obj.number === "string" ? obj.number : "",
          title: typeof obj.title === "string" ? obj.title : "",
        };
      })
      .filter((c) => c.title);
  }
  // Legacy fallback: chapter head lines are the non-indented lines of contents
  // ("Ch 3: Number Theory"); indented section lines are skipped.
  return contents
    .split("\n")
    .filter((line) => line.trim() && !/^\s/.test(line))
    .map((line) => {
      const m = line.match(/^Ch\s+([^:]+):\s*(.+)$/);
      return m
        ? { number: m[1].trim(), title: m[2].trim() }
        : { number: "", title: line.trim() };
    });
}

// The structured outline stored in Book.chapters (one entry per chapter).
export type BookSection = { number: string; title: string; concepts: string };
export type BookChapter = { number: string; title: string; sections: BookSection[] };

// Render a chapter outline into the indented text the generator reads:
//   Ch 3: Number Theory
//     3.1 Divisibility — gcd, division algorithm, Bezout
//     3.2 Primes — sieve, fundamental theorem of arithmetic
// Shared by the PDF-parse route (full outline) and selectBookContents (a subset).
export function formatChapters(chapters: BookChapter[]): string {
  return chapters
    .map((c) => {
      const head = c.number ? `Ch ${c.number}: ${c.title}` : c.title;
      const lines = [head];
      for (const s of c.sections) {
        const sh = s.number ? `  ${s.number} ${s.title}` : `  ${s.title}`;
        lines.push(s.concepts ? `${sh} — ${s.concepts}` : sh);
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

// Normalize the untyped Book.chapters JSON into typed chapters, or null if it
// isn't a usable structured outline (legacy contents-only books).
function parseChapters(chapters: unknown): BookChapter[] | null {
  if (!Array.isArray(chapters)) return null;
  const out: BookChapter[] = [];
  for (const c of chapters) {
    const obj = (c ?? {}) as { number?: unknown; title?: unknown; sections?: unknown };
    if (typeof obj.title !== "string") continue;
    const sections: BookSection[] = Array.isArray(obj.sections)
      ? obj.sections
          .map((s) => {
            const so = (s ?? {}) as { number?: unknown; title?: unknown; concepts?: unknown };
            return {
              number: typeof so.number === "string" ? so.number : "",
              title: typeof so.title === "string" ? so.title : "",
              concepts: typeof so.concepts === "string" ? so.concepts : "",
            };
          })
          .filter((s) => s.title)
      : [];
    out.push({ number: typeof obj.number === "string" ? obj.number : "", title: obj.title, sections });
  }
  return out.length ? out : null;
}

// Topic words too generic to use as section-match keywords.
const STOPWORDS = new Set([
  "chapter", "chapters", "section", "sections", "problem", "problems", "volume",
  "vol", "part", "unit", "review", "and", "the", "of", "from", "with", "for",
  "intro", "introduction", "this", "that", "these", "those", "topic", "topics",
]);

// Reduce a book's outline to only the sections the session topic names — by
// explicit chapter number ("Chapter 7, 8", "Ch 7-9"), explicit section number
// ("3.1"), or keyword overlap with section/chapter titles and concepts. Keeps
// each matched section's concept keywords (they tell the generator what to make).
//
// Falls back to the full `contents` unchanged when it can't safely narrow: empty
// topic, legacy book with no structured chapters, or nothing matched. Never
// returns an empty book block.
export function selectBookContents(chapters: unknown, contents: string, topic: string): string {
  const t = topic.trim();
  const parsed = parseChapters(chapters);
  if (!t || !parsed) return contents;

  const lower = t.toLowerCase();

  // Explicit section numbers anywhere in the topic, e.g. "3.1", "12.4".
  const sectionNums = new Set(lower.match(/\b\d{1,2}\.\d{1,2}\b/g) ?? []);

  // Explicit chapter numbers following a "chapter"/"ch" cue: "chapter 7, 8",
  // "chapters 7 and 8", "ch 7-9".
  const chapterNums = new Set<string>();
  const cue = /\b(?:chapters?|ch\.?)\s+([0-9,\s&\-–and]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = cue.exec(t)) !== null) {
    const span = m[1];
    const range = /\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/.exec(span);
    if (range) {
      for (let n = Number(range[1]); n <= Number(range[2]); n++) chapterNums.add(String(n));
    }
    for (const num of span.match(/\d{1,2}/g) ?? []) chapterNums.add(num);
  }

  // Remaining alphabetic tokens become keywords (≥4 chars, not stopwords).
  const keywords = lower
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));

  const hasKeyword = (text: string) => {
    const hay = text.toLowerCase();
    return keywords.some((k) => hay.includes(k));
  };

  const matched: BookChapter[] = [];
  for (const c of parsed) {
    // Whole chapter named by number → keep all its sections.
    if (c.number && chapterNums.has(c.number.trim())) {
      matched.push(c);
      continue;
    }
    // Otherwise keep sections that match by number or keyword.
    const sections = c.sections.filter(
      (s) => (s.number && sectionNums.has(s.number.trim())) || hasKeyword(`${s.title} ${s.concepts}`)
    );
    if (sections.length) {
      matched.push({ ...c, sections });
    } else if (hasKeyword(c.title)) {
      // Chapter title matched but no individual section did → keep the chapter.
      matched.push(c);
    }
  }

  if (!matched.length) return contents;
  return formatChapters(matched);
}
