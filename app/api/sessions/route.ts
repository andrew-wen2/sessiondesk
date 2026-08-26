import { NextResponse, after } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { createEvent, toSessionForGCal, SESSION_FOR_GCAL_SELECT } from "@/lib/gcal";
import { getGcalAccount } from "@/lib/gcal-account";
import { parseNonNegInt, parseDate } from "@/lib/validation";
import { parseOccurrences } from "@/lib/recurrence";

// There is no GET here: the calendar is a server component and queries Prisma
// directly (app/page.tsx), so a month-listing endpoint had no callers.

// A repeating slot can create up to 52 sessions, each needing its own Calendar
// insert. Those run sequentially in after(), which is billed to this invocation's
// budget — the default limit would kill the loop partway.
export const maxDuration = 60;

// POST /api/sessions — create one session, or a whole recurring series.
//
// Body: { studentId, start | starts[], durationMin?, topic?, amount }
//   `start`  — a single ISO instant (the original, unchanged path).
//   `starts` — an array of ISO instants for a repeating slot. The CLIENT expands the
//              recurrence rule, because only the browser knows the tutor's timezone
//              and stepping calendar days in the wrong zone shifts the wall-clock
//              hour across a DST boundary (see lib/recurrence.ts). We never trust the
//              array: parseOccurrences bounds its length, order, and span.
export async function POST(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const body = await request.json();
    const studentId = typeof body.studentId === "string" ? body.studentId : "";
    const durationMin = body.durationMin != null ? Number(body.durationMin) : 60;
    const topic = typeof body.topic === "string" ? body.topic : "";

    if (!studentId) {
      return NextResponse.json({ error: "Pick a student first." }, { status: 400 });
    }

    let starts: Date[];
    if (body.starts !== undefined) {
      const parsed = parseOccurrences(body.starts);
      if (!parsed.ok) {
        return NextResponse.json(
          { error: "Invalid repeat schedule — reload and try again." },
          { status: 400 }
        );
      }
      starts = parsed.value;
    } else {
      const start = parseDate(typeof body.start === "string" ? body.start : "");
      if (!start.ok) {
        return NextResponse.json({ error: "Invalid date/time." }, { status: 400 });
      }
      starts = [start.value];
    }

    const amount = parseNonNegInt(body.amount);
    if (!amount.ok) {
      return NextResponse.json({ error: "Rate must be a non-negative number." }, { status: 400 });
    }

    // The student must belong to this user — block linking a session to another
    // user's records.
    const student = await prisma.student.findFirst({
      where: { id: studentId, userId },
      select: { id: true },
    });
    if (!student) {
      return NextResponse.json({ error: "Pick a student first." }, { status: 400 });
    }

    const shared = {
      userId,
      studentId,
      durationMin: Number.isFinite(durationMin) ? durationMin : 60,
      amount: amount.value,
    };

    let sessions;
    if (starts.length === 1) {
      // Single create goes through create(), which RETURNS the row it made. The
      // series path below can't use that (createMany yields only a count), but it
      // must not be used here either: a re-read keyed on (studentId, start) is not
      // unique — a student can legitimately have two sessions at the same instant,
      // and the calendar already lays overlapping sessions out side by side — so it
      // could hand back a different session's id than the one just created.
      sessions = [
        await prisma.session.create({
          data: { ...shared, start: starts[0], topic },
          select: SESSION_FOR_GCAL_SELECT,
        }),
      ];
    } else {
      // A series id only means something when there's more than one occurrence to
      // group; a lone session stays standalone so it never shows scope controls.
      // "What we'll cover" applies to this booking only, not the whole series — the
      // same rule series edits already follow (see lib/session-status.ts): topic
      // feeds the learning history per session, so stamping it onto every future
      // occurrence up front would rewrite history that hasn't happened yet.
      const seriesId = crypto.randomUUID();
      await prisma.session.createMany({
        data: starts.map((start, i) => ({ ...shared, start, seriesId, topic: i === 0 ? topic : "" })),
      });
      // Re-read for the GCal mirror, which needs the nested student select. Keyed on
      // the freshly-minted seriesId, so it matches exactly this batch — and scoped by
      // userId too, never by the grouping key alone.
      sessions = await prisma.session.findMany({
        where: { userId, seriesId },
        select: SESSION_FOR_GCAL_SELECT,
        orderBy: { start: "asc" },
      });
    }

    // Mirror to Google Calendar after the response flushes — never block the
    // create on a Google round-trip. Each session is already saved; a GCal
    // failure just leaves googleEventId null ("not synced" flag + retry).
    const account = await getGcalAccount(userId);
    if (account) {
      after(async () => {
        // Sequential, and each id persisted as soon as its event exists rather than
        // batched at the end: if the invocation is killed partway through a long
        // series, the occurrences already created stay correctly linked and the rest
        // are left null for the "Sync all to Calendar" backfill to pick up.
        for (const session of sessions) {
          try {
            const googleEventId = await createEvent(account, toSessionForGCal(session));
            await prisma.session.update({
              where: { id: session.id },
              data: { googleEventId },
            });
          } catch (e) {
            console.error("GCal sync failed (create):", e);
          }
        }
      });
    }

    // The client reads only res.ok and the count; return the first session so the
    // single-create response shape is unchanged.
    return NextResponse.json({ ...sessions[0], created: sessions.length }, { status: 201 });
  } catch (e) {
    console.error("[/api/sessions POST]", e);
    return NextResponse.json(
      { error: "Could not create session — try again." },
      { status: 500 }
    );
  }
}
