import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import Calendar from "@/components/Calendar";
import GcalBanner from "@/components/GcalBanner";
import { isGcalConnected } from "@/lib/gcal-account";
import { pad } from "@/lib/format";
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
  const { month: monthParam, week: weekParam, view: viewParam, student: studentId } = await searchParams;
  const view = viewParam === "week" ? "week" : "month";

  const today = new Date();
  let start: Date;
  let end: Date;
  let month: string; // YYYY-MM for the header/toggle
  let weekStart: string; // YYYY-MM-DD (Sunday) of the shown week

  if (view === "week") {
    const anchor = weekParam ? new Date(`${weekParam}T00:00:00`) : today;
    const sunday = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate() - anchor.getDay());
    start = sunday;
    end = new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + 7);
    weekStart = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}-${pad(sunday.getDate())}`;
    month = `${sunday.getFullYear()}-${pad(sunday.getMonth() + 1)}`;
  } else {
    month = monthParam ?? today.toISOString().slice(0, 7);
    const [year, mon] = month.split("-").map(Number);
    start = new Date(year, mon - 1, 1);
    end = new Date(year, mon, 1);
    const s = new Date(today.getFullYear(), today.getMonth(), today.getDate() - today.getDay());
    weekStart = `${s.getFullYear()}-${pad(s.getMonth() + 1)}-${pad(s.getDate())}`;
  }

  // Calendar chips + preview need id/start/duration/paid/amount/topic and the
  // student name — skip problems/lesson (heavy Json) and other unused fields.
  const rows = await prisma.session.findMany({
    where: {
      userId,
      start: { gte: start, lt: end },
      ...(studentId ? { studentId } : {}),
    },
    select: {
      id: true,
      start: true,
      durationMin: true,
      topic: true,
      paid: true,
      amount: true,
      studentId: true,
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
  }));

  const studentFilter = studentId
    ? { id: studentId, name: rows[0]?.student.name ?? "student" }
    : null;

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
      />
    </div>
  );
}
