import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";

// GET /api/students — all students, sorted by name (for the combobox).
export async function GET() {
  try {
    const students = await prisma.student.findMany({ orderBy: { name: "asc" } });
    return NextResponse.json(students);
  } catch {
    return NextResponse.json(
      { error: "Could not load students — refresh and try again." },
      { status: 500 }
    );
  }
}

// POST /api/students — create a minimal student (name + rate). Subject/level
// are filled in later from the Students view.
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

    const student = await prisma.student.create({
      data: { name, rate: Math.round(rate), subject: "", level: "", notes: null },
    });
    return NextResponse.json(student, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Could not create student — try again." },
      { status: 500 }
    );
  }
}
