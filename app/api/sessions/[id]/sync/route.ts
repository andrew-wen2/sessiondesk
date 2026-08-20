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

    // Select only the fields needed to create the GCal event, plus `status` for the
    // cancelled guard below. meetLink is on the student, not the session.
    const session = await prisma.session.findFirst({
      where: { id, userId },
      select: { ...SESSION_FOR_GCAL_SELECT, status: true },
    });
    if (!session) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    if (session.googleEventId) {
      return NextResponse.json({ status: "already synced", googleEventId: session.googleEventId });
    }
    // A cancelled session is *supposed* to have no event — a null googleEventId is
    // the correct state here, not a failed sync. Without this guard the retry path
    // would recreate the event cancelling just deleted.
    if (session.status === "cancelled") {
      return NextResponse.json(
        { error: "Cancelled sessions aren't mirrored to Calendar." },
        { status: 400 }
      );
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
