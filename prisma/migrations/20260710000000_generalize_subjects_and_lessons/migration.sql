-- Generalize the app beyond competition math.
--   Student.subject          — human-facing subject label, shown in UI + injected into prompts.
--   Student.generatorProfile — selects the generation engine ("general" | "competition-math").
--   Session.lesson           — generated lesson blob, parallel to Session.problems.
--
-- Backfill: every EXISTING student predates the multi-subject model and is a
-- competition-math student, so pin them to the "competition-math" profile to
-- preserve their exact generation behavior. New students default to "general"
-- (the column default). New rows created after this migration take the default.

-- AlterTable: add columns with defaults so existing rows are valid immediately.
ALTER TABLE "Student" ADD COLUMN "subject" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Student" ADD COLUMN "generatorProfile" TEXT NOT NULL DEFAULT 'general';
ALTER TABLE "Session" ADD COLUMN "lesson" JSONB;

-- Backfill existing roster to the competition-math engine (no behavior change).
UPDATE "Student" SET "generatorProfile" = 'competition-math';
