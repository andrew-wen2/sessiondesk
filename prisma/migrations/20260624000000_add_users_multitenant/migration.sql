-- Multi-tenant: User owns Student/Book/Session. Existing rows are backfilled to a
-- bootstrap user (empty passwordHash → un-loginable until a real hash is set via
-- `npm run set-password`). ReferenceProblem stays global (unowned).

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- Bootstrap owner for pre-existing data. Empty hash blocks login until set.
INSERT INTO "User" ("id", "email", "passwordHash")
VALUES ('usr_bootstrap', 'bootstrap@sessiondesk.local', '');

-- AddColumn (NOT NULL via temporary default that backfills existing rows)
ALTER TABLE "Student" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'usr_bootstrap';
ALTER TABLE "Book" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'usr_bootstrap';
ALTER TABLE "Session" ADD COLUMN "userId" TEXT NOT NULL DEFAULT 'usr_bootstrap';

-- Drop the default so future inserts must specify an owner explicitly.
ALTER TABLE "Student" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "Book" ALTER COLUMN "userId" DROP DEFAULT;
ALTER TABLE "Session" ALTER COLUMN "userId" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Student_userId_idx" ON "Student"("userId");
CREATE INDEX "Book_userId_idx" ON "Book"("userId");
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "Student" ADD CONSTRAINT "Student_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Book" ADD CONSTRAINT "Book_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
