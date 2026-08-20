-- Drop Session.homework. It had no UI and no reader: the column was created by the
-- init migration, but the session detail page never rendered it and nothing ever
-- queried it — only a PATCH passthrough kept it alive. Practice problems and the
-- generated lesson are the artifacts a session actually carries.
--
-- APPLY THIS *AFTER* THE CODE THAT STOPS SELECTING THE COLUMN IS DEPLOYED, not before.
-- Prisma Client emits an explicit column list, and app/sessions/[id]/page.tsx loads a
-- session with `include: { student: true }` — so a still-running old instance would
-- select "homework" and every session-detail render would fail with
-- `column "homework" does not exist`. Adding columns is backward compatible and
-- dropping them is not, which is why this is a separate migration from
-- 20260810120000_add_session_status_and_series rather than folded into it.
--
-- The historical init migration that created the column is left untouched.

ALTER TABLE "Session" DROP COLUMN "homework";
