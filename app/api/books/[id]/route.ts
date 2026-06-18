import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

// GET /api/books/[id] — single book.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const book = await prisma.book.findUniqueOrThrow({ where: { id } });
    return NextResponse.json(book);
  } catch (e) {
    console.error("[/api/books/[id] GET]", e);
    return NextResponse.json({ error: "Book not found." }, { status: 404 });
  }
}

// PATCH /api/books/[id] — title (non-empty), author, contents are editable.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const body = await request.json();
    const data: Prisma.BookUpdateInput = {};

    if (typeof body.title === "string") {
      const title = body.title.trim();
      if (!title) {
        return NextResponse.json({ error: "Title cannot be empty." }, { status: 400 });
      }
      data.title = title;
    }
    if (typeof body.author === "string") data.author = body.author.trim() || null;
    if (typeof body.contents === "string") data.contents = body.contents;

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const book = await prisma.book.update({ where: { id }, data });
    return NextResponse.json(book);
  } catch (e) {
    console.error("[/api/books/[id] PATCH]", e);
    return NextResponse.json({ error: "Save failed — try again." }, { status: 500 });
  }
}

// DELETE /api/books/[id] — remove the book. Sessions that referenced it keep
// their history; the relation's onDelete: SetNull clears their bookId.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    await prisma.book.delete({ where: { id } });
    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[/api/books/[id] DELETE]", e);
    return NextResponse.json({ error: "Could not delete — try again." }, { status: 500 });
  }
}
