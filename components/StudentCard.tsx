import Link from "next/link";
import LearningHistory, { type HistoryItem } from "./LearningHistory";

export type StudentCardData = {
  id: string;
  name: string;
  subject: string;
  level: string;
  rate: number;
  recentTopics: HistoryItem[]; // last 3, most recent first
};

export default function StudentCard({ student }: { student: StudentCardData }) {
  const level =
    student.level.length > 80 ? `${student.level.slice(0, 80)}…` : student.level;

  return (
    <div className="space-y-3 rounded-lg border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Link href={`/students/${student.id}`} className="font-semibold text-blue-600 hover:underline">
            {student.name}
          </Link>
        </div>
        <span className="shrink-0 font-mono text-sm text-gray-700">${student.rate}</span>
      </div>

      <p className="text-sm text-gray-600">{level || "No level set."}</p>

      <div>
        <div className="text-xs font-semibold text-gray-500">Learning history</div>
        <div className="mt-1">
          <LearningHistory items={student.recentTopics} emptyText="No topics covered yet." />
        </div>
      </div>
    </div>
  );
}
