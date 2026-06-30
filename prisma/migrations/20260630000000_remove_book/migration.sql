-- Remove the Book feature. Sessions no longer link to a book; the Book table,
-- its per-user FK, and the Session.bookId column/index/FK are all dropped.

-- DropForeignKey
ALTER TABLE "Session" DROP CONSTRAINT "Session_bookId_fkey";

-- DropForeignKey
ALTER TABLE "Book" DROP CONSTRAINT "Book_userId_fkey";

-- DropIndex
DROP INDEX "Session_bookId_idx";

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "bookId";

-- DropTable
DROP TABLE "Book";
