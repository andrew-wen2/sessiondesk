-- "Retired" read as employment/finality; "archived" is the term the rest of the app's
-- verbs already imply (reversible, hidden-not-deleted — the same idea Gmail/Slack use
-- for the same pattern). A rename migration rather than editing the migration that
-- added the column: that one already ran against the shared dev database, and editing
-- an applied migration's SQL after the fact is exactly what the Prisma checksum check
-- (and CLAUDE.md's "never edit a committed migration") exists to catch.

ALTER TABLE "Student" RENAME COLUMN "retired" TO "archived";
