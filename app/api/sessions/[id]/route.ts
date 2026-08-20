import { NextResponse, after } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import {
  createEvent,
  updateEvent,
  deleteEvent,
  attachMeetLink,
  toSessionForGCal,
  SESSION_FOR_GCAL_SELECT,
} from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { parseNonNegInt, parsePositiveInt, parseDate } from "@/lib/validation";
import { isSessionStatus } from "@/lib/session-status";

// Editing or deleting "this and all future sessions" fans out to up to 52 rows,
// each with its own sequential Calendar call in after() — which is billed to this
// invocation's budget.
export const maxDuration = 60;

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

// PATCH /api/sessions/[id]?scope=this|future — partial update. Editable: topic,
// paid, status, problems, and the schedule fields start/durationMin/amount.
// studentId and googleEventId are never patchable from the client.
//
// `scope=future` additionally applies the SCHEDULE change to every later session in
// the same recurrence series: the start moves by the same delta (so a Tue→Wed move
// shifts the whole remaining series to Wednesdays), and duration/rate are copied
// across. Per-session content — topic, paid, status, problems — never propagates;
// topic in particular autosaves on a debounce and feeds the derived learning
// history, so propagating it would silently rewrite history as you type.
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const scope = new URL(request.url).searchParams.get("scope") === "future" ? "future" : "this";

    // The ownership check also loads what the status transition and the series
    // branch need — one query, three jobs. `start` must be read BEFORE the update:
    // it's both the delta origin and the boundary for "later in this series".
    const owned = await prisma.session.findFirst({
      where: { id, userId },
      select: { id: true, status: true, googleEventId: true, seriesId: true, start: true },
    });
    if (!owned) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    const body = await request.json();
    const data: Prisma.SessionUpdateInput = {};
    // Kept as typed locals too: the series branch needs the parsed values, and
    // reading them back off Prisma's update-input union is needlessly awkward.
    let newStart: Date | null = null;
    let newDuration: number | null = null;
    let newAmount: number | null = null;

    if (typeof body.topic === "string") data.topic = body.topic;
    if (typeof body.paid === "boolean") data.paid = body.paid;
    if (body.status !== undefined) {
      // Reject an unknown status loudly rather than normalizing it: this is an
      // explicit user action, and the DB CHECK constraint would 500 anyway.
      if (!isSessionStatus(body.status)) {
        return NextResponse.json({ error: "Invalid session status." }, { status: 400 });
      }
      data.status = body.status;
    }

    if (body.start !== undefined) {
      const start = parseDate(body.start);
      if (!start.ok) {
        return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
      }
      data.start = start.value;
      newStart = start.value;
    }
    if (body.durationMin !== undefined) {
      const d = parsePositiveInt(body.durationMin);
      if (!d.ok) {
        return NextResponse.json({ error: "Duration must be a positive number." }, { status: 400 });
      }
      data.durationMin = d.value;
      newDuration = d.value;
    }
    if (body.amount !== undefined) {
      const a = parseNonNegInt(body.amount);
      if (!a.ok) {
        return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
      }
      data.amount = a.value;
      newAmount = a.value;
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

    // Status ↔ Calendar state machine. A cancelled session has NO mirrored event:
    // the event is deleted and the link nulled in the same write, and recreated if
    // the session is later un-cancelled. Transitions among the other three statuses
    // touch Calendar not at all — eventBody() derives colour from `paid` and the
    // title from the student name, neither of which status affects.
    //
    // Cancelling DELETES the event; it must never patch it to Google's own
    // status:"cancelled". updateEvent (lib/gcal.ts) reads that status back as "this
    // event was cleared, recreate it" and would fight us in a loop. Do not
    // "simplify" this branch into an updateEvent call.
    const nextStatus = typeof data.status === "string" ? data.status : owned.status;
    const cancelling = nextStatus === "cancelled" && owned.status !== "cancelled";
    const uncancelling = owned.status === "cancelled" && nextStatus !== "cancelled";
    const cancelledEventId = cancelling ? owned.googleEventId : null;
    if (cancelling) data.googleEventId = null;

    const session = await prisma.session.update({
      where: { id },
      data,
      include: { student: { select: { name: true, profile: true, meetLink: true } } },
    });

    // "This and all future sessions": apply the SCHEDULE part of this edit to every
    // later occurrence in the series. Skipped entirely when the edit carries nothing
    // propagatable, so a topic keystroke never triggers a bulk write.
    if (scope === "future" && owned.seriesId) {
      const delta = newStart ? newStart.getTime() - owned.start.getTime() : 0;
      const propagatable: Prisma.SessionUpdateInput = {};
      if (newDuration !== null) propagatable.durationMin = newDuration;
      if (newAmount !== null) propagatable.amount = newAmount;

      if (delta !== 0 || Object.keys(propagatable).length > 0) {
        // `id: { not: id }` is load-bearing, not belt-and-braces: the anchor was
        // already updated above, so when the edit moves it LATER its new start also
        // satisfies `gt: owned.start` — it would be swept in here and shifted a
        // second time (a +25h move landed the anchor +50h out). Excluding it by id
        // is correct in both directions. Scoped by userId as well as seriesId —
        // never by the grouping key alone.
        const later = await prisma.session.findMany({
          where: {
            userId,
            seriesId: owned.seriesId,
            id: { not: id },
            start: { gt: owned.start },
          },
          select: { id: true, start: true, googleEventId: true, status: true },
        });

        // Shifting by a fixed ms delta keeps each occurrence's wall-clock time except
        // when the move crosses a DST boundary relative to its old instant (i.e. only
        // for moves within an hour of the 2am change). Re-deriving civil time per row
        // would need a tz-aware converter on a server that runs in UTC; not worth it.
        await prisma.$transaction(
          later.map((r) =>
            prisma.session.update({
              where: { id: r.id },
              data: {
                ...propagatable,
                ...(delta !== 0 ? { start: new Date(r.start.getTime() + delta) } : {}),
              },
            })
          )
        );

        const seriesAccount = later.some((r) => r.googleEventId) ? await getGcalAccount(userId) : null;
        if (seriesAccount) {
          after(async () => {
            // Sequential, matching every other bulk Google loop in the app.
            for (const r of later) {
              // Cancelled occurrences have no event by design — leave them alone.
              if (!r.googleEventId || r.status === "cancelled") continue;
              try {
                const row = await prisma.session.findFirst({
                  where: { id: r.id, userId },
                  select: SESSION_FOR_GCAL_SELECT,
                });
                if (!row) continue;
                const newId = await updateEvent(seriesAccount, r.googleEventId, toSessionForGCal(row));
                if (newId !== r.googleEventId) {
                  await prisma.session.update({ where: { id: r.id }, data: { googleEventId: newId } });
                }
              } catch (e) {
                console.error("GCal sync failed (series update):", e);
              }
            }
          });
        }
      }
    }

    // Mirror topic/time/duration/paid changes to the GCal event after the
    // response flushes — never block the save on a Google round-trip.
    // meetLink is now on the student; source it from there.
    const mirrored =
      data.topic !== undefined ||
      data.start !== undefined ||
      data.durationMin !== undefined ||
      data.paid !== undefined; // paid drives the event color (green/orange)

    const needsGcal = Boolean(cancelledEventId || uncancelling || (mirrored && session.googleEventId));
    const account = needsGcal ? await getGcalAccount(userId) : null;

    if (account && cancelledEventId) {
      after(async () => {
        try {
          await deleteEvent(account, cancelledEventId);
        } catch (e) {
          // The DB link is already null, so nothing can retry this from the session.
          // sync-all's cancelled-orphan pass is what eventually cleans it up.
          console.error("GCal sync failed (cancel):", e);
        }
      });
    } else if (account && uncancelling) {
      after(async () => {
        try {
          const googleEventId = await createEvent(account, toSessionForGCal(session));
          await prisma.session.update({ where: { id: session.id }, data: { googleEventId } });
        } catch (e) {
          console.error("GCal sync failed (un-cancel):", e);
        }
      });
    } else if (account && session.googleEventId) {
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

// DELETE /api/sessions/[id]?scope=this|future — remove the session and its mirrored
// GCal event (event deletion is best-effort; the DB row is the source of truth).
// `scope=future` also removes every later session in the same recurrence series —
// this is how you end a repeating slot.
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const scope = new URL(request.url).searchParams.get("scope") === "future" ? "future" : "this";

    const owned = await prisma.session.findFirst({
      where: { id, userId },
      select: { id: true, seriesId: true, start: true, googleEventId: true },
    });
    if (!owned) return NextResponse.json({ error: "Session not found." }, { status: 404 });

    // Collect the event ids BEFORE deleting the rows — afterwards there is nothing
    // left to read them from.
    let eventIds: string[];
    let deletedCount: number;

    if (scope === "future" && owned.seriesId) {
      // `gte` here (unlike the PATCH branch): this deletes the anchor too.
      const where = { userId, seriesId: owned.seriesId, start: { gte: owned.start } };
      const doomed = await prisma.session.findMany({ where, select: { googleEventId: true } });
      eventIds = doomed.map((s) => s.googleEventId).filter((e): e is string => Boolean(e));
      const res = await prisma.session.deleteMany({ where });
      deletedCount = res.count;
    } else {
      const deleted = await prisma.session.delete({ where: { id } });
      eventIds = deleted.googleEventId ? [deleted.googleEventId] : [];
      deletedCount = 1;
    }

    const account = eventIds.length ? await getGcalAccount(userId) : null;
    if (account) {
      after(async () => {
        // Sequential, per-item catch — one dead event can't abort the rest.
        for (const eventId of eventIds) {
          try {
            await deleteEvent(account, eventId);
          } catch (e) {
            console.error("GCal sync failed (delete):", e);
          }
        }
      });
    }

    return NextResponse.json({ deleted: true, count: deletedCount });
  } catch (e) {
    console.error("[/api/sessions/[id] DELETE]", e);
    return NextResponse.json({ error: "Could not delete — try again." }, { status: 500 });
  }
}
