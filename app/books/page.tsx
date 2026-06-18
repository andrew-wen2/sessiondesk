import Link from "next/link";
import { prisma } from "@/lib/prisma";
import AddBookForm from "@/components/AddBookForm";

// Reads live DB data — render on demand.
export const dynamic = "force-dynamic";

// Books library. The contents field of each book is fed to the problem
// generator when a session is linked to it.
export default async function BooksPage() {
  const books = await prisma.book.findMany({ orderBy: { title: "asc" } });

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
            const preview = b.contents.trim();
            return (
              <Link
                key={b.id}
                href={`/books/${b.id}`}
                className="block rounded-lg border border-gray-200 bg-white p-4 hover:bg-gray-50"
              >
                <div className="font-semibold text-blue-600">{b.title}</div>
                {b.author && <div className="text-xs text-gray-500">{b.author}</div>}
                <p className="mt-1 line-clamp-2 text-sm text-gray-600">
                  {preview ? preview : "No chapter contents yet — click to add."}
                </p>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
