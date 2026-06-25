"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CalendarSession } from "@/lib/types";
import { pad } from "@/lib/format";
import SessionChip from "./SessionChip";
import AddSessionModal from "./AddSessionModal";
import SyncAllButton from "./SyncAllButton";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export default function Calendar({
  month,
  sessions,
  studentFilter = null,
  gcalConfigured = false,
}: {
  month: string; // YYYY-MM
  sessions: CalendarSession[];
  studentFilter?: { id: string; name: string } | null;
  gcalConfigured?: boolean;
}) {
  const router = useRouter();
  const [year, mon] = month.split("-").map(Number);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [openMore, setOpenMore] = useState<number | null>(null);
  const studentQuery = studentFilter ? `&student=${studentFilter.id}` : "";

  // Bucket sessions by day-of-month (local time).
  const byDay = useMemo(() => {
    const map = new Map<number, CalendarSession[]>();
    for (const s of sessions) {
      const d = new Date(s.start);
      const day = d.getDate();
      const arr = map.get(day) ?? [];
      arr.push(s);
      map.set(day, arr);
    }
    return map;
  }, [sessions]);

  const firstWeekday = new Date(year, mon - 1, 1).getDay();
  const daysInMonth = new Date(year, mon, 0).getDate();
  const cells: (number | null)[] = [
    ...Array(firstWeekday).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => i + 1),
  ];
  while (cells.length % 7 !== 0) cells.push(null);

  const today = new Date();
  const isToday = (day: number) =>
    today.getFullYear() === year &&
    today.getMonth() === mon - 1 &&
    today.getDate() === day;

  function go(targetYear: number, targetMon: number) {
    setOpenMore(null);
    router.push(`/?month=${targetYear}-${pad(targetMon)}${studentQuery}`);
  }
  const prev = () => (mon === 1 ? go(year - 1, 12) : go(year, mon - 1));
  const next = () => (mon === 12 ? go(year + 1, 1) : go(year, mon + 1));
  const goToday = () => go(today.getFullYear(), today.getMonth() + 1);

  const monthLabel = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });

  return (
    <div className="space-y-4">
      {studentFilter && (
        <div className="flex items-center gap-2 rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm">
          <span>Showing only {studentFilter.name}</span>
          <Link href={`/?month=${month}`} className="text-blue-600 hover:underline">
            Clear
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h1 className="text-xl font-bold">{monthLabel}</h1>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <SyncAllButton month={month} configured={gcalConfigured} />
          <button onClick={prev} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">
            ← Prev
          </button>
          <button onClick={goToday} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">
            Today
          </button>
          <button onClick={next} className="rounded border border-gray-300 px-2 py-1 hover:bg-gray-50">
            Next →
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 text-sm">
        {WEEKDAYS.map((w) => (
          <div key={w} className="min-w-0 bg-gray-50 px-2 py-1.5 text-center text-xs font-medium text-gray-500">
            {w}
          </div>
        ))}

        {cells.map((day, i) => {
          if (day === null) return <div key={`e${i}`} className="min-h-24 min-w-0 bg-gray-50" />;
          const daySessions = byDay.get(day) ?? [];
          const visible = daySessions.slice(0, 3);
          const extra = daySessions.length - visible.length;
          const dateISO = `${year}-${pad(mon)}-${pad(day)}`;

          return (
            <div
              key={day}
              onClick={() => setAddDate(dateISO)}
              className="relative min-h-24 min-w-0 cursor-pointer bg-white p-1 hover:bg-blue-50/40"
            >
              <div
                className={`mb-1 text-right text-xs ${
                  isToday(day) ? "font-bold text-blue-600" : "text-gray-500"
                }`}
              >
                {day}
              </div>
              <div className="space-y-1">
                {visible.map((s) => (
                  <SessionChip key={s.id} session={s} />
                ))}
                {extra > 0 && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenMore(openMore === day ? null : day);
                    }}
                    className="w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-gray-500 hover:bg-gray-100"
                  >
                    +{extra} more
                  </button>
                )}
              </div>

              {openMore === day && (
                <div
                  onClick={(e) => e.stopPropagation()}
                  className="absolute left-1 right-1 top-8 z-20 space-y-1 rounded border border-gray-200 bg-white p-1 shadow-lg"
                >
                  {daySessions.map((s) => (
                    <SessionChip key={s.id} session={s} />
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {daySessionsTotal(byDay) === 0 && (
        <p className="text-sm text-gray-500">
          No sessions this month — click a day to add one.
        </p>
      )}

      {addDate && (
        <AddSessionModal
          dateISO={addDate}
          onClose={() => setAddDate(null)}
          onCreated={() => router.refresh()}
        />
      )}
    </div>
  );
}

function daySessionsTotal(byDay: Map<number, CalendarSession[]>) {
  let n = 0;
  for (const arr of byDay.values()) n += arr.length;
  return n;
}
