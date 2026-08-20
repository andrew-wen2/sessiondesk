"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { formatSessionDate } from "@/lib/format";
import { toDateKey } from "@/lib/dates";
import { downloadCsv } from "@/lib/download-csv";
import {
  owedAmount,
  effectiveStatus,
  STATUS_LABEL,
  STATUS_TONE,
  type SessionStatus,
} from "@/lib/session-status";
import DateRangeSelect, { type RangeFilters } from "./DateRangeSelect";
import { Card } from "./ui/Card";
import Badge from "./ui/Badge";
import Button from "./ui/Button";
import { AlertCircle, Check, Download } from "./icons";

// One student's money. This is the old payments ledger with the per-student grouping
// removed — the grouping existed only because the ledger had to cover everyone at
// once, and now the student page provides that context for free.

export type PaymentRow = {
  id: string;
  start: string; // ISO
  topic: string;
  amount: number;
  paid: boolean;
  status: SessionStatus;
};

export default function StudentPayments({
  studentName,
  rows,
  truncated,
  maxRows,
  filters,
  now,
}: {
  studentName: string;
  rows: PaymentRow[];
  truncated: boolean;
  maxRows: number;
  filters: RangeFilters;
  // "Now" comes from the server render, not Date.now() in here. This component
  // server-renders and then hydrates, so reading the clock during render would make
  // the two passes disagree for any session that started in between — visible as a
  // flipped "Mark paid"/"Paid" cell or a changed status badge. One value from the
  // server keeps both passes identical; it refreshes on navigation like the rows do.
  now: number;
}) {
  const router = useRouter();

  // Optimistic paid state as OVERRIDES over the server rows, not a snapshot of them.
  //
  // A `useState(() => build a map from rows)` initializer runs only on first mount.
  // Filtering navigates with router.push, which re-renders this same component
  // instance with new `rows`; the initializer wouldn't re-run, so rows newly brought
  // into view would have no entry, read as `undefined` → falsy, and render as unpaid
  // (and count as owed) even when the DB says paid.
  //
  // Starting empty and falling back to the server value fixes that: a filter change
  // or router.refresh() adopts fresh server truth, and a toggle still shows instantly.
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const paidOf = (s: PaymentRow) => overrides[s.id] ?? s.paid;
  const [errorId, setErrorId] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);

  const owedFor = (s: PaymentRow) => owedAmount({ ...s, paid: paidOf(s) }, now);
  const owed = rows.reduce((a, s) => a + owedFor(s), 0);

  async function toggle(id: string, current: boolean) {
    const next = !current;
    setOverrides((o) => ({ ...o, [id]: next })); // optimistic
    setErrorId(null);
    try {
      // Route through the session PATCH so the paid→GCal color mirror fires
      // exactly as it does from Session detail — one paid path, no divergence.
      const res = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paid: next }),
      });
      if (!res.ok) throw new Error();
      // Next knows nothing about a hand-rolled fetch, so without this the Router
      // Cache keeps serving the pre-toggle payload — including to the dashboard's
      // outstanding tile after a back navigation.
      router.refresh();
    } catch {
      // Drop the override rather than writing the old value back, so the row falls
      // back to server truth instead of pinning a guess.
      setOverrides((o) => {
        const rest = { ...o };
        delete rest[id];
        return rest;
      });
      setErrorId(id);
    }
  }

  function exportCsv() {
    setCsvError(null);
    // Built from what's rendered — same filters, same optimistic paid state — so the
    // file always matches the screen.
    const csv: string[][] = [["Date", "Student", "Topic", "Amount", "Status", "Paid", "Owed"]];
    for (const s of rows) {
      csv.push([
        // Sortable in a spreadsheet, unlike formatSessionDate's "Mon, Jun 16".
        toDateKey(new Date(s.start)),
        studentName,
        s.topic,
        String(s.amount),
        STATUS_LABEL[effectiveStatus(s.status, s.start, now)],
        paidOf(s) ? "yes" : "no",
        String(owedFor(s)),
      ]);
    }
    const slug = studentName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!downloadCsv(csv, `payments-${slug || "student"}-${toDateKey(new Date())}`)) {
      setCsvError("Couldn't build the CSV file — try again.");
    }
  }

  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Payments</h2>
        <span
          className={`font-mono text-lg font-semibold ${owed > 0 ? "text-warn" : "text-muted"}`}
        >
          ${owed}
          <span className="ml-1.5 font-sans text-xs font-normal text-muted">owed</span>
        </span>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <DateRangeSelect filters={filters} />
        <Button variant="secondary" size="sm" onClick={exportCsv} disabled={rows.length === 0}>
          <Download className="h-3.5 w-3.5" />
          Export CSV
        </Button>
        <span className="text-xs text-muted">
          {rows.length} session{rows.length === 1 ? "" : "s"} shown
        </span>
        {csvError && <span className="text-xs text-danger">{csvError}</span>}
      </div>

      {truncated && (
        <p className="flex items-start gap-2 rounded-control border border-warn/25 bg-warn-soft px-3 py-2 text-xs text-warn">
          <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" />
          <span>
            Showing the first {maxRows} sessions — narrow the date range to see the rest. The owed
            total above covers only what&apos;s shown, so it will read low.
          </span>
        </p>
      )}

      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-hairline-strong px-4 py-6 text-center text-sm text-muted">
          No sessions in this range — widen the date range or clear the unpaid filter.
        </p>
      ) : (
        <Card>
          <ul className="divide-y divide-hairline">
            {rows.map((s) => {
              const paid = paidOf(s);
              const shown = effectiveStatus(s.status, s.start, now);
              const cancelled = s.status === "cancelled";
              return (
                <li
                  key={s.id}
                  className="flex items-center gap-3 px-4 py-2.5 text-sm transition-colors duration-150 hover:bg-sunken/60"
                >
                  <Link
                    href={`/sessions/${s.id}`}
                    className="w-28 shrink-0 font-mono text-xs text-muted transition-colors duration-150 hover:text-primary"
                  >
                    {formatSessionDate(s.start)}
                  </Link>
                  <span
                    className={`flex-1 truncate ${
                      cancelled ? "text-faint line-through" : "text-ink-soft"
                    }`}
                  >
                    {s.topic || <span className="text-faint">(no topic)</span>}
                  </span>
                  {/* Scheduled is the default and needs no badge; anything else
                      is worth calling out on a money screen. */}
                  {shown !== "scheduled" && (
                    <Badge tone={STATUS_TONE[shown]}>{STATUS_LABEL[shown]}</Badge>
                  )}
                  <span className="w-14 shrink-0 text-right font-mono text-ink">${s.amount}</span>
                  <span className="w-24 shrink-0 text-right">
                    {cancelled ? (
                      <span className="text-xs text-faint">not owed</span>
                    ) : paid ? (
                      <span className="inline-flex items-center gap-1 text-sm font-medium text-good">
                        <Check className="h-3.5 w-3.5" />
                        Paid
                      </span>
                    ) : (
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => toggle(s.id, paid)}
                        className="h-7 border-warn/40 text-warn hover:bg-warn-soft"
                      >
                        Mark paid
                      </Button>
                    )}
                  </span>
                  <span className="w-10 shrink-0 text-right">
                    {paid && !cancelled && (
                      <button
                        onClick={() => toggle(s.id, paid)}
                        className="cursor-pointer text-xs text-faint transition-colors duration-150 hover:text-ink"
                        title="Mark unpaid"
                      >
                        undo
                      </button>
                    )}
                  </span>
                </li>
              );
            })}
          </ul>
          {errorId && (
            <p className="border-t border-hairline px-4 py-2 text-xs text-danger">
              Could not update payment — try again.
            </p>
          )}
        </Card>
      )}
    </section>
  );
}
