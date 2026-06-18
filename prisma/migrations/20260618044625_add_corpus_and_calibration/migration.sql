-- AlterTable
ALTER TABLE "Student" ADD COLUMN     "competition" TEXT,
ADD COLUMN     "difficultyBand" TEXT;

-- CreateTable
CREATE TABLE "ReferenceProblem" (
    "id" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "year" INTEGER,
    "number" INTEGER,
    "category" TEXT,
    "statement" TEXT NOT NULL,
    "answer" TEXT,
    "solution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceProblem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ReferenceProblem_source_number_idx" ON "ReferenceProblem"("source", "number");

-- CreateIndex
CREATE INDEX "ReferenceProblem_category_idx" ON "ReferenceProblem"("category");

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceProblem_source_year_number_key" ON "ReferenceProblem"("source", "year", "number");
