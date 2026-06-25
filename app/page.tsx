import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import Calendar from "@/components/Calendar";
import GcalBanner from "@/components/GcalBanner";
import { isGcalConnected } from "@/lib/gcal-account";
import type { CalendarSession } from "@/lib/types";

// Calendar (default view). Server component: loads the visible month from the
// DB and hands serializable rows to the client grid.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; student?: string }>;
}) {
  const userId = await requireUserId();
  const { month: monthParam, student: studentId } = await searchParams;
  const month = monthParam ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 1);

  // Calendar chips need id/start/paid/amount and student name only — skip
  // problems (heavy Json), homework, and other unused fields.
  const rows = await prisma.session.findMany({
    where: {
      userId,
      start: { gte: start, lt: end },
      ...(studentId ? { studentId } : {}),
    },
    select: {
      id: true,
      start: true,
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
    paid: s.paid,
    amount: s.amount,
    studentName: s.student.name,
  }));

  const studentFilter = studentId
    ? { id: studentId, name: rows[0]?.student.name ?? "student" }
    : null;

  const gcalConnected = await isGcalConnected(userId);

  return (
    <div className="space-y-6">
      <GcalBanner />
      <Calendar
        month={month}
        sessions={sessions}
        studentFilter={studentFilter}
        gcalConfigured={gcalConnected}
      />
    </div>
  );
}
