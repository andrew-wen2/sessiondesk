import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import SessionDetail, { type SessionDetailData } from "@/components/SessionDetail";
import type { Problem } from "@/components/ProblemSet";
import type { Lesson } from "@/lib/types";
import { isGcalConnected } from "@/lib/gcal-account";
import { normalizeStatus } from "@/lib/session-status";

// Session detail. Server shell: loads the session + student and hands a
// serializable object to the interactive client component.
export default async function SessionPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { id } = await params;
  const { from } = await searchParams;
  const userId = await requireUserId();

  // The calendar hands its exact view/date back through `?from=` so "Back to
  // calendar" returns to the week/month you were looking at rather than always
  // landing on the default (today's) one. Same open-redirect guard as the login
  // page's `from`: only a same-app relative path is honored.
  const backHref = from && from.startsWith("/") && !from.startsWith("//") ? from : "/";

  const row = await prisma.session
    .findFirstOrThrow({
      where: { id, userId },
      include: { student: true },
    })
    .catch(() => null);

  if (!row) notFound();

  // How many later sessions share this one's recurrence series — drives the
  // "this and all future" scope controls. Only queried when the session is
  // actually part of a series; standalone sessions skip the round trip entirely.
  const laterInSeries = row.seriesId
    ? await prisma.session.count({
        where: { userId, seriesId: row.seriesId, start: { gt: row.start } },
      })
    : 0;

  const session: SessionDetailData = {
    id: row.id,
    start: row.start.toISOString(),
    durationMin: row.durationMin,
    topic: row.topic,
    paid: row.paid,
    amount: row.amount,
    status: normalizeStatus(row.status),
    seriesId: row.seriesId,
    laterInSeries,
    problems: (row.problems as unknown as Problem[] | null) ?? null,
    lesson: (row.lesson as unknown as Lesson | null) ?? null,
    googleEventId: row.googleEventId,
    // meetLink is now on the student — source it from there.
    meetLink: row.student.meetLink ?? null,
    student: {
      id: row.student.id,
      name: row.student.name,
    },
  };

  return (
    <div className="mx-auto max-w-4xl">
      <SessionDetail
        session={session}
        backHref={backHref}
        gcalConfigured={await isGcalConnected(userId)}
      />
    </div>
  );
}
