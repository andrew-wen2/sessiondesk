import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { getCurrentUserId } from "@/lib/session";
import { parseDateBound, exclusiveEndOfDay, toDateKey } from "@/lib/dates";
import { toCsv } from "@/lib/download-csv";
import {
  normalizeStatus,
  effectiveStatus,
  owedAmount,
  STATUS_LABEL,
} from "@/lib/session-status";

// GET /api/sessions/export — every session for the current user as CSV.
//
// The per-student export in StudentPayments is built in the browser from the rendered
// rows, so it matches the screen including an optimistic mark-paid. The roster can't
// do that: it holds owed totals, not the sessions behind them. Hence a server route —
// and it reuses toCsv(), so both exports share the formula-injection neutralisation
// and the Excel BOM rather than growing a second CSV writer.

// Same ceiling as the student view. An export is the one place a tutor might
// legitimately want everything, but an unbounded query is still how this page dies.
const MAX_ROWS = 5000;

export async function GET(request: Request) {
  try {
    const userId = await getCurrentUserId();
    if (!userId) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

    const { searchParams } = new URL(request.url);
    const fromDate = parseDateBound(searchParams.get("from") ?? undefined);
    const toBound = parseDateBound(searchParams.get("to") ?? undefined);
    const toDate = toBound ? exclusiveEndOfDay(toBound) : null;

    const sessions = await prisma.session.findMany({
      where: {
        userId,
        ...(fromDate || toDate
          ? { start: { ...(fromDate ? { gte: fromDate } : {}), ...(toDate ? { lt: toDate } : {}) } }
          : {}),
      },
      select: {
        id: true,
        start: true,
        topic: true,
        amount: true,
        paid: true,
        status: true,
        student: { select: { name: true } },
      },
      orderBy: [{ start: "desc" }],
      take: MAX_ROWS,
    });

    // Computed once for the whole file so every row is judged against the same
    // instant — the same reason the client components take `now` as a prop.
    const now = Date.now();

    // Columns match the student-page export so the two files concatenate cleanly.
    const rows: string[][] = [["Date", "Student", "Topic", "Amount", "Status", "Paid", "Owed"]];
    for (const s of sessions) {
      const status = normalizeStatus(s.status);
      rows.push([
        toDateKey(s.start),
        s.student.name,
        s.topic,
        String(s.amount),
        STATUS_LABEL[effectiveStatus(status, s.start, now)],
        s.paid ? "yes" : "no",
        String(owedAmount({ paid: s.paid, start: s.start, status, amount: s.amount }, now)),
      ]);
    }

    return new NextResponse(toCsv(rows), {
      headers: {
        "Content-Type": "text/csv;charset=utf-8",
        "Content-Disposition": `attachment; filename="sessions-${toDateKey(new Date())}.csv"`,
        // A financial export must never be served from a cache to the next request.
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("[/api/sessions/export]", e);
    return NextResponse.json(
      { error: "Could not build the export — try again." },
      { status: 500 }
    );
  }
}
