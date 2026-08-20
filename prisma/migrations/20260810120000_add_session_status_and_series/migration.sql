-- Session lifecycle status + recurring-series grouping.
--
--   Session.status   — "scheduled" | "completed" | "cancelled" | "no_show". Stored as TEXT
--                      and normalized app-side (lib/session-status.ts); this schema has no
--                      Prisma enums, so one unexpected value degrades to "scheduled" on read
--                      instead of throwing. Existing rows take the 'scheduled' default: a past
--                      scheduled session already reads as "Completed" in the UI (derived), so
--                      there is deliberately NO backfill UPDATE — backfilling would erase the
--                      distinction between "the tutor recorded an outcome" and "nothing was
--                      recorded". No existing row is cancelled, so every owed total is
--                      unchanged by this migration.
--
--   Session.seriesId — groups the rows materialized from one recurrence rule. NULL for every
--                      pre-existing (standalone) session.

ALTER TABLE "Session" ADD COLUMN "status" TEXT NOT NULL DEFAULT 'scheduled';
ALTER TABLE "Session" ADD COLUMN "seriesId" TEXT;

-- Backstop for the app-level validation on write paths. Not representable in
-- schema.prisma, which is fine: Prisma neither introspects nor drops CHECK constraints,
-- so it can't cause drift. The tradeoff is deliberate — a validation gap becomes a loud
-- 500 rather than a silently bad value.
ALTER TABLE "Session" ADD CONSTRAINT "Session_status_check"
  CHECK ("status" IN ('scheduled', 'completed', 'cancelled', 'no_show'));

-- "This and all future sessions" reads filter on (userId, seriesId, start).
CREATE INDEX "Session_seriesId_idx" ON "Session"("seriesId");

-- Every session query is userId + a start range (calendar, dashboard, filtered ledger);
-- the existing single-column start index cannot serve the userId predicate.
CREATE INDEX "Session_userId_start_idx" ON "Session"("userId", "start");
