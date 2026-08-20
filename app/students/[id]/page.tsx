import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { isGcalConnected } from "@/lib/gcal-account";
import { parseDateBound, exclusiveEndOfDay, toDateKey } from "@/lib/dates";
import { normalizeStatus } from "@/lib/session-status";
import StudentDetail, { type StudentDetailData } from "@/components/StudentDetail";
import StudentNameEditor from "@/components/StudentNameEditor";
import LearningHistory, { type HistoryItem } from "@/components/LearningHistory";
import StudentPayments, { type PaymentRow } from "@/components/StudentPayments";
import DeleteStudentButton from "@/components/DeleteStudentButton";
import ArchiveStudentButton from "@/components/ArchiveStudentButton";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import Badge from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { CalendarDays, ChevronLeft } from "@/components/icons";

// Reads live DB data — render on demand, never prerender at build time.
export const dynamic = "force-dynamic";

// Rows loaded per view. The old ledger once loaded every session ever, which grows
// without bound; this caps it and the UI says so when the cap is hit.
const MAX_ROWS = 500;

// Default window when no dates are given — recent enough to be the useful view,
// wide enough to cover anything still unpaid in practice.
const DEFAULT_DAYS = 90;

// Student detail. Server shell: loads the student, the full derived learning history,
// and their payment rows for the selected range; hands editable fields to the client
// editor. Payments live here rather than on a separate tab — money is a question about
// a person, and this is the page about that person.
export default async function StudentPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string; to?: string; all?: string; unpaid?: string }>;
}) {
  const { id } = await params;
  const { from, to, all, unpaid } = await searchParams;
  const userId = await requireUserId();

  const now = new Date();
  // "All time" needs its own flag: empty from/to is also what a first visit looks
  // like, and a first visit means the default window. Collapsing the two is why the
  // old ledger's "All" preset silently showed the same 90 days as its neighbour.
  const allTime = all === "1";
  const fromDate = allTime ? null : parseDateBound(from);
  const toBound = allTime ? null : parseDateBound(to);
  const toDate = toBound ? exclusiveEndOfDay(toBound) : null;

  // Fall back to the default window when neither bound PARSED, not merely when
  // neither was supplied: a malformed `?from=2026-02-31` would otherwise leave the
  // range unbounded below and quietly load the student's entire history.
  const usingDefault = !allTime && !fromDate && !toDate;
  const defaultFrom = new Date(now.getFullYear(), now.getMonth(), now.getDate() - DEFAULT_DAYS);
  const startBound = usingDefault ? defaultFrom : fromDate;
  const unpaidOnly = unpaid === "1";

  const [row, sessions] = await Promise.all([
    prisma.student
      .findFirstOrThrow({
        where: { id, userId },
        include: {
          sessions: {
            where: { topic: { not: "" } },
            orderBy: { start: "desc" },
            select: { start: true, topic: true },
          },
        },
      })
      .catch(() => null),
    // studentId is paired with userId in the where, so a URL-supplied id can only ever
    // narrow to this user's own rows — the ownership check is structural.
    prisma.session.findMany({
      where: {
        userId,
        studentId: id,
        ...(unpaidOnly ? { paid: false } : {}),
        ...(startBound || toDate
          ? { start: { ...(startBound ? { gte: startBound } : {}), ...(toDate ? { lt: toDate } : {}) } }
          : {}),
      },
      // Renders date/topic/amount/paid/status only — skip problems and lesson (heavy
      // Json), googleEventId, and the rest.
      select: { id: true, start: true, topic: true, amount: true, paid: true, status: true },
      orderBy: { start: "desc" },
      take: MAX_ROWS,
    }),
  ]);

  if (!row) notFound();

  const student: StudentDetailData = {
    id: row.id,
    name: row.name,
    profile: row.profile,
    rate: row.rate,
    notes: row.notes ?? "",
    meetLink: row.meetLink ?? null,
  };

  const history: HistoryItem[] = row.sessions.map((s) => ({
    start: s.start.toISOString(),
    topic: s.topic,
  }));

  const payments: PaymentRow[] = sessions.map((s) => ({
    id: s.id,
    start: s.start.toISOString(),
    topic: s.topic,
    amount: s.amount,
    paid: s.paid,
    status: normalizeStatus(s.status),
  }));

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <Link
        href="/students"
        className="inline-flex items-center gap-1 text-sm text-muted transition-colors duration-150 hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        All students
      </Link>

      <div className="flex flex-wrap items-center gap-3">
        <StudentNameEditor id={student.id} initialName={student.name} />
        {row.archived && <Badge tone="neutral">Archived</Badge>}
        <Link
          href={`/?student=${student.id}`}
          className={`ml-auto ${buttonClass({ variant: "secondary", size: "sm" })}`}
        >
          <CalendarDays className="h-3.5 w-3.5" />
          View on calendar
        </Link>
      </div>

      <StudentDetail student={student} gcalConfigured={await isGcalConnected(userId)} />

      <StudentPayments
        studentName={student.name}
        rows={payments}
        truncated={sessions.length === MAX_ROWS}
        maxRows={MAX_ROWS}
        now={now.getTime()}
        // Report the range that was actually QUERIED, not the raw params — otherwise
        // a malformed or ignored bound would leave the picker describing a range the
        // rows below it don't come from.
        filters={{
          from: startBound ? toDateKey(startBound) : "",
          to: toBound ? toDateKey(toBound) : "",
          all: allTime,
          unpaid: unpaidOnly,
        }}
      />

      <Card>
        <CardHeader title="Learning history" description="All covered topics, most recent first." />
        <CardBody>
          <LearningHistory items={history} emptyText="No topics covered yet." />
        </CardBody>
      </Card>

      <section className="space-y-3 border-t border-hairline pt-5">
        <ArchiveStudentButton id={student.id} archived={row.archived} />
        <DeleteStudentButton id={student.id} name={student.name} redirectTo="/students" />
      </section>
    </div>
  );
}
