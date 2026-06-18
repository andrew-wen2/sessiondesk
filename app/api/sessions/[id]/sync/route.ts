import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { createEvent } from "@/lib/gcal";
import { isGcalConfigured } from "@/lib/gcal-token";

// POST /api/sessions/[id]/sync — retry the GCal mirror for one session whose
// googleEventId is still null.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const session = await prisma.session.findUniqueOrThrow({
      where: { id },
      include: { student: true },
    });

    if (session.googleEventId) {
      return NextResponse.json({ status: "already synced" });
    }
    if (!isGcalConfigured()) {
      return NextResponse.json(
        { error: "Calendar not connected — connect Google Calendar first." },
        { status: 400 }
      );
    }

    const googleEventId = await createEvent({
      id: session.id,
      start: session.start,
      durationMin: session.durationMin,
      topic: session.topic,
      student: { name: session.student.name, subject: session.student.subject },
    });
    await prisma.session.update({ where: { id }, data: { googleEventId } });
    return NextResponse.json({ googleEventId });
  } catch (e) {
    console.error("[/api/sessions/[id]/sync POST]", e);
    return NextResponse.json(
      { error: "Calendar sync failed — try again." },
      { status: 500 }
    );
  }
}
