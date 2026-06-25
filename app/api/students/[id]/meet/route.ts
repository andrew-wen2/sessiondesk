import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import {
  generateMeetLink,
  propagateMeetLink,
  MeetStillGeneratingError,
  SESSION_FOR_GCAL_SELECT,
} from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";

// POST /api/students/[id]/meet — generate a Google Meet link for a student. A
// Meet conference must hang off a calendar event, so we attach one to any of the
// student's synced sessions, persist the URL on the student (single source of
// truth), then propagate it to all their events. Works whether or not a link
// already exists — generating again mints a fresh link and replaces the old one.
// Unlike sync, a GCal failure here surfaces a user-visible error because the
// caller explicitly requested the link.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const owned = await prisma.student.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Student not found." }, { status: 404 });

    const account = await getGcalAccount(userId);
    if (!account) {
      return NextResponse.json(
        { error: "Calendar not connected — connect Google Calendar first." },
        { status: 400 }
      );
    }

    // A Meet conference is created against a calendar event; pick the student's
    // most recent synced session to host it.
    const session = await prisma.session.findFirst({
      where: { studentId: id, userId, googleEventId: { not: null } },
      orderBy: { start: "desc" },
      select: { googleEventId: true },
    });

    if (!session?.googleEventId) {
      return NextResponse.json(
        { error: "Sync a session to Calendar first, then generate a Meet link." },
        { status: 400 }
      );
    }

    const meetLink = await generateMeetLink(account, session.googleEventId);

    // Persist the link on the student — single source of truth.
    await prisma.student.update({
      where: { id },
      data: { meetLink },
    });

    // Propagate to all of this student's synced GCal events after the response
    // flushes — non-blocking; per-event failures are swallowed inside the helper.
    after(async () => {
      try {
        const rows = await prisma.session.findMany({
          where: { studentId: id, userId, googleEventId: { not: null } },
          select: SESSION_FOR_GCAL_SELECT,
        });
        const remaps = await propagateMeetLink(account, rows, meetLink);
        for (const r of remaps) {
          await prisma.session.update({
            where: { id: r.id },
            data: { googleEventId: r.newEventId },
          });
        }
      } catch (e) {
        console.error("[/api/students/[id]/meet POST] propagate failed (non-blocking):", e);
      }
    });

    return NextResponse.json({ meetLink });
  } catch (e) {
    console.error("[/api/students/[id]/meet POST]", e);
    if (e instanceof MeetStillGeneratingError) {
      return NextResponse.json(
        { error: "Meet link still generating — try again in a moment." },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { error: "Could not generate Meet link — try again." },
      { status: 500 }
    );
  }
}
