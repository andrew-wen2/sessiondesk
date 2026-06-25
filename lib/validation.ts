// Small parse-and-validate helpers for API route bodies. Each returns a
// discriminated result so the caller keeps ownership of the exact error message
// and status code — these only centralize the repeated parse + range checks
// (Number/isFinite/isInteger/Math.round) that were copy-pasted across routes.

export type Parsed<T> = { ok: true; value: T } | { ok: false };

// A non-negative amount in whole units (dollars), rounded — used for rate/amount.
export function parseNonNegInt(raw: unknown): Parsed<number> {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return { ok: false };
  return { ok: true, value: Math.round(n) };
}

// A strictly positive integer — used for durationMin on update.
export function parsePositiveInt(raw: unknown): Parsed<number> {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return { ok: false };
  return { ok: true, value: n };
}

// A parseable date/time (ISO string or epoch millis). Rejects non-string/number
// input rather than letting Date silently coerce it.
export function parseDate(raw: unknown): Parsed<Date> {
  if (typeof raw !== "string" && typeof raw !== "number") return { ok: false };
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return { ok: false };
  return { ok: true, value: d };
}

// A user-supplied Google Meet URL. Must be an https://meet.google.com link;
// returns the normalized href, or null if it isn't one. Keeps arbitrary hosts
// (internal addresses, other schemes) out of the DB / rendered hrefs / GCal events.
export function parseMeetLink(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.hostname !== "meet.google.com") return null;
  return url.href;
}
