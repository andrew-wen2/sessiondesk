-- Structured chapter outline for Book: [{number,title,sections:[{number,title,concepts}]}].
-- Chapter titles render as a table in the UI; sections/concepts are stored here
-- (and mirrored into Book.contents for the generator) but not displayed.
ALTER TABLE "Book" ADD COLUMN "chapters" JSONB;
