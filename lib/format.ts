// Small shared formatting helpers. Kept dependency-free so both client
// components and server/lib code (e.g. lib/download-problems.ts) can import them.

// Zero-pad a number to two digits ("9" → "09"). Used for datetime-local strings
// and PDF timestamps.
export const pad = (n: number) => String(n).padStart(2, "0");

// Does this text contain LaTeX in the delimiters we generate ($...$ / $$...$$)?
// Answers are rendered monospace when they're mathematical and as prose when they
// aren't, and this decides which — per item, from the content itself. There is no
// stored subject or content-type flag to consult, and there shouldn't be: a mixed
// subject can produce a symbolic answer one problem and a sentence the next.
export function hasMath(text: string): boolean {
  return /\$[^$\n]+\$|\$\$[\s\S]+\$\$/.test(text || "");
}

// Percent change from `prior` to `current`, rounded to a whole percent.
//
// Returns null when there is no baseline to compare against (prior is 0), which the
// caller renders as "new" or "—" depending on whether anything happened in the
// current window. Returning null rather than 0 or Infinity keeps that decision at
// the call site instead of hiding a division by zero behind a plausible-looking
// number — a trend tile reading "0%" when last month was empty is a lie.
export function percentChange(current: number, prior: number): number | null {
  if (prior === 0) return null;
  return Math.round(((current - prior) / prior) * 100);
}

// "Mon, Jun 16" — the calendar/ledger session-date format. Note this deliberately
// omits the year; LearningHistory uses a different (year-bearing) format and is
// not a consumer of this helper.
export function formatSessionDate(iso: string | Date): string {
  return new Date(iso).toLocaleDateString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}
