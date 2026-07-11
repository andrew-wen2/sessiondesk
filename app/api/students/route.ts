import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { parseNonNegInt } from "@/lib/validation";
import { getProfile } from "@/lib/subjects";

// GET /api/students — all of the current user's students, sorted by name (combobox).
export async function GET() {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    // Combobox only needs id/name/rate/subject/level — skip notes, timestamps.
    const students = await prisma.student.findMany({
      where: { userId },
      orderBy: { name: "asc" },
      select: { id: true, name: true, rate: true, subject: true, level: true },
    });
    return NextResponse.json(students);
  } catch {
    return NextResponse.json(
      { error: "Could not load students — refresh and try again." },
      { status: 500 }
    );
  }
}

// POST /api/students — create a student (name + rate, optionally subject +
// generator profile). Level is filled in later from the Students view.
export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const name = typeof body.name === "string" ? body.name.trim() : "";

    if (!name) {
      return NextResponse.json({ error: "Student name is required." }, { status: 400 });
    }
    const rate = parseNonNegInt(body.rate);
    if (!rate.ok) {
      return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
    }
    const subject = typeof body.subject === "string" ? body.subject.trim() : "";
    // Normalize the profile through getProfile so only a known key is ever stored
    // (unknown/absent → "general", the safe default).
    const generatorProfile = getProfile(body.generatorProfile).key;

    // Return only id — the caller (AddSessionModal) reads student.id then POSTs
    // the session; it doesn't need the full student row.
    const student = await prisma.student.create({
      data: { name, rate: rate.value, subject, generatorProfile, level: "", notes: null, userId },
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
