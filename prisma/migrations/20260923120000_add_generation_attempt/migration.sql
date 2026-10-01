-- Generation attempts: one row per problems/lesson generation attempt, so failures can
-- be counted (Session.genMeta keeps only the latest run and is overwritten on
-- regenerate). Purely ADDITIVE — a new table, no change to existing ones.
--
-- Apply BEFORE deploying the code that writes it. The route treats attempt writes as
-- telemetry (a failed write never blocks generation), but applying first keeps the
-- daily generation cap and the failure baseline from silently counting nothing.
CREATE TABLE "GenerationAttempt" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "pipeline" TEXT,
    "tier" TEXT,
    "status" TEXT NOT NULL DEFAULT 'started',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "wallTimeMs" INTEGER,
    "kept" INTEGER,
    "asked" INTEGER,

    CONSTRAINT "GenerationAttempt_pkey" PRIMARY KEY ("id"),
    -- Integrity for String columns Prisma doesn't model as enums (a bad value must
    -- fail the write, never a later read).
    CONSTRAINT "GenerationAttempt_status_check" CHECK ("status" IN ('started', 'ok', 'failed')),
    CONSTRAINT "GenerationAttempt_kind_check" CHECK ("kind" IN ('problems', 'lesson'))
);

CREATE INDEX "GenerationAttempt_userId_startedAt_idx" ON "GenerationAttempt"("userId", "startedAt");
CREATE INDEX "GenerationAttempt_sessionId_idx" ON "GenerationAttempt"("sessionId");

ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "GenerationAttempt" ADD CONSTRAINT "GenerationAttempt_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
