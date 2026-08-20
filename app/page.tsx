import { cookies } from "next/headers";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import Calendar from "@/components/Calendar";
import GcalBanner from "@/components/GcalBanner";
import { isGcalConnected } from "@/lib/gcal-account";
import { pad } from "@/lib/format";
import { normalizeStatus } from "@/lib/session-status";
import type { CalendarSession } from "@/lib/types";

// Calendar (default view). Server component: loads the visible range (a month or a
// week) from the DB and hands serializable rows to the client grid. A week can span
// two months, so the query range is derived from view + anchor, not assumed monthly.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; week?: string; view?: string; student?: string }>;
}) {
  const userId = await requireUserId();
  const { month: monthParam, week: weekParam, view: viewParam, student: studentId } =
    await searchParams;
  // View preference: an explicit ?view= wins (deep links, prev/next), otherwise fall
  // back to the viewer's last-used view stored in the `calView` cookie (written client-side
  // by the calendar), defaulting to month. This makes the Calendar nav link and bare `/`
  // reopen whichever view the tutor was last in. A stale `calView=day` cookie from before
  // Day view was removed simply falls through to the "month" default below.
  const savedView = (await cookies()).get("calView")?.value;
  const isView = (v: string | undefined): v is "month" | "week" => v === "month" || v === "week";
  const view: "month" | "week" = isView(viewParam) ? viewParam : isView(savedView) ? savedView : "month";

  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

  let start: Date;
  let end: Date;
  let month: string; // YYYY-MM for the header/toggle
  let weekStart: string; // YYYY-MM-DD (Sunday) of the shown week

  if (view === "week") {
    const anchor = weekParam ? new Date(`${weekParam}T00:00:00`) : today;
    const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    start = sunday;
    end = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
    weekStart = iso(sunday);
    month = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}`;
  } else {
    month = monthParam ?? today.toISOString().slice(0, 7);
    const [year, mon] = month.split("-").map(Number);
    start = new Date(year, mon - 1, 1);
    end = new Date(year, mon, 1);
    weekStart = iso(new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay()));
  }

  // The server runs in UTC but the client buckets sessions by the viewer's LOCAL day,
  // so these UTC day-boundaries can sit up to ~14h off the local week/month edges — which
  // was dropping e.g. Saturday-evening sessions from the week query. Over-fetch a day on
  // each side; the client only renders the days it shows, so the extra rows are harmless.
  const queryStart = new Date(start);
  queryStart.setDate(queryStart.getDate() - 1);
  const queryEnd = new Date(end);
  queryEnd.setDate(queryEnd.getDate() + 1);

  // Calendar chips + preview need id/start/duration/paid/amount/topic and the
  // student name — skip problems/lesson (heavy Json) and other unused fields.
  const rows = await prisma.session.findMany({
    where: {
      userId,
      start: { gte: queryStart, lt: queryEnd },
      ...(studentId ? { studentId } : {}),
    },
    select: {
      id: true,
      start: true,
      durationMin: true,
      topic: true,
      paid: true,
      amount: true,
      status: true,
      studentId: true,
      // Not rendered on a chip — only counted, to tell the tutor how many events
      // "Sync all" would actually create. This used to be a dashboard flag pointing
      // back here; it now sits next to the button that fixes it.
      googleEventId: true,
      student: { select: { name: true } },
    },
    orderBy: { start: "asc" },
  });

  const sessions: CalendarSession[] = rows.map((s) => ({
    id: s.id,
    start: s.start.toISOString(),
    durationMin: s.durationMin,
    paid: s.paid,
    amount: s.amount,
    studentName: s.student.name,
    topic: s.topic,
    status: normalizeStatus(s.status),
  }));

  const studentFilter = studentId
    ? { id: studentId, name: rows[0]?.student.name ?? "student" }
    : null;

  // A cancelled session is MEANT to have no event, so it isn't missing one. No clock
  // reading here: this is a property of the rows, and the calendar both SSRs and
  // hydrates, so anything derived from "now" would risk disagreeing across the two.
  const unsyncedCount = rows.filter(
    (s) => !s.googleEventId && normalizeStatus(s.status) !== "cancelled"
  ).length;

  const gcalConnected = await isGcalConnected(userId);

  return (
    <div className="space-y-6">
      <GcalBanner />
      <Calendar
        view={view}
        month={month}
        weekStart={weekStart}
        sessions={sessions}
        studentFilter={studentFilter}
        gcalConfigured={gcalConnected}
        unsyncedCount={unsyncedCount}
      />
    </div>
  );
}
