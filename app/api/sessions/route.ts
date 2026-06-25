import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { createEvent, toSessionForGCal, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { parseNonNegInt, parseDate } from "@/lib/validation";

// GET /api/sessions?month=YYYY-MM — the user's sessions in the month, with student name.
export async function GET(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const month = searchParams.get("month") ?? new Date().toISOString().slice(0, 7);
    const [year, mon] = month.split("-").map(Number);

    if (!year || !mon || mon < 1 || mon > 12) {
      return NextResponse.json({ error: "Invalid month — use YYYY-MM." }, { status: 400 });
    }

    const start = new Date(year, mon - 1, 1);
    const end = new Date(year, mon, 1);

    // Calendar chips need id/start/paid/googleEventId and student name only.
    // Omit problems (heavy Json) and homework — the calendar never renders them.
    const sessions = await prisma.session.findMany({
      where: { userId, start: { gte: start, lt: end } },
      select: {
        id: true,
        studentId: true,
        start: true,
        durationMin: true,
        topic: true,
        amount: true,
        paid: true,
        googleEventId: true,
        bookId: true,
        createdAt: true,
        student: { select: { name: true } },
      },
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
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const durationMin = body.durationMin != null ? Number(body.durationMin) : 60;
    const topic = typeof body.topic === "string" ? body.topic : "";
    const bookId = typeof body.bookId === "string" && body.bookId ? body.bookId : null;

    if (!studentId) {
      return NextResponse.json({ error: "Pick a student first." }, { status: 400 });
    }
    const start = parseDate(typeof body.start === "string" ? body.start : "");
    if (!start.ok) {
      return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
    }
    const amount = parseNonNegInt(body.amount);
    if (!amount.ok) {
      return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
    }

    // The student (and book, if any) must belong to this user — block linking a
    // session to another user's records.
    const student = await prisma.student.findFirst({
      where: { id: studentId, userId },
      select: { id: true },
    });
    if (!student) {
      return NextResponse.json({ error: "Pick a student first." }, { status: 400 });
    }
    if (bookId) {
      const book = await prisma.book.findFirst({ where: { id: bookId, userId }, select: { id: true } });
      if (!book) {
        return NextResponse.json({ error: "That book was not found." }, { status: 400 });
      }
    }

    // Include student name + meetLink for the GCal event; the client reads only res.ok.
    const session = await prisma.session.create({
      data: {
        userId,
        studentId,
        bookId,
        start: start.value,
        durationMin: Number.isFinite(durationMin) ? durationMin : 60,
        topic,
        amount: amount.value,
      },
      select: SESSION_FOR_GCAL_SELECT,
    });

    // Mirror to Google Calendar after the response flushes — never block the
    // create on a Google round-trip. The session is already saved; a GCal
    // failure just leaves googleEventId null ("not synced" flag + retry).
    const account = await getGcalAccount(userId);
    if (account) {
      after(async () => {
        try {
          const googleEventId = await createEvent(account, toSessionForGCal(session));
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
