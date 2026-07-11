import type { CalendarSession } from "@/lib/types";

// A calendar chip. Clicking it selects the session for the preview popover (owned by
// the client Calendar) rather than navigating straight to the detail page. `showTime`
// prefixes the start time — used in the week view and (small/muted) in month cells.
export default function SessionChip({
  session,
  onSelect,
  showTime = false,
}: {
  session: CalendarSession;
  onSelect: (s: CalendarSession) => void;
  showTime?: boolean;
}) {
  const dot = session.paid ? "bg-green-600" : "bg-orange-500";
  const time = showTime
    ? new Date(session.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(session);
      }}
      className="flex w-full items-center gap-1.5 rounded border border-gray-200 bg-white px-1.5 py-0.5 text-left text-xs text-gray-800 hover:bg-gray-50"
      title={`${session.studentName} — $${session.amount}${session.paid ? " · paid" : " · unpaid"}`}
    >
      <span className={`h-2 w-2 shrink-0 rounded-full ${dot}`} aria-hidden />
      {time && <span className="shrink-0 tabular-nums text-gray-500">{time}</span>}
      <span className="truncate">{session.studentName}</span>
    </button>
  );
}
