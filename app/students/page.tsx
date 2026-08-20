import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { daysBefore, ACTIVE_WINDOW_DAYS } from "@/lib/dates";
import Link from "next/link";
import StudentCard, { type StudentCardData } from "@/components/StudentCard";
import StudentsListControls from "@/components/StudentsListControls";
import PageHeader from "@/components/ui/PageHeader";
import EmptyState from "@/components/ui/EmptyState";
import { buttonClass } from "@/components/ui/Button";
import { Users } from "@/components/icons";

// Reads live DB data — render on demand, never prerender at build time.
export const dynamic = "force-dynamic";

// Students view. Server component: the roster, each student's derived learning
// history (last 3 covered topics), and what they owe.
//
// Money moved here when the Payments tab was removed: "who owes me" is a question
// about people, and answering it on the roster removes a whole surface without
// removing the answer. The per-student rollups are groupBy, not "load every session
// and reduce", so cost is bounded by student count rather than session count.
export default async function StudentsPage({
  searchParams,
}: {
  searchParams: Promise<{ unpaid?: string }>;
}) {
  const userId = await requireUserId();
  const { unpaid } = await searchParams;
  const unpaidOnly = unpaid === "1";

  const now = new Date();
  const activeSince = daysBefore(now, ACTIVE_WINDOW_DAYS);

  const [rows, owedByStudent, upcomingByStudent, lastSeenByStudent] = await Promise.all([
    prisma.student.findMany({
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
    }),
    // The SQL mirror of isOwed() in lib/session-status.ts — unpaid, started, not
    // cancelled. Keep the two in sync.
    prisma.session.groupBy({
      by: ["studentId"],
      where: { userId, paid: false, status: { not: "cancelled" }, start: { lte: now } },
      _sum: { amount: true },
      _count: true,
    }),
    // Does this student have anything on the books?
    prisma.session.groupBy({
      by: ["studentId"],
      where: { userId, status: { not: "cancelled" }, start: { gte: now } },
      _count: true,
    }),
    // ...and were they taught recently enough for that to matter? Without this,
    // students who finished months ago would flag forever.
    prisma.session.groupBy({
      by: ["studentId"],
      where: { userId, status: { not: "cancelled" }, start: { lt: now } },
      _max: { start: true },
    }),
  ]);

  const owedMap = new Map(owedByStudent.map((r) => [r.studentId, r]));
  const upcomingMap = new Map(upcomingByStudent.map((r) => [r.studentId, r._count]));
  const lastSeenMap = new Map(lastSeenByStudent.map((r) => [r.studentId, r._max.start]));

  const students: StudentCardData[] = rows.map((s) => {
    const owed = owedMap.get(s.id);
    const lastSeen = lastSeenMap.get(s.id);
    return {
      id: s.id,
      name: s.name,
      profile: s.profile,
      rate: s.rate,
      archived: s.archived,
      recentTopics: s.sessions.map((x) => ({ start: x.start.toISOString(), topic: x.topic })),
      owed: owed?._sum.amount ?? 0,
      unpaidCount: owed?._count ?? 0,
      // Archiving is a deliberate choice not to book more — the nag would be noise,
      // not a reminder, for a student the tutor already knows is done.
      needsBooking:
        !s.archived && !upcomingMap.get(s.id) && lastSeen != null && lastSeen >= activeSince,
    };
  });

  // Split by section rather than hide-behind-a-toggle: an archived student is never
  // suppressed, just moved to "Past students" below — so a balance can never quietly
  // fall off the radar the way a hidden-by-default filter risks doing.
  const active = students.filter((s) => !s.archived);
  const past = students.filter((s) => s.archived);

  // Filtering in app code rather than SQL: the roster is small (it's one tutor's
  // students), the owed totals are already in hand, and a `where` on an aggregate
  // would need a second round trip to say how many were hidden.
  const shownActive = unpaidOnly ? active.filter((s) => s.owed > 0) : active;
  const shownPast = unpaidOnly ? past.filter((s) => s.owed > 0) : past;
  const shownTotal = shownActive.length + shownPast.length;

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <PageHeader
        title="Students"
        description={
          students.length === 0
            ? undefined
            : `${students.length} student${students.length === 1 ? "" : "s"} on the roster.`
        }
        actions={
          students.length > 0 ? (
            <StudentsListControls unpaid={unpaidOnly} total={students.length} shown={shownTotal} />
          ) : undefined
        }
      />

      {students.length === 0 ? (
        <EmptyState
          icon={<Users className="h-4 w-4" />}
          title="No students yet."
          action={
            <Link href="/" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Add one from the calendar
            </Link>
          }
        />
      ) : shownTotal === 0 ? (
        <EmptyState
          icon={<Users className="h-4 w-4" />}
          title="Nobody owes anything right now."
          action={
            <Link href="/students" className={buttonClass({ variant: "secondary", size: "sm" })}>
              Show everyone
            </Link>
          }
        />
      ) : (
        <>
          {shownActive.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
              {shownActive.map((s) => (
                <StudentCard key={s.id} student={s} />
              ))}
            </div>
          )}

          {shownPast.length > 0 && (
            <section className="space-y-3 border-t border-hairline pt-6">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">
                Past students
              </h2>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                {shownPast.map((s) => (
                  <StudentCard key={s.id} student={s} />
                ))}
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
