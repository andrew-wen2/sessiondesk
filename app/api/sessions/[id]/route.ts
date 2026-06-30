import { NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { updateEvent, deleteEvent, attachMeetLink, toSessionForGCal } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { parseNonNegInt, parsePositiveInt, parseDate } from "@/lib/validation";

// GET /api/sessions/[id] — single session with full student (must be the user's).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const session = await prisma.session.findFirst({
      where: { id, userId },
      include: { student: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });
    return NextResponse.json(session);
  } catch (e) {
    console.error("[/api/sessions/[id] GET]", e);
    return NextResponse.json({ error: "Session not found." }, { status: 404 });
  }
}

// PATCH /api/sessions/[id] — partial update. Editable: topic, homework, paid,
// problems, and the schedule fields start/durationMin/amount. studentId and
// googleEventId are never patchable from the client.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const owned = await prisma.session.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    const body = await request.json();
    const data: Prisma.SessionUpdateInput = {};

    if (typeof body.topic === "string") data.topic = body.topic;
    if (typeof body.homework === "string") data.homework = body.homework;
    if (typeof body.paid === "boolean") data.paid = body.paid;

    if (body.start !== undefined) {
      const start = parseDate(body.start);
      if (!start.ok) {
        return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
      }
      data.start = start.value;
    }
    if (body.durationMin !== undefined) {
      const d = parsePositiveInt(body.durationMin);
      if (!d.ok) {
        return NextResponse.json({ error: "Duration must be a positive number." }, { status: 400 });
      }
      data.durationMin = d.value;
    }
    if (body.amount !== undefined) {
      const a = parseNonNegInt(body.amount);
      if (!a.ok) {
        return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
      }
      data.amount = a.value;
    }
    if ("problems" in body) {
      if (body.problems === null) {
        data.problems = Prisma.JsonNull;
      } else if (Array.isArray(body.problems)) {
        data.problems = body.problems as Prisma.InputJsonValue;
      } else {
        return NextResponse.json(
          { error: "Problems must be an array." },
          { status: 400 }
        );
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const session = await prisma.session.update({
      where: { id },
      data,
      include: { student: { select: { name: true, level: true, meetLink: true } } },
    });

    // Mirror topic/time/duration/paid changes to the GCal event after the
    // response flushes — never block the save on a Google round-trip.
    // meetLink is now on the student; source it from there.
    const mirrored =
      data.topic !== undefined ||
      data.start !== undefined ||
      data.durationMin !== undefined ||
      data.paid !== undefined; // paid drives the event color (green/orange)
    const account = session.googleEventId && mirrored ? await getGcalAccount(userId) : null;
    if (account && session.googleEventId) {
      const eventId = session.googleEventId;
      after(async () => {
        try {
          const newId = await updateEvent(account, eventId, toSessionForGCal(session));
          // updateEvent recreates the event if it was deleted on Google and
          // returns a new id — persist it so the mirror stays linked.
          if (newId !== eventId) {
            await prisma.session.update({
              where: { id: session.id },
              data: { googleEventId: newId },
            });
          }
          // Best-effort: attach the Meet link as structured conferenceData too.
          // A Google rejection is swallowed — the link is already in the description.
          if (session.student.meetLink) {
            await attachMeetLink(account, newId, session.student.meetLink);
          }
        } catch (e) {
          console.error("GCal sync failed (update):", e);
        }
      });
    }

    return NextResponse.json(session);
  } catch (e) {
    console.error("[/api/sessions/[id] PATCH]", e);
    return NextResponse.json(
      { error: "Save failed — try again." },
      { status: 500 }
    );
  }
}

// DELETE /api/sessions/[id] — remove the session and its mirrored GCal event
// (event deletion is best-effort; the DB row is the source of truth).
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const owned = await prisma.session.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    const deleted = await prisma.session.delete({ where: { id } });

    const account = deleted.googleEventId ? await getGcalAccount(userId) : null;
    if (account && deleted.googleEventId) {
      const eventId = deleted.googleEventId;
      after(async () => {
        try {
          await deleteEvent(account, eventId);
        } catch (e) {
          console.error("GCal sync failed (delete):", e);
        }
      });
    }

    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[/api/sessions/[id] DELETE]", e);
    return NextResponse.json({ error: "Could not delete — try again." }, { status: 500 });
  }
}
