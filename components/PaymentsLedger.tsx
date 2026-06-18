"use client";

import { useState } from "react";
import Link from "next/link";
import MastheadStats from "./MastheadStats";

export type LedgerSession = {
  id: string;
  start: string; // ISO
  topic: string;
  amount: number;
  paid: boolean;
};

export type LedgerGroup = {
  student: { id: string; name: string };
  sessions: LedgerSession[];
};

export default function PaymentsLedger({
  groups,
  thisWeek,
}: {
  groups: LedgerGroup[];
  thisWeek: number;
}) {
  // Paid state lives here so owed totals + masthead update on toggle.
  const [paid, setPaid] = useState<Record<string, boolean>>(() => {
    const init: Record<string, boolean> = {};
    for (const g of groups) for (const s of g.sessions) init[s.id] = s.paid;
    return init;
  });
  const [errorId, setErrorId] = useState<string | null>(null);

  // Outstanding only counts sessions that have already happened — future
  // sessions aren't owed yet, even if unpaid.
  const now = Date.now();
  const happened = (s: LedgerSession) => new Date(s.start).getTime() <= now;
  const owedFor = (s: LedgerSession) => (paid[s.id] || !happened(s) ? 0 : s.amount);

  const outstanding = groups.reduce(
    (sum, g) => sum + g.sessions.reduce((a, s) => a + owedFor(s), 0),
    0
  );

  async function toggle(id: string) {
    const next = !paid[id];
    setPaid((p) => ({ ...p, [id]: next })); // optimistic
    setErrorId(null);
    try {
      const res = await fetch("/api/payments", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: id, paid: next }),
      });
      if (!res.ok) throw new Error();
    } catch {
      setPaid((p) => ({ ...p, [id]: !next })); // revert
      setErrorId(id);
    }
  }

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold">Payments</h1>
      <MastheadStats thisWeek={thisWeek} outstanding={outstanding} />

      {groups.length === 0 ? (
        <p className="text-sm text-gray-500">No sessions yet — add one from the calendar.</p>
      ) : (
        <div className="space-y-5">
          {groups.map((g) => {
            const owed = g.sessions.reduce((a, s) => a + owedFor(s), 0);
            return (
              <div key={g.student.id} className="rounded-lg border border-gray-200 bg-white">
                <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2">
                  <Link
                    href={`/students/${g.student.id}`}
                    className="font-semibold text-blue-600 hover:underline"
                  >
                    {g.student.name}
                  </Link>
                  <span className={owed > 0 ? "text-sm text-orange-600" : "text-sm text-gray-500"}>
                    ${owed} owed
                  </span>
                </div>
                <ul className="divide-y divide-gray-100">
                  {g.sessions.map((s) => {
                    const date = new Date(s.start).toLocaleDateString("en-US", {
                      weekday: "short",
                      month: "short",
                      day: "numeric",
                    });
                    return (
                      <li key={s.id} className="flex items-center gap-3 px-4 py-2 text-sm">
                        <Link href={`/sessions/${s.id}`} className="w-28 shrink-0 font-mono text-xs text-gray-500 hover:underline">
                          {date}
                        </Link>
                        <span className="flex-1 truncate text-gray-700">
                          {s.topic || "(no topic)"}
                        </span>
                        <span className="w-14 shrink-0 text-right font-mono">${s.amount}</span>
                        <span className="w-28 shrink-0 text-right">
                          {paid[s.id] ? (
                            <span className="text-sm font-medium text-green-700">✓ Paid</span>
                          ) : (
                            <button
                              onClick={() => toggle(s.id)}
                              className="rounded border border-orange-300 px-2 py-0.5 text-xs font-medium text-orange-600 hover:bg-orange-50"
                            >
                              Mark paid
                            </button>
                          )}
                        </span>
                        <span className="w-10 shrink-0 text-right">
                          {paid[s.id] && (
                            <button
                              onClick={() => toggle(s.id)}
                              className="text-xs text-gray-400 hover:text-gray-600"
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
                {errorId && g.sessions.some((s) => s.id === errorId) && (
                  <p className="px-4 py-2 text-xs text-red-600">
                    Could not update payment — try again.
                  </p>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
