-- Merge Student.subject + Student.level into a single free-text Student.profile,
-- and drop the generator-engine selector. Generation now derives subject,
-- difficulty, and answer format from this one field plus the session topic, so
-- there is no user-facing subject or engine choice left to store.

-- Fold the subject into the level text FIRST so no description is lost. Skip the
-- concatenation when the level already names the subject (the common case for
-- competition students, whose level reads "AIME, problems 10-15").
UPDATE "Student" SET "level" = CASE
  WHEN "subject" = '' THEN "level"
  WHEN "level" = '' THEN "subject"
  WHEN position(lower("subject") in lower("level")) > 0 THEN "level"
  ELSE "subject" || ' — ' || "level"
END;

ALTER TABLE "Student" RENAME COLUMN "level" TO "profile";
ALTER TABLE "Student" ALTER COLUMN "profile" SET DEFAULT '';
ALTER TABLE "Student" DROP COLUMN "subject";
ALTER TABLE "Student" DROP COLUMN "generatorProfile";
