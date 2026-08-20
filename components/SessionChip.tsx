import type { CalendarSession } from "@/lib/types";
import { STATUS_LABEL } from "@/lib/session-status";

// A calendar chip. Clicking it selects the session for the preview popover (owned by
// the client Calendar) rather than navigating straight to the detail page. `showTime`
// prefixes the start time — used in the week view and (small/muted) in month cells.
//
// Status styling is driven ONLY by the stored value, never by effectiveStatus():
// this renders inside a client component that both SSRs and hydrates, so a
// clock-derived "completed" would mismatch for a session that just started. Only
// cancelled and no_show get special treatment; scheduled and completed look alike.
export default function SessionChip({
  session,
  onSelect,
  showTime = false,
}: {
  session: CalendarSession;
  onSelect: (s: CalendarSession) => void;
  showTime?: boolean;
}) {
  const cancelled = session.status === "cancelled";
  const noShow = session.status === "no_show";

  // A cancelled session is greyed out and struck through — it's still on the day so
  // you remember it happened, but it reads as "not on". A no-show keeps the unpaid
  // orange (it's still owed) and is marked in the tooltip and label.
  //
  // The paid/unpaid signal is a flush bar down the leading edge rather than a dot:
  // at chip size a 2px rule reads faster than an 8px circle, and it leaves the whole
  // width for the name. Never the only channel — the title carries it as text.
  const bar = cancelled ? "bg-hairline-strong" : session.paid ? "bg-good" : "bg-warn";
  const time = showTime
    ? new Date(session.start).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

  const statusNote = cancelled || noShow ? ` · ${STATUS_LABEL[session.status].toLowerCase()}` : "";

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onSelect(session);
      }}
      className={`flex w-full items-center gap-1.5 overflow-hidden rounded-[6px] border py-[3px] pl-0 pr-1.5 text-left text-xs shadow-sm transition-[background-color,box-shadow] duration-150 hover:shadow-raise ${
        cancelled
          ? "border-hairline bg-sunken text-faint"
          : "border-hairline bg-surface text-ink-soft hover:bg-sunken"
      }`}
      title={`${session.studentName} — $${session.amount}${
        session.paid ? " · paid" : " · unpaid"
      }${statusNote}`}
    >
      <span className={`-my-[3px] mr-0.5 h-[calc(1em+6px)] w-[3px] shrink-0 ${bar}`} aria-hidden />
      {time && (
        <span className={`shrink-0 font-mono ${cancelled ? "text-faint" : "text-muted"}`}>
          {time}
        </span>
      )}
      <span className={`truncate font-medium ${cancelled ? "line-through" : ""}`}>
        {session.studentName}
      </span>
      {noShow && <span className="shrink-0 font-medium text-warn">no show</span>}
    </button>
  );
}
