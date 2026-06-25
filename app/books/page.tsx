import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { toDisplayChapters } from "@/lib/book-chapters";
import AddBookForm from "@/components/AddBookForm";

// Reads live DB data — render on demand.
export const dynamic = "force-dynamic";

// Books library. The contents field of each book is fed to the problem
// generator when a session is linked to it. Cards preview chapter titles only —
// section detail stays in the DB but isn't displayed.
export default async function BooksPage() {
  const userId = await requireUserId();
  const rows = await prisma.book.findMany({
    where: { userId },
    orderBy: { title: "asc" },
    select: { id: true, title: true, author: true, chapters: true, contents: true },
  });

  // Reduce to title-only data before render so section/concept detail never
  // reaches the client payload.
  const books = rows.map((b) => ({
    id: b.id,
    title: b.title,
    author: b.author,
    chapterTitles: toDisplayChapters(b.chapters, b.contents).map((c) => c.title),
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Books</h1>
      <p className="text-sm text-gray-500">
        Add the books you assign from. Upload a book&apos;s PDF and its chapters are parsed
        automatically, so generated problems match the chapters you note in a session — or add
        by title and paste the contents yourself.
      </p>

      <AddBookForm />

      {books.length === 0 ? (
        <p className="text-sm text-gray-500">No books yet — add one above.</p>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {books.map((b) => {
            const preview = b.chapterTitles.slice(0, 4).join(" · ");
            const more = b.chapterTitles.length - 4;
            return (
              <Link
                key={b.id}
                href={`/books/${b.id}`}
                className="block rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50"
              >
                <div className="font-semibold text-blue-600">{b.title}</div>
                {b.author && <div className="text-xs text-gray-500">{b.author}</div>}
                <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                  {b.chapterTitles.length > 0
                    ? `${preview}${more > 0 ? ` · +${more} more` : ""}`
                    : "No chapters yet — click to add."}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
