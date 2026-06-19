import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students — all students, sorted by name (for the combobox).
export async function GET() {
  try {
    // Combobox only needs id/name/rate/level — skip notes, timestamps.
    const students = await prisma.student.findMany({
      orderBy: { name: "asc" },
      select: { id: true, name: true, rate: true, level: true },
    });
    return NextResponse.json(students);
  } catch {
    return NextResponse.json(
      { error: "Could not load students — refresh and try again." },
      { status: 500 }
    );
  }
}

// POST /api/students — create a minimal student (name + rate). Level is filled
// in later from the Students view.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const rate = Number(body.rate);

    if (!name) {
      return NextResponse.json({ error: "Student name is required." }, { status: 400 });
    }
    if (!Number.isFinite(rate) || rate < 0) {
      return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
    }

    // Return only id — the caller (AddSessionModal) reads student.id then POSTs
    // the session; it doesn't need the full student row.
    const student = await prisma.student.create({
      data: { name, rate: Math.round(rate), level: "", notes: null },
      select: { id: true },
    });
    return NextResponse.json(student, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Could not create student — try again." },
      { status: 500 }
    );
  }
}
