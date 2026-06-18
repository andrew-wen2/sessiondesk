import { prisma } from "@/lib/prisma";
import Calendar from "@/components/Calendar";
import type { CalendarSession } from "@/lib/types";

// Calendar (default view). Server component: loads the visible month from the
// DB and hands serializable rows to the client grid.
export default async function CalendarPage({
  searchParams,
}: {
  searchParams: Promise<{ month?: string; student?: string }>;
}) {
  const { month: monthParam, student: studentId } = await searchParams;
  const month = monthParam ?? new Date().toISOString().slice(0, 7);
  const [year, mon] = month.split("-").map(Number);
  const start = new Date(year, mon - 1, 1);
  const end = new Date(year, mon, 1);

  const rows = await prisma.session.findMany({
    where: {
      start: { gte: start, lt: end },
      ...(studentId ? { studentId } : {}),
    },
    include: { student: { select: { name: true } } },
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

  return <Calendar month={month} sessions={sessions} studentFilter={studentFilter} />;
}
