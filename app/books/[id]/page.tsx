import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { toDisplayChapters } from "@/lib/book-chapters";
import BookDetail, { type BookDetailData } from "@/components/BookDetail";

// Book detail. Server shell: loads the book and hands editable fields to the
// client editor.
export default async function BookPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await requireUserId();

  // contents is needed as a fallback for legacy books without structured chapters.
  const row = await prisma.book
    .findFirstOrThrow({
      where: { id, userId },
      select: { id: true, title: true, author: true, chapters: true, contents: true },
    })
    .catch(() => null);
  if (!row) notFound();

  const book: BookDetailData = {
    id: row.id,
    title: row.title,
    author: row.author ?? "",
    chapters: toDisplayChapters(row.chapters, row.contents),
  };

  return (
    <div className="space-y-6">
      <Link href="/books" className="text-sm text-blue-600 hover:underline">
        ← All books
      </Link>
      <BookDetail book={book} />
    </div>
  );
}
