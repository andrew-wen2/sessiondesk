import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { createEvent, updateEvent, deleteEvent, toSessionForGCal, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { monthBounds } from "@/lib/dates";

// Reconciling a month's sessions plus the orphan-cleanup pass makes one sequential
// Google Calendar call per row before the response returns.
export const maxDuration = 60;

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
    const range = monthBounds(month);
    if (!range) {
      return NextResponse.json({ error: "Invalid month — reload and try again." }, { status: 400 });
    }
    const { start, end } = range;

    // Cancelled sessions are excluded: a cancelled session is *supposed* to have no
    // event, so reconciling them would recreate everything the tutor just cancelled.
    const sessions = await prisma.session.findMany({
      where: { userId, start: { gte: start, lt: end }, status: { not: "cancelled" } },
      select: SESSION_FOR_GCAL_SELECT,
      orderBy: { start: "asc" },
    });

    let created = 0;
    let patched = 0;
    let failed = 0;
    let removed = 0;

    // Orphan pass: a cancelled session still holding a googleEventId means the
    // cancel-time delete failed after the DB link was nulled — or never ran. Nothing
    // else can find those events (the session-level retry path refuses cancelled
    // sessions), so this is the only thing that cleans them up.
    const orphans = await prisma.session.findMany({
      where: {
        userId,
        start: { gte: start, lt: end },
        status: "cancelled",
        googleEventId: { not: null },
      },
      select: { id: true, googleEventId: true },
    });
    for (const o of orphans) {
      if (!o.googleEventId) continue;
      try {
        await deleteEvent(account, o.googleEventId);
        await prisma.session.update({ where: { id: o.id }, data: { googleEventId: null } });
        removed++;
      } catch (e) {
        console.error("[/api/sessions/sync-all] cancelled orphan", e);
        failed++;
      }
    }

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

    return NextResponse.json({ created, patched, removed, failed, total: sessions.length });
  } catch (e) {
    console.error("[/api/sessions/sync-all POST]", e);
    return NextResponse.json({ error: "Sync failed — try again." }, { status: 500 });
  }
}
