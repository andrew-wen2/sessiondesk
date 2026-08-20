import Link from "next/link";
import LearningHistory, { type HistoryItem } from "./LearningHistory";
import { Card } from "./ui/Card";
import Badge from "./ui/Badge";
import { AlertCircle } from "./icons";

export type StudentCardData = {
  id: string;
  name: string;
  profile: string;
  rate: number;
  archived: boolean;
  recentTopics: HistoryItem[]; // last 3, most recent first
  // Money owed by this student, all-time. The card is where money lives now that
  // there's no separate Payments tab, so the roster doubles as "who owes me".
  owed: number;
  unpaidCount: number;
  // Active (taught recently) but with nothing on the books. Was a dashboard
  // "needs attention" flag; it belongs on the student it's about. Never true for an
  // archived student — see app/students/page.tsx.
  needsBooking: boolean;
};

export default function StudentCard({ student }: { student: StudentCardData }) {
  const profile =
    student.profile.length > 80 ? `${student.profile.slice(0, 80)}…` : student.profile;

  return (
    <Card className="flex flex-col transition-shadow duration-150 hover:shadow-raise">
      <div className="flex items-start gap-3 px-5 pb-4 pt-4">
        <span
          className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
            student.archived ? "bg-sunken text-muted" : "bg-primary-soft text-primary"
          }`}
          aria-hidden
        >
          {student.name.trim().charAt(0).toUpperCase() || "?"}
        </span>
        <div className="min-w-0 flex-1">
          <Link
            href={`/students/${student.id}`}
            className="font-semibold text-ink transition-colors duration-150 hover:text-primary"
          >
            {student.name}
          </Link>
          <p className="mt-0.5 text-sm text-muted">
            {profile || <span className="text-faint">No profile set.</span>}
          </p>
        </div>
        <span className="shrink-0 font-mono text-sm text-ink-soft">${student.rate}</span>
      </div>

      {/* Every flag carries text as well as tint — the orange (or the archived
          grey) is a second signal, not the only one. */}
      {(student.archived || student.owed > 0 || student.needsBooking) && (
        <div className="-mt-1 flex flex-wrap items-center gap-2 px-5 pb-4">
          {student.archived && <Badge tone="neutral">Archived</Badge>}
          {student.owed > 0 && (
            <Link href={`/students/${student.id}?unpaid=1`}>
              <Badge tone="warn" className="transition-colors duration-150 hover:bg-warn/15">
                <span className="font-mono">${student.owed}</span> owed ·{" "}
                {student.unpaidCount} session{student.unpaidCount === 1 ? "" : "s"}
              </Badge>
            </Link>
          )}
          {student.needsBooking && (
            <Link href={`/?student=${student.id}`}>
              <Badge tone="neutral" className="transition-colors duration-150 hover:bg-hairline">
                <AlertCircle className="h-3 w-3" />
                No session booked
              </Badge>
            </Link>
          )}
        </div>
      )}

      {/* mt-auto: the history block sits on the card floor, so the rule lines up
          across every card in a row regardless of how long each profile runs. */}
      <div className="mt-auto border-t border-hairline px-5 py-3">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted">
          Learning history
        </div>
        <div className="mt-1.5">
          <LearningHistory items={student.recentTopics} emptyText="No topics covered yet." />
        </div>
      </div>
    </Card>
  );
}
