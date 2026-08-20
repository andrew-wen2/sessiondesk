-- Retire a student without deleting anything. Additive column, backward compatible
-- (see the migration-order note in CLAUDE.md's Migration gotcha) — every existing
-- row defaults to `false`, so nobody is retroactively retired.
--
-- Retiring only changes whether a student shows up in the DEFAULT roster view
-- (app/students/page.tsx); their sessions, payments, and the Add-session combobox
-- are all unaffected. A retired student who still owes money is never hidden by
-- default, regardless of this flag — see the roster query.

ALTER TABLE "Student" ADD COLUMN "retired" BOOLEAN NOT NULL DEFAULT false;
