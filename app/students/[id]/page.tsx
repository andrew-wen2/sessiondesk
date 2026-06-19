import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import StudentDetail, { type StudentDetailData } from "@/components/StudentDetail";
import StudentNameEditor from "@/components/StudentNameEditor";
import LearningHistory, { type HistoryItem } from "@/components/LearningHistory";
import DeleteStudentButton from "@/components/DeleteStudentButton";

// Student detail. Server shell: loads the student and full derived learning
// history; hands editable fields to the client editor.
export default async function StudentPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;

  const row = await prisma.student
    .findUniqueOrThrow({
      where: { id },
      include: {
        sessions: {
          where: { topic: { not: "" } },
          orderBy: { start: "desc" },
          select: { start: true, topic: true },
        },
      },
    })
    .catch(() => null);

  if (!row) notFound();

  const student: StudentDetailData = {
    id: row.id,
    name: row.name,
    level: row.level,
    rate: row.rate,
    notes: row.notes ?? "",
  };

  const history: HistoryItem[] = row.sessions.map((s) => ({
    start: s.start.toISOString(),
    topic: s.topic,
  }));

  return (
    <div className="space-y-6">
      <Link href="/students" className="text-sm text-blue-600 hover:underline">
        ← All students
      </Link>

      <div className="flex flex-wrap items-center gap-2">
        <StudentNameEditor id={student.id} initialName={student.name} />
        <Link
          href={`/?student=${student.id}`}
          className="ml-auto text-sm text-blue-600 hover:underline"
        >
          View sessions on calendar →
        </Link>
      </div>

      <StudentDetail student={student} />

      <section>
        <h2 className="text-sm font-semibold text-gray-500">Learning history</h2>
        <p className="text-xs text-gray-400">All covered topics, most recent first.</p>
        <div className="mt-2">
          <LearningHistory items={history} emptyText="No topics covered yet." />
        </div>
      </section>

      <section className="border-t border-gray-100 pt-4">
        <DeleteStudentButton id={student.id} name={student.name} redirectTo="/students" />
      </section>
    </div>
  );
}
