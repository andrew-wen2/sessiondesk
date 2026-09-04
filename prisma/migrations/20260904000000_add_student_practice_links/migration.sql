-- Student practice links: a tutor sends a session's problem set to a student, who works
-- through it one problem at a time and gets the answer and worked solution revealed as
-- each one is committed. Purely ADDITIVE (new nullable columns + one new table), so it is
-- backward compatible and old instances keep serving while it lands.
--
-- ORDERING STILL MATTERS, for the opposite reason to a column drop: Prisma Client emits
-- an explicit column list, so code that SELECTs shareToken before the column exists 500s
-- every session page. CI runs `prisma generate` (which needs no database) and neither CI
-- nor Vercel runs `migrate deploy` — so both go green while production breaks. Apply this
-- against production BEFORE the push that triggers the deploy.

-- Shown to students on a shared link ("From Andrew"). A page with no identity on an
-- unfamiliar domain reads as phishing; the alternatives were hardcoding a name (wrong in
-- a multi-user app) or deriving it from the email local-part (leaks the tutor's handle to
-- anyone holding a link).
ALTER TABLE "User" ADD COLUMN "displayName" TEXT;

-- shareToken: a 256-bit bearer credential, minted on Send and nulled on Revoke. It is
-- never the identity — it resolves to a session and thence to a studentId, which is what
-- Submission is keyed by, so real student accounts later are purely additive.
ALTER TABLE "Session" ADD COLUMN "shareToken" TEXT;

-- sentAt is deliberately NOT cleared on Revoke: "sent five days ago, nothing back" is the
-- completion signal the feature exists to produce, and it has to survive the tutor turning
-- the link off. It is also the expiry anchor rather than Session.start, which the calendar
-- mutates on every drag-to-reschedule (and a series move shifts up to 52 rows at once) —
-- anchoring to it would silently kill or resurrect every downstream link.
ALTER TABLE "Session" ADD COLUMN "sentAt" TIMESTAMP(3);

-- sentSet freezes the problem set at Send. Serving and grading read this, never
-- Session.problems: two paths rewrite problems after a link is live (/api/generate, and
-- the module-level generation store that survives navigation), and countForTier is
-- deterministic so a replacement set has the SAME length — a length check would pass and
-- answers would be graded against different problems, with no error and no log.
ALTER TABLE "Session" ADD COLUMN "sentSet" JSONB;

CREATE UNIQUE INDEX "Session_shareToken_key" ON "Session"("shareToken");

-- One student's work on one session's set, accumulated as they go. There is no submit
-- button; each problem is committed on its own the moment it is checked.
--
-- "version" is optimistic concurrency, and it is load-bearing rather than defensive:
-- results is JSONB, so every commit is a read-modify-write with no atomicity under Read
-- Committed. Without a compare-and-swap, N parallel requests all read the same prior array
-- and exactly one write survives — which defeats the per-problem attempt cap outright (fire
-- fifty guesses at one index, spend one attempt) and loses a commit whenever two tabs are
-- open. Writers must update WHERE version = <read value> and retry on no-rows.
CREATE TABLE "Submission" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "studentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "results" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Submission_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Submission_sessionId_key" ON "Submission"("sessionId");
CREATE INDEX "Submission_userId_idx" ON "Submission"("userId");
CREATE INDEX "Submission_studentId_idx" ON "Submission"("studentId");

-- All three cascade. The Session-side one is the load-bearing one: every Submission hangs
-- off a Session, and app/api/students/[id]/route.ts deletes a student's sessions and then
-- the student inside one transaction, so submissions are already gone by the time the
-- student row is removed. The Student- and User-side cascades are belt-and-braces.
--
-- NOTE: Session.student itself still has no ON DELETE (Prisma's default is RESTRICT), so
-- both delete paths change behaviour the moment these FKs exist. Re-test them.
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_userId_fkey"
    FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_studentId_fkey"
    FOREIGN KEY ("studentId") REFERENCES "Student"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Submission" ADD CONSTRAINT "Submission_sessionId_fkey"
    FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
