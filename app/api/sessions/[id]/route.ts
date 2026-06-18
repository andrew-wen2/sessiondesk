import { NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { updateEvent, deleteEvent } from "@/lib/gcal";
import { isGcalConfigured } from "@/lib/gcal-token";

// GET /api/sessions/[id] — single session with full student.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const session = await prisma.session.findUniqueOrThrow({
      where: { id },
      include: { student: true },
    });
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
    const body = await request.json();
    const data: Prisma.SessionUpdateInput = {};

    if (typeof body.topic === "string") data.topic = body.topic;
    if (typeof body.homework === "string") data.homework = body.homework;
    if (typeof body.paid === "boolean") data.paid = body.paid;

    if (body.start !== undefined) {
      const start = new Date(body.start);
      if (Number.isNaN(start.getTime())) {
        return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
      }
      data.start = start;
    }
    if (body.durationMin !== undefined) {
      const d = Number(body.durationMin);
      if (!Number.isInteger(d) || d <= 0) {
        return NextResponse.json({ error: "Duration must be a positive number." }, { status: 400 });
      }
      data.durationMin = d;
    }
    if (body.amount !== undefined) {
      const a = Number(body.amount);
      if (!Number.isFinite(a) || a < 0) {
        return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
      }
      data.amount = Math.round(a);
    }
    if ("bookId" in body) {
      if (body.bookId === null || body.bookId === "") {
        data.book = { disconnect: true };
      } else if (typeof body.bookId === "string") {
        data.book = { connect: { id: body.bookId } };
      } else {
        return NextResponse.json({ error: "Invalid book." }, { status: 400 });
      }
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
      include: { student: true },
    });

    // Mirror topic/time/duration changes to the GCal event after the response
    // flushes — never block the save (esp. the debounced topic autosave) on a
    // Google round-trip.
    const mirrored =
      data.topic !== undefined || data.start !== undefined || data.durationMin !== undefined;
    if (session.googleEventId && mirrored && isGcalConfigured()) {
      const eventId = session.googleEventId;
      after(async () => {
        try {
          await updateEvent(eventId, {
            id: session.id,
            start: session.start,
            durationMin: session.durationMin,
            topic: session.topic,
            student: { name: session.student.name, subject: session.student.subject },
          });
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
    const deleted = await prisma.session.delete({ where: { id } });

    if (deleted.googleEventId && isGcalConfigured()) {
      const eventId = deleted.googleEventId;
      after(async () => {
        try {
          await deleteEvent(eventId);
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
