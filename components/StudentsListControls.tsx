"use client";

import { useRouter } from "next/navigation";
import { buttonClass } from "./ui/Button";
import { Check, Download } from "./icons";

// Roster controls: filter to students who owe money, and export every session as CSV.
// Past (archived) students aren't a toggle here — they render in their own section
// at the bottom of the roster, always visible, never hidden behind a filter.
//
// The current value arrives as a PROP from the server page, which has already parsed
// the query string — same arrangement as the old ledger filter bar, so there is no
// useSearchParams call and therefore no <Suspense> boundary to add.
//
// The filter is a button with aria-pressed rather than a checkbox: it navigates
// rather than holding form state, and a checkbox that immediately routes reads as a
// broken form to a screen reader.
export default function StudentsListControls({
  unpaid,
  total,
  shown,
}: {
  unpaid: boolean;
  total: number;
  shown: number;
}) {
  const router = useRouter();

  return (
    <div className="flex flex-wrap items-center gap-2">
      {shown !== total && (
        <span className="text-xs text-muted">
          {shown} of {total} student{total === 1 ? "" : "s"}
        </span>
      )}

      <button
        type="button"
        aria-pressed={unpaid}
        onClick={() => router.push(unpaid ? "/students" : "/students?unpaid=1")}
        className={buttonClass({
          variant: "secondary",
          size: "sm",
          className: unpaid
            ? "border-primary/40 bg-primary-soft text-primary hover:bg-primary-soft"
            : "",
        })}
      >
        {unpaid ? <Check className="h-3.5 w-3.5" /> : null}
        Owes money only
      </button>

      {/* A plain link, not a fetch: the response is a file download, so letting the
          browser handle it needs no Blob juggling and no loading state. Unlike the
          per-student export this can't be built from rendered rows — the roster
          holds owed totals, not the sessions behind them.
          <Link> would be wrong here: it client-side navigates, and there is no page
          to navigate to — the route replies with a Content-Disposition attachment.
          Deliberately no `download` attribute either, so a 401 shows its JSON error
          instead of being saved as a broken .csv. */}
      {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
      <a
        href="/api/sessions/export"
        className={buttonClass({ variant: "secondary", size: "sm" })}
      >
        <Download className="h-3.5 w-3.5" />
        Export all sessions
      </a>
    </div>
  );
}
