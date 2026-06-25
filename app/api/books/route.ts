import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";

// GET /api/books — the user's books, sorted by title (for the session book selector).
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    // The session book-selector only needs id and title — omit contents and
    // chapters (potentially large JSON) from the list response.
    const books = await prisma.book.findMany({
      where: { userId },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    });
    return NextResponse.json(books);
  } catch (e) {
    console.error("[/api/books GET]", e);
    return NextResponse.json(
      { error: "Could not load books — refresh and try again." },
      { status: 500 }
    );
  }
}

// POST /api/books — create a book (title required; contents filled in later).
export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const title = typeof body.title === "string" ? body.title.trim() : "";
    const author = typeof body.author === "string" ? body.author.trim() : "";
    const contents = typeof body.contents === "string" ? body.contents : "";

    if (!title) {
      return NextResponse.json({ error: "Book title is required." }, { status: 400 });
    }

    // Return only id — the caller (AddBookForm) immediately redirects to /books/[id];
    // it doesn't need the full book row in the response.
    const book = await prisma.book.create({
      data: { title, author: author || null, contents, userId },
      select: { id: true },
    });
    return NextResponse.json(book, { status: 201 });
  } catch (e) {
    console.error("[/api/books POST]", e);
    return NextResponse.json({ error: "Could not create book — try again." }, { status: 500 });
  }
}
