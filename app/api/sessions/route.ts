import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { createEvent } from "@/lib/gcal";
import { isGcalConfigured } from "@/lib/gcal-token";

// GET /api/sessions?month=YYYY-MM — sessions in the month, with student name.
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split("-").map(Number);

    if (!year || !mon || mon < 1 || mon > 12) {
      return NextResponse.json({ error: "Invalid month — use YYYY-MM." }, { status: 400 });
    }

    const start = new Date(year, mon - 1, 1);
    const end = new Date(year, mon, 1);

    const sessions = await prisma.session.findMany({
      where: { start: { gte: start, lt: end } },
      include: { student: { select: { name: true } } },
      orderBy: { start: "asc" },
    });
    return NextResponse.json(sessions);
  } catch {
    return NextResponse.json(
      { error: "Could not load sessions — refresh and try again." },
      { status: 500 }
    );
  }
}

// POST /api/sessions — create a session. amount is copied from the student rate
// by the caller; durationMin defaults to 60.
export async function POST(request: Request) {
  try {
    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const startRaw = typeof body.start === "string" ? body.start : "";
    const amount = Number(body.amount);
    const durationMin = body.durationMin != null ? Number(body.durationMin) : 60;
    const topic = typeof body.topic === "string" ? body.topic : "";
    const bookId = typeof body.bookId === "string" && body.bookId ? body.bookId : null;

    if (!studentId) {
      return NextResponse.json({ error: "Pick a student first." }, { status: 400 });
    }
    const start = new Date(startRaw);
    if (Number.isNaN(start.getTime())) {
      return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
    }
    if (!Number.isFinite(amount) || amount < 0) {
      return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
    }

    const session = await prisma.session.create({
      data: {
        studentId,
        bookId,
        start,
        durationMin: Number.isFinite(durationMin) ? durationMin : 60,
        topic,
        amount: Math.round(amount),
      },
      include: { student: { select: { name: true, subject: true } } },
    });

    // Mirror to Google Calendar after the response flushes — never block the
    // create on a Google round-trip. The session is already saved; a GCal
    // failure just leaves googleEventId null ("not synced" flag + retry).
    if (isGcalConfigured()) {
      after(async () => {
        try {
          const googleEventId = await createEvent({
            id: session.id,
            start: session.start,
            durationMin: session.durationMin,
            topic: session.topic,
            student: session.student,
          });
          await prisma.session.update({
            where: { id: session.id },
            data: { googleEventId },
          });
        } catch (e) {
          console.error("GCal sync failed (create):", e);
        }
      });
    }

    return NextResponse.json(session, { status: 201 });
  } catch {
    return NextResponse.json(
      { error: "Could not create session — try again." },
      { status: 500 }
    );
  }
}
