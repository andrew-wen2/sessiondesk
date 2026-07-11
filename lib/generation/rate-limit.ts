// Per-user concurrency guard for the expensive, externally-billed generation
// routes (/api/generate, /api/generate-lesson). A single user firing many
// generations at once multiplies Anthropic spend and DB-connection pressure, and
// at 100+ users a few such bursts can starve the pool. This caps how many
// generations one user can have in flight at a time.
//
// Scope caveat: this is in-process state. On serverless (Vercel) each warm
// instance has its own Map, so the cap is per-instance, not strictly global — it
// bounds the common case (one user hammering the button, routed to a warm
// instance) without new infra. A cross-instance cap would need a shared store
// (Postgres/Redis); deferred until the spend actually warrants it.

const MAX_CONCURRENT_PER_USER = 2;

const inFlight = new Map<string, number>();

// Try to reserve a generation slot for a user. Returns true if acquired (caller
// MUST call release in a finally), false if the user is already at the cap.
export function acquireSlot(userId: string): boolean {
  const n = inFlight.get(userId) ?? 0;
  if (n >= MAX_CONCURRENT_PER_USER) return false;
  inFlight.set(userId, n + 1);
  return true;
}

export function releaseSlot(userId: string): void {
  const n = inFlight.get(userId) ?? 0;
  if (n <= 1) inFlight.delete(userId);
  else inFlight.set(userId, n - 1);
}

export const TOO_MANY_MESSAGE =
  "You already have generations running — wait for them to finish, then try again.";
