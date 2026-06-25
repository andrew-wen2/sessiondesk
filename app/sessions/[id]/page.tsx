import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import SessionDetail, { type SessionDetailData } from "@/components/SessionDetail";
import type { Problem } from "@/components/ProblemSet";
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

  // Fetch the session and the book-selector options in parallel — the books list
  // was previously fetched client-side after mount, an avoidable round-trip.
  const [row, books] = await Promise.all([
    prisma.session
      .findFirstOrThrow({
        where: { id, userId },
        include: { student: true, book: { select: { id: true, title: true } } },
      })
      .catch(() => null),
    prisma.book.findMany({
      where: { userId },
      orderBy: { title: "asc" },
      select: { id: true, title: true },
    }),
  ]);

  if (!row) notFound();

  const session: SessionDetailData = {
    id: row.id,
    start: row.start.toISOString(),
    durationMin: row.durationMin,
    topic: row.topic,
    paid: row.paid,
    amount: row.amount,
    problems: (row.problems as unknown as Problem[] | null) ?? null,
    googleEventId: row.googleEventId,
    // meetLink is now on the student — source it from there.
    meetLink: row.student.meetLink ?? null,
    book: row.book,
    student: {
      id: row.student.id,
      name: row.student.name,
      level: row.student.level,
    },
  };

  return (
    <SessionDetail session={session} books={books} gcalConfigured={await isGcalConnected(userId)} />
  );
}
