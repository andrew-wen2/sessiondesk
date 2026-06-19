-- The `subject` field is removed. Calibration (competition + difficulty band)
-- and the retrieval category are now inferred from `Student.level` (+ session
-- topic) alone; GCal event titles use the student name. See lib/calibration.ts.
ALTER TABLE "Student" DROP COLUMN "subject";
