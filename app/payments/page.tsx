import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import PaymentsLedger, { type LedgerGroup } from "@/components/PaymentsLedger";

// Reads live DB data — render on demand.
export const dynamic = "force-dynamic";

function getWeekBounds() {
  const now = new Date();
  const day = now.getDay(); // 0 = Sun
  const mon = new Date(now);
  mon.setDate(now.getDate() - ((day + 6) % 7));
  mon.setHours(0, 0, 0, 0);
  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 7);
  return { mon, sun };
}

// Payments ledger. Server component: loads all sessions, groups by student in
// app code, computes masthead stats.
export default async function PaymentsPage() {
  const userId = await requireUserId();
  // The ledger only renders id/start/topic/amount/paid and student name/id.
  // Skip problems (heavy Json), homework, googleEventId, and other unused fields.
  const sessions = await prisma.session.findMany({
    where: { userId },
    select: {
      id: true,
      studentId: true,
      start: true,
      topic: true,
      amount: true,
      paid: true,
      student: { select: { id: true, name: true } },
    },
    orderBy: [{ student: { name: "asc" } }, { start: "desc" }],
  });

  const map = new Map<string, LedgerGroup>();
  for (const s of sessions) {
    if (!map.has(s.studentId)) {
      map.set(s.studentId, { student: s.student, sessions: [] });
    }
    map.get(s.studentId)!.sessions.push({
      id: s.id,
      start: s.start.toISOString(),
      topic: s.topic,
      amount: s.amount,
      paid: s.paid,
    });
  }
  const groups = [...map.values()];

  const { mon, sun } = getWeekBounds();
  const thisWeek = sessions.filter((s) => s.start >= mon && s.start < sun).length;

  return (
    <div className="mx-auto max-w-4xl">
      <PaymentsLedger groups={groups} thisWeek={thisWeek} />
    </div>
  );
}
