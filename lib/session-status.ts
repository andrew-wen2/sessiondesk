// Session lifecycle status + the money rules derived from it. Pure — no Prisma, no
// React — so the server pages, the API routes, and the client ledger all compute
// "is this owed?" from one place instead of three copies that drift.
//
// Stored as a String on Session, not a Prisma enum — this schema has no enums
// (ReferenceProblem.source and .category are Strings too). An enum makes an
// unexpected DB value throw on READ, so one bad row would 500 the calendar; a
// String plus normalizeStatus degrades to "scheduled" instead. Integrity comes from
// a CHECK constraint in the migration, which Prisma neither introspects nor drops.

export const SESSION_STATUSES = ["scheduled", "completed", "cancelled", "no_show"] as const;

export type SessionStatus = (typeof SESSION_STATUSES)[number];

// WRITE paths use this: an explicit user action carrying an unknown status should
// fail loudly with a 400 rather than being silently coerced.
export function isSessionStatus(raw: unknown): raw is SessionStatus {
  return typeof raw === "string" && (SESSION_STATUSES as readonly string[]).includes(raw);
}

// READ paths use this: a legacy or corrupt value must never 500 a page.
export function normalizeStatus(raw: unknown): SessionStatus {
  return isSessionStatus(raw) ? raw : "scheduled";
}

const ms = (d: string | Date) => (d instanceof Date ? d.getTime() : new Date(d).getTime());

// Has the session's start time passed? `now` is always passed in rather than read
// from the clock so a single render computes it once (calling Date.now() inside a
// component that both SSRs and hydrates is a mismatch waiting to happen).
export function hasStarted(start: string | Date, now: number): boolean {
  return ms(start) <= now;
}

// A past session nobody touched reads as "Completed" — the tutor shouldn't have to
// mark every session twice. `completed` stays an explicit choice for marking a
// session done ahead of its end time.
export function effectiveStatus(status: SessionStatus, start: string | Date, now: number): SessionStatus {
  return status === "scheduled" && hasStarted(start, now) ? "completed" : status;
}

// The single owed rule: unpaid AND already started AND not cancelled. A no-show is
// owed (the slot was held); a future session isn't owed yet even if unpaid.
//
// SQL mirror — keep these two in sync, it's the one place a divergence can hide:
//   { paid: false, status: { not: "cancelled" }, start: { lte: now } }
export function isOwed(
  s: { paid: boolean; start: string | Date; status: SessionStatus },
  now: number
): boolean {
  return !s.paid && hasStarted(s.start, now) && s.status !== "cancelled";
}

export function owedAmount(
  s: { paid: boolean; start: string | Date; status: SessionStatus; amount: number },
  now: number
): number {
  return isOwed(s, now) ? s.amount : 0;
}

// Did this session count as a slot you actually taught? A no-show does (you showed
// up and held the time); a cancellation never does, and a future session hasn't yet.
export function countsAsTaught(status: SessionStatus, start: string | Date, now: number): boolean {
  return status !== "cancelled" && hasStarted(start, now);
}

export const STATUS_LABEL: Record<SessionStatus, string> = {
  scheduled: "Scheduled",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
};

// Badge tones, colocated with the labels so a new status can't get one without the
// other. These are keys into BADGE_TONE in components/ui/Badge.tsx, not raw classes —
// this file is pure and imported by API routes, so it must not pull in a component.
export const STATUS_TONE: Record<SessionStatus, "neutral" | "good" | "warn" | "info"> = {
  scheduled: "info",
  completed: "good",
  cancelled: "neutral",
  no_show: "warn",
};
