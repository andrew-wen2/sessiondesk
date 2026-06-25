import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { createEvent, updateEvent, toSessionForGCal, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";

// POST /api/sessions/sync-all — reconcile the DB → GCal mirror for one month.
// Backfills events for sessions whose googleEventId is null and patches the
// rest to match current DB state. Scoped to the visible month (body { month })
// so it mirrors exactly what the calendar shows; "all sessions" would be an
// unbounded loop. The DB is the source of truth — per-session Google failures
// are counted, never thrown, so one bad event can't abort the batch.
export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const account = await getGcalAccount(userId);
    if (!account) {
      return NextResponse.json(
        { error: "Calendar not connected — connect Google Calendar first." },
        { status: 400 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const month = typeof body.month === "string" ? body.month : "";
    if (!/^\d{4}-\d{2}$/.test(month)) {
      return NextResponse.json({ error: "Invalid month — reload and try again." }, { status: 400 });
    }

    // Same range math as the calendar page (app/page.tsx).
    const [year, mon] = month.split("-").map(Number);
    const start = new Date(year, mon - 1, 1);
    const end = new Date(year, mon, 1);

    const sessions = await prisma.session.findMany({
      where: { userId, start: { gte: start, lt: end } },
      select: SESSION_FOR_GCAL_SELECT,
      orderBy: { start: "asc" },
    });

    let created = 0;
    let patched = 0;
    let failed = 0;

    // Sequential on purpose: the volume is tiny and serial avoids bursting the
    // Google rate limit.
    for (const s of sessions) {
      const forGcal = toSessionForGCal(s);
      try {
        if (s.googleEventId) {
          // updateEvent self-heals: if the event was cleared/deleted on Google
          // it recreates it and returns a new id we must persist. Counts as a
          // create when recreated, a patch when updated in place.
          const newId = await updateEvent(account, s.googleEventId, forGcal);
          if (newId !== s.googleEventId) {
            await prisma.session.update({ where: { id: s.id }, data: { googleEventId: newId } });
            created++;
          } else {
            patched++;
          }
        } else {
          const googleEventId = await createEvent(account, forGcal);
          await prisma.session.update({ where: { id: s.id }, data: { googleEventId } });
          created++;
        }
      } catch (e) {
        console.error("[/api/sessions/sync-all]", e);
        failed++;
      }
    }

    return NextResponse.json({ created, patched, failed, total: sessions.length });
  } catch (e) {
    console.error("[/api/sessions/sync-all POST]", e);
    return NextResponse.json({ error: "Sync failed — try again." }, { status: 500 });
  }
}
