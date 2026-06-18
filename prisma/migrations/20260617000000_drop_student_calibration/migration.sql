-- Difficulty calibration is now inferred from Student.level text only; the
-- manual structured fields are removed.
ALTER TABLE "Student" DROP COLUMN "competition",
DROP COLUMN "difficultyBand";
