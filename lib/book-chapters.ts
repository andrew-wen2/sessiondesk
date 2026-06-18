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
