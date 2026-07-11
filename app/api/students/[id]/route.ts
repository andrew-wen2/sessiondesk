import { NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { deleteEvent, propagateMeetLink, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { parseNonNegInt, parseMeetLink } from "@/lib/validation";
import { getProfile } from "@/lib/subjects";

// GET /api/students/[id] — single student (must belong to the current user).
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const student = await prisma.student.findFirst({ where: { id, userId } });
    if (!student) return NextResponse.json({ error: "Student not found." }, { status: 404 });
    return NextResponse.json(student);
  } catch (e) {
    console.error("[/api/students/[id] GET]", e);
    return NextResponse.json({ error: "Student not found." }, { status: 404 });
  }
}

// PATCH /api/students/[id] — name, subject, generatorProfile, level, rate, notes,
// meetLink are editable. id is not patchable here.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    // Ownership check — block patching another user's student (IDOR).
    const owned = await prisma.student.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Student not found." }, { status: 404 });

    const body = await request.json();
    const data: Prisma.StudentUpdateInput = {};

    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ error: "Name cannot be empty." }, { status: 400 });
      }
      data.name = name;
    }
    if (typeof body.level === "string") data.level = body.level;
    if (typeof body.subject === "string") data.subject = body.subject.trim();
    // Normalize through getProfile so only a known key is ever stored.
    if (typeof body.generatorProfile === "string") data.generatorProfile = getProfile(body.generatorProfile).key;
    if (typeof body.notes === "string") data.notes = body.notes;
    if (body.rate !== undefined) {
      const rate = parseNonNegInt(body.rate);
      if (!rate.ok) {
        return NextResponse.json(
          { error: "Rate must be a non-negative number." },
          { status: 400 }
        );
      }
      data.rate = rate.value;
    }

    const meetLinkInBody = "meetLink" in body;
    if (meetLinkInBody) {
      if (body.meetLink === null || body.meetLink === "") {
        data.meetLink = null;
      } else if (typeof body.meetLink === "string") {
        // Allowlist a real Google Meet URL. A bare startsWith("http") check let any
        // host through (internal addresses, etc.) — the value is stored, rendered as
        // a clickable href, and written into GCal event bodies, so constrain it.
        const link = parseMeetLink(body.meetLink);
        if (!link) {
          return NextResponse.json(
            { error: "Meet link must be an https://meet.google.com URL." },
            { status: 400 }
          );
        }
        data.meetLink = link;
      } else {
        return NextResponse.json({ error: "Invalid Meet link." }, { status: 400 });
      }
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const student = await prisma.student.update({ where: { id }, data });

    // Propagate the new meetLink to all of this student's synced GCal events
    // after the response flushes — non-blocking.
    const account = meetLinkInBody ? await getGcalAccount(userId) : null;
    if (account) {
      const meetLink = student.meetLink;
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
          console.error("[/api/students/[id] PATCH] propagate failed (non-blocking):", e);
        }
      });
    }

    return NextResponse.json(student);
  } catch (e) {
    console.error("[/api/students/[id] PATCH]", e);
    return NextResponse.json({ error: "Save failed — try again." }, { status: 500 });
  }
}

// DELETE /api/students/[id] — removes the student and all their sessions
// (Session.studentId is required, so the sessions must go too). Mirrored GCal
// events are cleaned up in the background; never block the delete on Google.
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const owned = await prisma.student.findFirst({ where: { id, userId }, select: { id: true } });
    if (!owned) return NextResponse.json({ error: "Student not found." }, { status: 404 });

    const sessions = await prisma.session.findMany({
      where: { studentId: id, userId },
      select: { googleEventId: true },
    });

    await prisma.$transaction([
      prisma.session.deleteMany({ where: { studentId: id, userId } }),
      prisma.student.delete({ where: { id } }),
    ]);

    const eventIds = sessions
      .map((s) => s.googleEventId)
      .filter((e): e is string => Boolean(e));
    const account = eventIds.length ? await getGcalAccount(userId) : null;
    if (account) {
      after(async () => {
        for (const eventId of eventIds) {
          try {
            await deleteEvent(account, eventId);
          } catch (e) {
            console.error("GCal sync failed (student delete):", e);
          }
        }
      });
    }

    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[/api/students/[id] DELETE]", e);
    return NextResponse.json({ error: "Could not delete — try again." }, { status: 500 });
  }
}
