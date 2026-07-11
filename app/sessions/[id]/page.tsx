import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import SessionDetail, { type SessionDetailData } from "@/components/SessionDetail";
import type { Problem } from "@/components/ProblemSet";
import type { Lesson } from "@/lib/types";
import { isGcalConnected } from "@/lib/gcal-account";

// Session detail. Server shell: loads the session + student and hands a
// serializable object to the interactive client component.
export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const userId = await requireUserId();

  const row = await prisma.session
    .findFirstOrThrow({
      where: { id, userId },
      include: { student: true },
    })
    .catch(() => null);

  if (!row) notFound();

  const session: SessionDetailData = {
    id: row.id,
    start: row.start.toISOString(),
    durationMin: row.durationMin,
    topic: row.topic,
    paid: row.paid,
    amount: row.amount,
    problems: (row.problems as unknown as Problem[] | null) ?? null,
    lesson: (row.lesson as unknown as Lesson | null) ?? null,
    googleEventId: row.googleEventId,
    // meetLink is now on the student — source it from there.
    meetLink: row.student.meetLink ?? null,
    student: {
      id: row.student.id,
      name: row.student.name,
      level: row.student.level,
      generatorProfile: row.student.generatorProfile,
    },
  };

  return (
    <div className="mx-auto max-w-4xl">
      <SessionDetail session={session} gcalConfigured={await isGcalConnected(userId)} />
    </div>
  );
}
