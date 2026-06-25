// Small shared formatting helpers. Kept dependency-free so both client
// components and server/lib code (e.g. lib/download-problems.ts) can import them.

// Zero-pad a number to two digits ("9" → "09"). Used for datetime-local strings
// and PDF timestamps.
export const pad = (n: number) => String(n).padStart(2, "0");

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
