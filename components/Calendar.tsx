"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CalendarSession } from "@/lib/types";
import { pad, formatSessionDate } from "@/lib/format";
import SessionChip from "./SessionChip";
import AddSessionModal from "./AddSessionModal";
import SyncAllButton from "./SyncAllButton";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Week-view time grid: pixels per hour, and the default visible hour window (8am–9pm)
// which expands to fit any session outside it. Drag-to-create snaps to SNAP minutes.
const HOUR_PX = 48;
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 21;
const SNAP = 15;

const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sundayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
const fmtHour = (h: number) => {
  const ampm = h < 12 || h === 24 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
};
const fmtMinLabel = (min: number) => {
  const h = Math.floor(min / 60);
  const m = min % 60;
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr}:${pad(m)} ${ampm}`;
};

type Positioned = { s: CalendarSession; top: number; height: number; left: number; width: number };

// Lay a day's sessions out on the time grid: vertical position/size from start+duration,
// and split width across overlapping events (side-by-side lanes, like Google Calendar).
function positionDay(sessions: CalendarSession[], startHour: number): Positioned[] {
  const items = sessions
    .map((s) => {
      const st = new Date(s.start);
      const start = st.getHours() * 60 + st.getMinutes() - startHour * 60;
      const dur = Math.max(s.durationMin, 30); // floor so short sessions stay tappable
      return { s, start, end: start + dur, dur };
    })
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const out: Positioned[] = [];
  let cluster: typeof items = [];
  let clusterEnd = -Infinity;

  const flush = () => {
    if (!cluster.length) return;
    const laneEnds: number[] = [];
    const laneOf = new Map<(typeof items)[number], number>();
    for (const it of cluster) {
      let idx = laneEnds.findIndex((e) => e <= it.start);
      if (idx === -1) {
        idx = laneEnds.length;
        laneEnds.push(it.end);
      } else {
        laneEnds[idx] = it.end;
      }
      laneOf.set(it, idx);
    }
    const lanes = laneEnds.length;
    for (const it of cluster) {
      const lane = laneOf.get(it)!;
      out.push({
        s: it.s,
        top: (it.start / 60) * HOUR_PX,
        height: Math.max((it.dur / 60) * HOUR_PX - 2, 16),
        left: (lane / lanes) * 100,
        width: (1 / lanes) * 100,
      });
    }
    cluster = [];
    clusterEnd = -Infinity;
  };

  for (const it of items) {
    if (cluster.length && it.start >= clusterEnd) flush();
    cluster.push(it);
    clusterEnd = Math.max(clusterEnd, it.end);
  }
  flush();
  return out;
}

export default function Calendar({
  view = "month",
  month,
  weekStart,
  sessions,
  studentFilter = null,
  gcalConfigured = false,
}: {
  view?: "month" | "week";
  month: string; // YYYY-MM
  weekStart: string; // YYYY-MM-DD (Sunday)
  sessions: CalendarSession[];
  studentFilter?: { id: string; name: string } | null;
  gcalConfigured?: boolean;
}) {
  const router = useRouter();
  const [year, mon] = month.split("-").map(Number);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [addTime, setAddTime] = useState<string | null>(null);
  const [addDuration, setAddDuration] = useState<number | null>(null);
  const [openMore, setOpenMore] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalendarSession | null>(null);
  const [dragSel, setDragSel] = useState<{ iso: string; a: number; b: number } | null>(null);
  const dragRef = useRef<{ iso: string; rectTop: number; startMin: number } | null>(null);
  const studentQuery = studentFilter ? `&student=${studentFilter.id}` : "";

  // Remember the last-used view so a bare `/` (Calendar nav link) reopens it. Month
  // navigation emits param-less URLs, so the server reads this cookie for the default;
  // writing it on every view change keeps the cookie in sync with what's on screen.
  useEffect(() => {
    document.cookie = `calView=${view}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  // Bucket sessions by local date string so a week spanning two months still groups
  // correctly; keep each day time-sorted for the week columns.
  const byDate = useMemo(() => {
    const map = new Map<string, CalendarSession[]>();
    for (const s of sessions) {
      const k = dateKey(new Date(s.start));
      const arr = map.get(k) ?? [];
      arr.push(s);
      map.set(k, arr);
    }
    for (const arr of map.values()) arr.sort((a, b) => a.start.localeCompare(b.start));
    return map;
  }, [sessions]);

  const today = new Date();
  const todayKey = dateKey(today);
  const ws = weekStart ? new Date(`${weekStart}T00:00:00`) : sundayOf(today);

  function pushUrl(params: string) {
    setOpenMore(null);
    setPreview(null);
    router.push(`/?${params}${studentQuery}`);
  }
  const goMonth = (y: number, m: number) => pushUrl(`month=${y}-${pad(m)}`);
  const goWeek = (d: Date) => pushUrl(`view=week&week=${dateKey(d)}`);

  const prev = () =>
    view === "week" ? goWeek(addDays(ws, -7)) : mon === 1 ? goMonth(year - 1, 12) : goMonth(year, mon - 1);
  const next = () =>
    view === "week" ? goWeek(addDays(ws, 7)) : mon === 12 ? goMonth(year + 1, 1) : goMonth(year, mon + 1);
  const goToday = () =>
    view === "week" ? goWeek(sundayOf(today)) : goMonth(today.getFullYear(), today.getMonth() + 1);

  const switchToWeek = () => {
    const inMonth = today.getFullYear() === year && today.getMonth() === mon - 1;
    goWeek(sundayOf(inMonth ? today : new Date(year, mon - 1, 1)));
  };
  const switchToMonth = () => goMonth(ws.getFullYear(), ws.getMonth() + 1);

  function openAdd(iso: string, hour?: number, dur?: number) {
    setPreview(null);
    setOpenMore(null);
    setAddTime(hour != null ? `${pad(hour)}:00` : null);
    setAddDuration(dur ?? null);
    setAddDate(iso);
  }

  const monthLabel = new Date(year, mon - 1, 1).toLocaleString("en-US", { month: "long", year: "numeric" });
  const weekEnd = addDays(ws, 6);
  const weekLabel = `${ws.toLocaleString("en-US", { month: "short", day: "numeric" })} – ${weekEnd.toLocaleString(
    "en-US",
    ws.getMonth() === weekEnd.getMonth() ? { day: "numeric" } : { month: "short", day: "numeric" }
  )}, ${weekEnd.getFullYear()}`;

  const weekCells = Array.from({ length: 7 }, (_, i) => addDays(ws, i));

  // ---- Month grid ----
  const monthCells: (Date | null)[] = (() => {
    const firstWeekday = new Date(year, mon - 1, 1).getDay();
    const daysInMonth = new Date(year, mon, 0).getDate();
    const cells: (Date | null)[] = [
      ...Array(firstWeekday).fill(null),
      ...Array.from({ length: daysInMonth }, (_, i) => new Date(year, mon - 1, i + 1)),
    ];
    while (cells.length % 7 !== 0) cells.push(null);
    return cells;
  })();

  // `openUp` flips the day's popovers to grow upward. The month grid is `overflow-hidden`
  // (for its rounded corners), so a downward popover in the bottom rows would be clipped —
  // cutting off the preview's "Open" link. Bottom-row cells anchor to the bottom instead.
  function DayCell({ date, openUp }: { date: Date; openUp: boolean }) {
    const iso = dateKey(date);
    const daySessions = byDate.get(iso) ?? [];
    const visible = daySessions.slice(0, 4);
    const extra = daySessions.length - visible.length;
    const isToday = iso === todayKey;
    const popoverAnchor = openUp ? "bottom-8" : "top-8";

    return (
      <div
        onClick={() => openAdd(iso)}
        className="relative min-h-32 min-w-0 cursor-pointer bg-white p-1.5 hover:bg-blue-50/40"
      >
        <div className={`mb-1 text-right text-xs ${isToday ? "font-bold text-blue-600" : "text-gray-500"}`}>
          {date.getDate()}
        </div>
        <div className="space-y-1">
          {visible.map((s) => (
            <SessionChip key={s.id} session={s} onSelect={setPreview} showTime />
          ))}
          {extra > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setPreview(null);
                setOpenMore(openMore === iso ? null : iso);
              }}
              className="w-full truncate rounded px-1.5 py-0.5 text-left text-xs text-gray-500 hover:bg-gray-100"
            >
              +{extra} more
            </button>
          )}
        </div>

        {openMore === iso && (
          <div
            onClick={(e) => e.stopPropagation()}
            className={`absolute left-1 right-1 z-20 max-h-64 space-y-1 overflow-y-auto rounded border border-gray-200 bg-white p-1 shadow-lg ${popoverAnchor}`}
          >
            {daySessions.map((s) => (
              <SessionChip key={s.id} session={s} onSelect={setPreview} showTime />
            ))}
          </div>
        )}

        {preview && dateKey(new Date(preview.start)) === iso && (
          <PreviewPopover
            session={preview}
            onClose={() => setPreview(null)}
            className={`left-1 right-1 ${popoverAnchor}`}
          />
        )}
      </div>
    );
  }

  // ---- Week grid (time-of-day) ----
  // Visible hour window: the default, widened to include any out-of-window session.
  let rangeStart = DEFAULT_START_HOUR;
  let rangeEnd = DEFAULT_END_HOUR;
  for (const cell of weekCells) {
    for (const s of byDate.get(dateKey(cell)) ?? []) {
      const st = new Date(s.start);
      const sMin = st.getHours() * 60 + st.getMinutes();
      rangeStart = Math.min(rangeStart, Math.floor(sMin / 60));
      rangeEnd = Math.max(rangeEnd, Math.ceil((sMin + s.durationMin) / 60));
    }
  }
  rangeStart = Math.max(0, rangeStart);
  rangeEnd = Math.min(24, rangeEnd);
  const hours = Array.from({ length: rangeEnd - rangeStart }, (_, i) => rangeStart + i);
  const gridHeight = (rangeEnd - rangeStart) * HOUR_PX;
  const nowMin = today.getHours() * 60 + today.getMinutes();

  // Precompute each week day's time-grid layout once. Drag-to-create fires setDragSel on
  // every pointer move, re-rendering the whole grid; without this the (non-trivial) overlap
  // layout would be recomputed for all 7 columns on every frame of a drag.
  const positionedByDate = useMemo(() => {
    const m = new Map<string, Positioned[]>();
    if (view !== "week") return m;
    const base = new Date(`${weekStart}T00:00:00`);
    for (let i = 0; i < 7; i++) {
      const iso = dateKey(addDays(base, i));
      m.set(iso, positionDay(byDate.get(iso) ?? [], rangeStart));
    }
    return m;
  }, [view, weekStart, byDate, rangeStart]);

  // Emptiness is judged over the visible days only — the page over-fetches neighboring
  // days (timezone padding) which must not suppress the empty-state message.
  const shownKeys =
    view === "week"
      ? weekCells.map(dateKey)
      : monthCells.filter((d): d is Date => d !== null).map(dateKey);
  const hasVisible = shownKeys.some((k) => (byDate.get(k)?.length ?? 0) > 0);

  // Drag-to-create: press on a day column and sweep out a time range; release opens the
  // Add-session modal prefilled with that start + length. A tiny sweep counts as a click
  // (a default 1-hour slot at that time). Uses pointer events so it works with mouse,
  // touch, and pen alike (columns set touch-action:none so a touch-drag sweeps instead of
  // scrolling). Window listeners track the drag past the column edges; dragRef keeps
  // identity stable across the re-renders each move triggers.
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;
  const yToMin = (clientY: number, rectTop: number) => {
    const y = Math.max(0, Math.min(gridHeight, clientY - rectTop));
    return rangeStart * 60 + (y / HOUR_PX) * 60;
  };
  function detachDrag() {
    window.removeEventListener("pointermove", moveDrag);
    window.removeEventListener("pointerup", endDrag);
    window.removeEventListener("pointercancel", cancelDrag);
  }
  function moveDrag(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    setDragSel({ iso: d.iso, a: d.startMin, b: snap(yToMin(e.clientY, d.rectTop)) });
  }
  function endDrag(e: PointerEvent) {
    const d = dragRef.current;
    detachDrag();
    dragRef.current = null;
    setDragSel(null);
    if (!d) return;
    const cur = snap(yToMin(e.clientY, d.rectTop));
    const start = Math.min(d.startMin, cur);
    const raw = Math.abs(cur - d.startMin);
    const dur = raw < SNAP ? 60 : Math.max(raw, 30); // tiny sweep = click → default hour
    openAdd(d.iso, undefined, dur);
    setAddTime(`${pad(Math.floor(start / 60))}:${pad(start % 60)}`);
  }
  function cancelDrag() {
    detachDrag();
    dragRef.current = null;
    setDragSel(null);
  }
  function startDrag(e: ReactPointerEvent<HTMLDivElement>, iso: string) {
    if (e.button !== 0 || !e.isPrimary) return; // primary button / first touch only
    const rectTop = e.currentTarget.getBoundingClientRect().top;
    const startMin = snap(yToMin(e.clientY, rectTop));
    dragRef.current = { iso, rectTop, startMin };
    setDragSel({ iso, a: startMin, b: startMin });
    setPreview(null);
    setOpenMore(null);
    window.addEventListener("pointermove", moveDrag);
    window.addEventListener("pointerup", endDrag);
    window.addEventListener("pointercancel", cancelDrag);
    e.preventDefault();
  }

  // Plain render function (NOT a nested component) so the rapid re-renders during a drag
  // reconcile in place instead of remounting the whole grid.
  function renderWeekColumn(date: Date, dayIndex: number) {
    const iso = dateKey(date);
    const positioned = positionedByDate.get(iso) ?? [];
    const showNow = iso === todayKey && nowMin >= rangeStart * 60 && nowMin < rangeEnd * 60;
    const sel =
      dragSel && dragSel.iso === iso
        ? { a: Math.min(dragSel.a, dragSel.b), b: Math.max(dragSel.a, dragSel.b) }
        : null;

    return (
      <div
        key={iso}
        onPointerDown={(e) => startDrag(e, iso)}
        className="relative cursor-pointer select-none touch-none border-l border-gray-200"
        style={{ height: gridHeight }}
      >
        {/* hour lines (visual only; the column itself handles press-drag) */}
        {hours.map((h, i) => (
          <div
            key={h}
            className="pointer-events-none absolute inset-x-0 border-t border-gray-100"
            style={{ top: i * HOUR_PX, height: HOUR_PX }}
          />
        ))}

        {/* live drag selection */}
        {sel && (
          <div
            className="pointer-events-none absolute inset-x-0 z-30 rounded border border-blue-400 bg-blue-500/20"
            style={{
              top: ((sel.a - rangeStart * 60) / 60) * HOUR_PX,
              height: Math.max(((sel.b - sel.a) / 60) * HOUR_PX, 2),
            }}
          >
            <div className="px-1 pt-0.5 text-[10px] font-medium text-blue-700">
              {fmtMinLabel(sel.a)}
              {sel.b > sel.a ? ` – ${fmtMinLabel(sel.b)}` : ""}
            </div>
          </div>
        )}

        {/* events */}
        {positioned.map((pos) => (
          <button
            key={pos.s.id}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              setPreview(pos.s.id === preview?.id ? null : pos.s);
            }}
            style={{ top: pos.top, height: pos.height, left: `${pos.left}%`, width: `calc(${pos.width}% - 3px)` }}
            className={`absolute z-10 overflow-hidden rounded border px-1 py-0.5 text-left text-xs leading-tight transition-colors duration-150 ${
              pos.s.paid
                ? "border-green-200 bg-green-50 text-green-900 hover:bg-green-100"
                : "border-orange-200 bg-orange-50 text-orange-900 hover:bg-orange-100"
            }`}
          >
            <div className="truncate font-medium">{pos.s.studentName}</div>
            {pos.height >= 30 && <div className="truncate opacity-70">{fmtTime(pos.s.start)}</div>}
          </button>
        ))}

        {/* current-time indicator */}
        {showNow && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-red-500"
            style={{ top: ((nowMin - rangeStart * 60) / 60) * HOUR_PX }}
          >
            <span className="absolute -left-1 -top-1 block h-2 w-2 rounded-full bg-red-500" />
          </div>
        )}

        {/* preview — flips to the right edge for the later columns, and upward for events in
            the lower half of the grid, so it doesn't run off either screen edge */}
        {preview &&
          dateKey(new Date(preview.start)) === iso &&
          (() => {
            const evTop = positioned.find((p) => p.s.id === preview.id)?.top ?? 0;
            const openUp = evTop > gridHeight / 2;
            return (
              <PreviewPopover
                session={preview}
                onClose={() => setPreview(null)}
                className={`w-64 ${dayIndex >= 4 ? "right-0" : "left-0"}`}
                style={
                  openUp
                    ? { bottom: Math.max(gridHeight - evTop, 0) }
                    : { top: Math.max(evTop - 4, 0) }
                }
              />
            );
          })()}
      </div>
    );
  }

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
        <h1 className="text-xl font-bold">{view === "week" ? weekLabel : monthLabel}</h1>
        {/* Three distinct control treatments so they don't read as one wall of
            identical buttons: soft segmented toggle · outlined nav pill · solid action. */}
        <div className="flex flex-wrap items-center gap-3 text-sm">
          {/* View toggle — soft segmented control, neutral active state */}
          <div className="inline-flex rounded-lg bg-gray-100 p-0.5">
            {(["month", "week"] as const).map((v) => (
              <button
                key={v}
                onClick={v === "month" ? switchToMonth : switchToWeek}
                className={`rounded-md px-3 py-1 capitalize transition-colors duration-150 ${
                  view === v
                    ? "bg-white font-medium text-gray-900 shadow-sm"
                    : "text-gray-500 hover:text-gray-900"
                }`}
              >
                {v}
              </button>
            ))}
          </div>

          {/* Date navigation — one outlined pill reads as a single control */}
          <div className="inline-flex items-center rounded-lg border border-gray-300 bg-white">
            <button
              onClick={prev}
              aria-label="Previous"
              className="rounded-l-lg px-2.5 py-1 text-gray-600 transition-colors duration-150 hover:bg-gray-50"
            >
              ←
            </button>
            <button
              onClick={goToday}
              className="border-x border-gray-300 px-3 py-1 font-medium text-gray-700 transition-colors duration-150 hover:bg-gray-50"
            >
              Today
            </button>
            <button
              onClick={next}
              aria-label="Next"
              className="rounded-r-lg px-2.5 py-1 text-gray-600 transition-colors duration-150 hover:bg-gray-50"
            >
              →
            </button>
          </div>

          <SyncAllButton month={month} configured={gcalConfigured} />
        </div>
      </div>

      {view === "week" ? (
        <div className="rounded-lg border border-gray-200 bg-white text-sm">
          {/* header: day names + dates */}
          <div className="grid" style={{ gridTemplateColumns: "3.5rem repeat(7, minmax(0, 1fr))" }}>
            <div className="border-b border-gray-200" />
            {weekCells.map((date) => {
              const isToday = dateKey(date) === todayKey;
              return (
                <div key={dateKey(date)} className="border-b border-l border-gray-200 px-1 py-1.5 text-center">
                  <div className="text-xs text-gray-500">{WEEKDAYS[date.getDay()]}</div>
                  <div className={`text-sm ${isToday ? "font-bold text-blue-600" : "text-gray-700"}`}>
                    {date.getDate()}
                  </div>
                </div>
              );
            })}
          </div>
          {/* body: hour gutter + day columns */}
          <div className="grid" style={{ gridTemplateColumns: "3.5rem repeat(7, minmax(0, 1fr))" }}>
            <div className="relative" style={{ height: gridHeight }}>
              {hours.map((h, i) => (
                <div
                  key={h}
                  className={`absolute right-1 text-[10px] text-gray-400 ${i === 0 ? "" : "-translate-y-1/2"}`}
                  style={{ top: i * HOUR_PX }}
                >
                  {fmtHour(h)}
                </div>
              ))}
            </div>
            {weekCells.map((date, i) => renderWeekColumn(date, i))}
          </div>
          <p className="border-t border-gray-100 px-2 py-1.5 text-xs text-gray-400">
            Drag across a day to create a session.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-lg border border-gray-200 bg-gray-200 text-sm">
          {WEEKDAYS.map((w) => (
            <div key={w} className="min-w-0 bg-gray-50 px-2 py-1.5 text-center text-xs font-medium text-gray-500">
              {w}
            </div>
          ))}
          {monthCells.map((date, i) =>
            date === null ? (
              <div key={`e${i}`} className="min-h-32 min-w-0 bg-gray-50" />
            ) : (
              <DayCell
                key={dateKey(date)}
                date={date}
                openUp={Math.floor(i / 7) >= monthCells.length / 7 - 2}
              />
            )
          )}
        </div>
      )}

      {!hasVisible && (
        <p className="text-sm text-gray-500">
          No sessions this {view} — {view === "week" ? "drag across a day" : "click a day"} to add one.
        </p>
      )}

      {addDate && (
        <AddSessionModal
          dateISO={addDate}
          timeHHMM={addTime ?? undefined}
          durationMin={addDuration ?? undefined}
          onClose={() => {
            setAddDate(null);
            setAddTime(null);
            setAddDuration(null);
          }}
          onCreated={() => router.refresh()}
        />
      )}
    </div>
  );
}

// A glanceable session preview — student, schedule, topic, payment — with an Open link
// to the full detail page. Reuses the calendar's anchored-popover pattern; `className`/
// `style` let the week grid re-anchor it beside the event.
function PreviewPopover({
  session,
  onClose,
  className = "left-1 right-1 top-8",
  style,
}: {
  session: CalendarSession;
  onClose: () => void;
  className?: string;
  style?: CSSProperties;
}) {
  const d = new Date(session.start);
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={style}
      className={`absolute z-40 space-y-2 rounded-lg border border-gray-200 bg-white p-3 text-left shadow-lg ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold">{session.studentName}</div>
        <button onClick={onClose} className="shrink-0 text-xs text-gray-400 hover:text-gray-600" aria-label="Close">
          ✕
        </button>
      </div>
      <div className="text-xs text-gray-600">
        {formatSessionDate(d)} · {fmtTime(session.start)} · {session.durationMin} min
      </div>
      <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-gray-700">
        {session.topic.trim() ? session.topic : <span className="text-gray-400">No topic yet</span>}
      </div>
      <div className="flex items-center justify-between gap-2">
        <span
          className={`rounded px-1.5 py-0.5 text-xs font-medium ${
            session.paid ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-600"
          }`}
        >
          {session.paid ? "Paid" : "Unpaid"} · ${session.amount}
        </span>
        <Link href={`/sessions/${session.id}`} className="text-xs font-medium text-blue-600 hover:underline">
          Open →
        </Link>
      </div>
    </div>
  );
}
