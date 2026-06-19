import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import SessionDetail, { type SessionDetailData } from "@/components/SessionDetail";
import type { Problem } from "@/components/ProblemSet";
import { isGcalConfigured } from "@/lib/gcal-token";

// Session detail. Server shell: loads the session + student and hands a
// serializable object to the interactive client component.
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const row = await prisma.session
    .findUniqueOrThrow({
      where: { id },
      include: { student: true, book: { select: { id: true, title: true } } },
    })
    .catch(() => null);

  if (!row) notFound();

  const session: SessionDetailData = {
    id: row.id,
    start: row.start.toISOString(),
    durationMin: row.durationMin,
    topic: row.topic,
    homework: row.homework,
    paid: row.paid,
    amount: row.amount,
    problems: (row.problems as unknown as Problem[] | null) ?? null,
    googleEventId: row.googleEventId,
    book: row.book,
    student: {
      id: row.student.id,
      name: row.student.name,
      level: row.student.level,
    },
  };

  return <SessionDetail session={session} gcalConfigured={isGcalConfigured()} />;
}
