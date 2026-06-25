import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { createEvent, toSessionForGCal, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";

// POST /api/sessions/[id]/sync — retry the GCal mirror for one session whose
// googleEventId is still null.
export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    // Select only the fields needed to create the GCal event — skip problems/homework/etc.
    // meetLink is now on the student, not the session.
    const session = await prisma.session.findFirst({
      where: { id, userId },
      select: SESSION_FOR_GCAL_SELECT,
    });
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    if (session.googleEventId) {
      return NextResponse.json({ status: "already synced" });
    }
    const account = await getGcalAccount(userId);
    if (!account) {
      return NextResponse.json(
        { error: "Calendar not connected — connect Google Calendar first." },
        { status: 400 }
      );
    }

    const googleEventId = await createEvent(account, toSessionForGCal(session));
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
