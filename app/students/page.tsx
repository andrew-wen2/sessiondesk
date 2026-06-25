import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import StudentCard, { type StudentCardData } from "@/components/StudentCard";

// Reads live DB data — render on demand, never prerender at build time.
export const dynamic = "force-dynamic";

// Students view. Server component: lists the user's students with their derived
// learning history (last 3 covered topics, most recent first).
export default async function StudentsPage() {
  const userId = await requireUserId();
  const rows = await prisma.student.findMany({
    where: { userId },
    orderBy: { name: "asc" },
    include: {
      sessions: {
        where: { topic: { not: "" } },
        orderBy: { start: "desc" },
        take: 3,
        select: { start: true, topic: true },
      },
    },
  });

  const students: StudentCardData[] = rows.map((s) => ({
    id: s.id,
    name: s.name,
    level: s.level,
    rate: s.rate,
    recentTopics: s.sessions.map((x) => ({ start: x.start.toISOString(), topic: x.topic })),
  }));

  return (
    <div className="space-y-4">
      <h1 className="text-xl font-bold">Students</h1>
      {students.length === 0 ? (
        <p className="text-sm text-gray-500">No students yet — add one from the calendar.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {students.map((s) => (
            <StudentCard key={s.id} student={s} />
          ))}
        </div>
      )}
    </div>
  );
}
