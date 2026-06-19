import { NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { deleteEvent } from "@/lib/gcal";
import { isGcalConfigured } from "@/lib/gcal-token";

// GET /api/students/[id] — single student.
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const student = await prisma.student.findUniqueOrThrow({ where: { id } });
    return NextResponse.json(student);
  } catch (e) {
    console.error("[/api/students/[id] GET]", e);
    return NextResponse.json({ error: "Student not found." }, { status: 404 });
  }
}

// PATCH /api/students/[id] — name, level, rate, notes are editable. id is not
// patchable here.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
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
    if (typeof body.notes === "string") data.notes = body.notes;
    if (body.rate !== undefined) {
      const rate = Number(body.rate);
      if (!Number.isFinite(rate) || rate < 0) {
        return NextResponse.json(
          { error: "Rate must be a non-negative number." },
          { status: 400 }
        );
      }
      data.rate = Math.round(rate);
    }

    if (Object.keys(data).length === 0) {
      return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
    }

    const student = await prisma.student.update({ where: { id }, data });
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
    const sessions = await prisma.session.findMany({
      where: { studentId: id },
      select: { googleEventId: true },
    });

    await prisma.$transaction([
      prisma.session.deleteMany({ where: { studentId: id } }),
      prisma.student.delete({ where: { id } }),
    ]);

    if (isGcalConfigured()) {
      const eventIds = sessions
        .map((s) => s.googleEventId)
        .filter((e): e is string => Boolean(e));
      if (eventIds.length) {
        after(async () => {
          for (const eventId of eventIds) {
            try {
              await deleteEvent(eventId);
            } catch (e) {
              console.error("GCal sync failed (student delete):", e);
            }
          }
        });
      }
    }

    return NextResponse.json({ deleted: true });
  } catch (e) {
    console.error("[/api/students/[id] DELETE]", e);
    return NextResponse.json({ error: "Could not delete — try again." }, { status: 500 });
  }
}
