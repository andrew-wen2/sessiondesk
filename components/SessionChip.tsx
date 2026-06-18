import Link from "next/link";
import type { CalendarSession } from "@/lib/types";

export default function SessionChip({ session }: { session: CalendarSession }) {
  const dot = session.paid ? "bg-green-600" : "bg-orange-500";
  return (
    <Link
      href={`/sessions/${session.id}`}
      onClick={(e) => e.stopPropagation()}
      className="flex items-center gap-1.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-xs text-gray-800 hover:bg-gray-50"
      title={`${session.studentName} — $${session.amount}${session.paid ? " · paid" : " · unpaid"}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      <span className="truncate">{session.studentName}</span>
    </Link>
  );
}
