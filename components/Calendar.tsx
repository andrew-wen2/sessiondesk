"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { CalendarSession } from "@/lib/types";
import { pad, formatSessionDate } from "@/lib/format";
import { STATUS_LABEL, STATUS_TONE } from "@/lib/session-status";
import SessionChip from "./SessionChip";
import AddSessionModal from "./AddSessionModal";
import SyncAllButton from "./SyncAllButton";
import Badge from "./ui/Badge";
import Segmented from "./ui/Segmented";
import { buttonClass } from "./ui/Button";
import { ArrowRight, ChevronLeft, ChevronRight, X } from "./icons";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Time-grid geometry (week + day views): pixels per hour, and the default visible hour
// window (8am–9pm) which expands to fit any session outside it. Pointer gestures snap to
// SNAP minutes; a resize can't go below MIN_DURATION.
const HOUR_PX = 48;
const DEFAULT_START_HOUR = 8;
const DEFAULT_END_HOUR = 21;
const SNAP = 15;
const MIN_DURATION = 15;
// How far the pointer must travel before a press counts as a drag rather than a click.
const DRAG_SLOP_PX = 4;

type View = "month" | "week";

const dateKey = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const sundayOf = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay());
const parseKey = (iso: string) => new Date(`${iso}T00:00:00`);
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

// Local wall-clock minutes-from-midnight → an ISO instant on the given local day.
function isoAt(dayKey: string, minutes: number): string {
  const [y, m, d] = dayKey.split("-").map(Number);
  return new Date(y, m - 1, d, Math.floor(minutes / 60), minutes % 60).toISOString();
}

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

// What a live pointer gesture is doing. `create` sweeps out a new slot on the time grid;
// `move`/`resize` reschedule an existing session there; `monthMove` drags a chip between
// month cells (date only — a month cell has no time axis, so the time of day is kept).
type Drag =
  | { kind: "create"; iso: string; a: number; b: number }
  | { kind: "move"; id: string; iso: string; startMin: number; durationMin: number }
  | { kind: "resize"; id: string; iso: string; startMin: number; durationMin: number }
  | { kind: "monthMove"; id: string; iso: string };

// The mutable half of a gesture, kept in a ref so it stays identical across the many
// re-renders each pointermove triggers.
type DragState = {
  kind: Drag["kind"];
  id: string; // "" for create
  iso: string; // day currently under the pointer
  originX: number;
  originY: number;
  moved: boolean;
  anchorMin: number; // create: the minute the sweep started from
  grabOffsetMin: number; // move: pointer minute − event start, so the event keeps its grab point
  startMin: number; // move/resize: current start
  durationMin: number; // move/resize: current length
};

// Hit-test the day under the pointer. The month cells and the time columns both carry
// `data-day`; the time columns additionally carry `data-grid="time"` (they have a vertical
// axis, month cells don't). Hit-testing beats caching geometry at drag start: it survives
// scrolling the time grid mid-drag, and needs no per-view column maths.
function dayUnderPointer(x: number, y: number) {
  const el = document.elementFromPoint(x, y) as HTMLElement | null;
  const cell = el?.closest<HTMLElement>("[data-day]");
  const iso = cell?.dataset.day;
  if (!cell || !iso) return null;
  return { iso, rect: cell.getBoundingClientRect(), timed: cell.dataset.grid === "time" };
}

export default function Calendar({
  view = "month",
  month,
  weekStart,
  sessions: serverSessions,
  studentFilter = null,
  gcalConfigured = false,
  unsyncedCount = 0,
}: {
  view?: View;
  month: string; // YYYY-MM
  weekStart: string; // YYYY-MM-DD (Sunday)
  sessions: CalendarSession[];
  studentFilter?: { id: string; name: string } | null;
  gcalConfigured?: boolean;
  // Sessions in view with no mirrored event. Counted on the server from the same rows
  // the grid renders, so it never disagrees with what's on screen.
  unsyncedCount?: number;
}) {
  const router = useRouter();
  const [year, mon] = month.split("-").map(Number);
  const [addDate, setAddDate] = useState<string | null>(null);
  const [addTime, setAddTime] = useState<string | null>(null);
  const [addDuration, setAddDuration] = useState<number | null>(null);
  const [openMore, setOpenMore] = useState<string | null>(null);
  const [preview, setPreview] = useState<CalendarSession | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [dragError, setDragError] = useState<string | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const studentQuery = studentFilter ? `&student=${studentFilter.id}` : "";

  // Optimistic reschedules, as an overrides MAP over the server rows rather than a copy of
  // them — same reason as the payments ledger: a `useState` initializer doesn't re-run when
  // a refresh re-renders this instance with new rows, so a snapshot would freeze the grid.
  // An entry is dropped as soon as the server agrees with it (the effect below), and on a
  // failed PATCH, which reverts the event to where it was.
  const [overrides, setOverrides] = useState<Map<string, { start: string; durationMin: number }>>(
    new Map()
  );

  const sessions = useMemo(
    () =>
      overrides.size === 0
        ? serverSessions
        : serverSessions.map((s) => {
            const o = overrides.get(s.id);
            return o ? { ...s, start: o.start, durationMin: o.durationMin } : s;
          }),
    [serverSessions, overrides]
  );

  useEffect(() => {
    setOverrides((prev) => {
      if (prev.size === 0) return prev;
      const next = new Map(prev);
      let changed = false;
      for (const s of serverSessions) {
        const o = next.get(s.id);
        if (o && o.start === s.start && o.durationMin === s.durationMin) {
          next.delete(s.id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [serverSessions]);

  const byId = useMemo(() => new Map(sessions.map((s) => [s.id, s])), [sessions]);

  // Remember the last-used view so a bare `/` (Calendar nav link) reopens it. Month/day
  // navigation emits param-less URLs, so the server reads this cookie for the default;
  // writing it on every view change keeps the cookie in sync with what's on screen.
  useEffect(() => {
    document.cookie = `calView=${view}; path=/; max-age=31536000; samesite=lax`;
  }, [view]);

  // Bucket sessions by local date string so a week spanning two months still groups
  // correctly; keep each day time-sorted for the time-grid columns.
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
  const ws = weekStart ? parseKey(weekStart) : sundayOf(today);

  // The query that reproduces what's on screen right now, minus the student filter.
  const viewParams =
    view === "week" ? `view=week&week=${weekStart}` : `view=month&month=${month}`;

  function pushUrl(params: string) {
    setOpenMore(null);
    setPreview(null);
    router.push(`/?${params}${studentQuery}`);
  }
  // Every navigation names its view explicitly, month included. The server falls back to
  // the `calView` cookie when `view` is absent, and that cookie still holds the view you
  // are LEAVING — so a param-less `?month=…` would bounce you straight back to the
  // week grid you just switched away from. The cookie is for a bare `/` only.
  const goMonth = (y: number, m: number) => pushUrl(`view=month&month=${y}-${pad(m)}`);
  const goWeek = (d: Date) => pushUrl(`view=week&week=${dateKey(d)}`);

  const prev = () =>
    view === "week"
      ? goWeek(addDays(ws, -7))
      : mon === 1
        ? goMonth(year - 1, 12)
        : goMonth(year, mon - 1);
  const next = () =>
    view === "week"
      ? goWeek(addDays(ws, 7))
      : mon === 12
        ? goMonth(year + 1, 1)
        : goMonth(year, mon + 1);
  const goToday = () =>
    view === "week" ? goWeek(sundayOf(today)) : goMonth(today.getFullYear(), today.getMonth() + 1);

  // Switching views keeps you where you are: from month, land on today when today is in
  // the shown month, otherwise on the 1st; from week, keep the anchor date.
  const anchorDate = () => {
    if (view === "week") return today >= ws && today < addDays(ws, 7) ? today : ws;
    return today.getFullYear() === year && today.getMonth() === mon - 1
      ? today
      : new Date(year, mon - 1, 1);
  };
  const switchToWeek = () => goWeek(sundayOf(anchorDate()));
  const switchToMonth = () => {
    const d = anchorDate();
    goMonth(d.getFullYear(), d.getMonth() + 1);
  };

  function openAdd(iso: string, hour?: number, dur?: number) {
    setPreview(null);
    setOpenMore(null);
    setAddTime(hour != null ? `${pad(hour)}:00` : null);
    setAddDuration(dur ?? null);
    setAddDate(iso);
  }

  const monthLabel = new Date(year, mon - 1, 1).toLocaleString("en-US", {
    month: "long",
    year: "numeric",
  });
  const weekEnd = addDays(ws, 6);
  const weekLabel = `${ws.toLocaleString("en-US", { month: "short", day: "numeric" })} – ${weekEnd.toLocaleString(
    "en-US",
    ws.getMonth() === weekEnd.getMonth() ? { day: "numeric" } : { month: "short", day: "numeric" }
  )}, ${weekEnd.getFullYear()}`;
  const headerLabel = view === "week" ? weekLabel : monthLabel;

  // The days the time grid shows: always 7, for week. Kept as its own flag (rather than
  // inlining `view === "week"` at every call site) since a lot of the rendering below
  // branches on "month grid vs. time grid" as a concept.
  const isTimeGrid = view === "week";
  const gridDays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => addDays(ws, i)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [weekStart]
  );

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

  // ---- Time grid range ----
  // Visible hour window: the default, widened to include any out-of-window session.
  let rangeStart = DEFAULT_START_HOUR;
  let rangeEnd = DEFAULT_END_HOUR;
  if (isTimeGrid) {
    for (const cell of gridDays) {
      for (const s of byDate.get(dateKey(cell)) ?? []) {
        const st = new Date(s.start);
        const sMin = st.getHours() * 60 + st.getMinutes();
        rangeStart = Math.min(rangeStart, Math.floor(sMin / 60));
        rangeEnd = Math.max(rangeEnd, Math.ceil((sMin + s.durationMin) / 60));
      }
    }
  }
  rangeStart = Math.max(0, rangeStart);
  rangeEnd = Math.min(24, rangeEnd);
  const hours = Array.from({ length: rangeEnd - rangeStart }, (_, i) => rangeStart + i);
  const gridHeight = (rangeEnd - rangeStart) * HOUR_PX;
  const nowMin = today.getHours() * 60 + today.getMinutes();

  // Pointer handlers run from window listeners and would otherwise close over the render
  // that started the gesture; the range can widen mid-drag as an event is dragged past the
  // window edge, so read it from a ref instead of a stale closure.
  const rangeRef = useRef({ start: rangeStart, end: rangeEnd });
  rangeRef.current = { start: rangeStart, end: rangeEnd };

  // Precompute each shown day's time-grid layout once. A gesture fires setDrag on every
  // pointer move, re-rendering the whole grid; without this the (non-trivial) overlap
  // layout would be recomputed for every column on every frame.
  const positionedByDate = useMemo(() => {
    const m = new Map<string, Positioned[]>();
    if (!isTimeGrid) return m;
    for (const d of gridDays) {
      const iso = dateKey(d);
      m.set(iso, positionDay(byDate.get(iso) ?? [], rangeStart));
    }
    return m;
  }, [isTimeGrid, gridDays, byDate, rangeStart]);

  // Emptiness is judged over the visible days only — the page over-fetches neighboring
  // days (timezone padding) which must not suppress the empty-state message.
  const shownKeys = isTimeGrid
    ? gridDays.map(dateKey)
    : monthCells.filter((d): d is Date => d !== null).map(dateKey);
  const hasVisible = shownKeys.some((k) => (byDate.get(k)?.length ?? 0) > 0);

  // ---- Persisting a reschedule ----

  // A pointer drag ends with a synthetic click on whatever the pointer was released over.
  // Every click handler in the grid checks this, so releasing a drag never ALSO opens a
  // preview or the Add-session modal. Cleared on the next tick, after that click.
  const suppressClick = useRef(false);
  function armClickSuppression() {
    suppressClick.current = true;
    setTimeout(() => {
      suppressClick.current = false;
    }, 0);
  }

  async function commitSchedule(id: string, next: { start: string; durationMin: number }) {
    const current = byId.get(id);
    if (!current) return;
    const body: Record<string, unknown> = {};
    if (next.start !== current.start) body.start = next.start;
    if (next.durationMin !== current.durationMin) body.durationMin = next.durationMin;
    if (Object.keys(body).length === 0) return; // dropped where it started

    setDragError(null);
    setOverrides((o) => new Map(o).set(id, next));
    try {
      const res = await fetch(`/api/sessions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Save failed.");
      }
      // Re-read so the ledger/dashboard figures and the mirrored event state agree with
      // the grid; the override is dropped once the server row matches.
      router.refresh();
    } catch (e) {
      setOverrides((o) => {
        const n = new Map(o);
        n.delete(id);
        return n;
      });
      setDragError(
        e instanceof Error && e.message
          ? `${e.message} The session stayed where it was.`
          : "Could not move the session — it stayed where it was."
      );
    }
  }

  // ---- Pointer gestures ----
  // Press-and-sweep on empty grid creates; press on an event moves it; press on an event's
  // bottom edge resizes it. All three snap to SNAP minutes and share one window-listener
  // pipeline. Pointer events (not mouse) so mouse, touch and pen behave alike; the columns
  // set touch-action:none so a touch-drag sweeps instead of scrolling.
  const snap = (m: number) => Math.round(m / SNAP) * SNAP;
  const minutesAt = (clientY: number, rectTop: number) => {
    const { start, end } = rangeRef.current;
    const y = Math.max(0, Math.min((end - start) * HOUR_PX, clientY - rectTop));
    return start * 60 + (y / HOUR_PX) * 60;
  };

  function detach() {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    window.removeEventListener("pointercancel", onCancel);
  }

  function onMove(e: PointerEvent) {
    const d = dragRef.current;
    if (!d) return;
    if (
      !d.moved &&
      Math.abs(e.clientX - d.originX) < DRAG_SLOP_PX &&
      Math.abs(e.clientY - d.originY) < DRAG_SLOP_PX
    ) {
      return; // still within click slop — don't start showing a drag
    }
    d.moved = true;

    const hit = dayUnderPointer(e.clientX, e.clientY);
    const { start: rStart, end: rEnd } = rangeRef.current;

    if (d.kind === "monthMove") {
      if (hit) d.iso = hit.iso;
      setDrag({ kind: "monthMove", id: d.id, iso: d.iso });
      return;
    }

    // Time-grid gestures need a vertical axis; ignore a stray hit on a non-time element
    // and keep using the column the gesture is already tracking.
    const rectTop = hit?.timed ? hit.rect.top : null;
    if (hit?.timed) d.iso = hit.iso;
    if (rectTop === null) return;
    const at = snap(minutesAt(e.clientY, rectTop));

    if (d.kind === "create") {
      setDrag({ kind: "create", iso: d.iso, a: d.anchorMin, b: at });
      return;
    }
    if (d.kind === "resize") {
      d.durationMin = Math.max(MIN_DURATION, snap(at - d.startMin));
      setDrag({ kind: "resize", id: d.id, iso: d.iso, startMin: d.startMin, durationMin: d.durationMin });
      return;
    }
    // move — keep the grab point under the cursor, and keep the event inside the window
    const maxStart = rEnd * 60 - d.durationMin;
    d.startMin = Math.max(rStart * 60, Math.min(maxStart, snap(at - d.grabOffsetMin)));
    setDrag({ kind: "move", id: d.id, iso: d.iso, startMin: d.startMin, durationMin: d.durationMin });
  }

  function onUp(e: PointerEvent) {
    const d = dragRef.current;
    detach();
    dragRef.current = null;
    setDrag(null);
    if (!d) return;

    if (!d.moved) return; // a click — the element's own onClick handles it

    armClickSuppression();

    if (d.kind === "create") {
      const hit = dayUnderPointer(e.clientX, e.clientY);
      const at = hit?.timed ? snap(minutesAt(e.clientY, hit.rect.top)) : d.anchorMin;
      const from = Math.min(d.anchorMin, at);
      const raw = Math.abs(at - d.anchorMin);
      const dur = raw < SNAP ? 60 : Math.max(raw, 30); // tiny sweep = click → default hour
      openAdd(d.iso, undefined, dur);
      setAddTime(`${pad(Math.floor(from / 60))}:${pad(from % 60)}`);
      return;
    }

    if (d.kind === "monthMove") {
      const s = byId.get(d.id);
      if (!s) return;
      const orig = new Date(s.start);
      const minutes = orig.getHours() * 60 + orig.getMinutes();
      void commitSchedule(d.id, { start: isoAt(d.iso, minutes), durationMin: s.durationMin });
      return;
    }

    void commitSchedule(d.id, {
      start: isoAt(d.iso, d.startMin),
      durationMin: d.durationMin,
    });
  }

  function onCancel() {
    detach();
    dragRef.current = null;
    setDrag(null);
  }

  function begin(e: ReactPointerEvent<HTMLElement>, state: DragState) {
    if (e.button !== 0 || !e.isPrimary) return; // primary button / first touch only
    dragRef.current = state;
    setPreview(null);
    setOpenMore(null);
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
    e.preventDefault();
  }

  function startCreate(e: ReactPointerEvent<HTMLDivElement>, iso: string) {
    const rectTop = e.currentTarget.getBoundingClientRect().top;
    const anchorMin = snap(minutesAt(e.clientY, rectTop));
    begin(e, {
      kind: "create",
      id: "",
      iso,
      originX: e.clientX,
      originY: e.clientY,
      moved: false,
      anchorMin,
      grabOffsetMin: 0,
      startMin: anchorMin,
      durationMin: 60,
    });
  }

  function startMove(e: ReactPointerEvent<HTMLElement>, s: CalendarSession, iso: string) {
    e.stopPropagation(); // don't also start a create-sweep on the column beneath
    const col = (e.currentTarget as HTMLElement).closest<HTMLElement>('[data-grid="time"]');
    if (!col) return;
    const st = new Date(s.start);
    const startMin = st.getHours() * 60 + st.getMinutes();
    const at = minutesAt(e.clientY, col.getBoundingClientRect().top);
    begin(e, {
      kind: "move",
      id: s.id,
      iso,
      originX: e.clientX,
      originY: e.clientY,
      moved: false,
      anchorMin: startMin,
      grabOffsetMin: at - startMin,
      startMin,
      durationMin: s.durationMin,
    });
  }

  function startResize(e: ReactPointerEvent<HTMLElement>, s: CalendarSession, iso: string) {
    e.stopPropagation(); // don't start a move on the event body
    const st = new Date(s.start);
    const startMin = st.getHours() * 60 + st.getMinutes();
    begin(e, {
      kind: "resize",
      id: s.id,
      iso,
      originX: e.clientX,
      originY: e.clientY,
      moved: false,
      anchorMin: startMin,
      grabOffsetMin: 0,
      startMin,
      durationMin: s.durationMin,
    });
  }

  function startMonthMove(e: ReactPointerEvent<HTMLElement>, s: CalendarSession, iso: string) {
    e.stopPropagation(); // the cell's own click opens the Add modal
    begin(e, {
      kind: "monthMove",
      id: s.id,
      iso,
      originX: e.clientX,
      originY: e.clientY,
      moved: false,
      anchorMin: 0,
      grabOffsetMin: 0,
      startMin: 0,
      durationMin: s.durationMin,
    });
  }

  // ---- Keyboard shortcuts (Google Calendar's: w/m switch view, t = today, ←/→ page) ----
  // The handler is stashed in a ref so the window listener is attached once but always
  // runs the current render's closure — no re-subscribing on every keystroke-adjacent
  // state change, and no stale view/date.
  const keyHandler = useRef<(e: KeyboardEvent) => void>(undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (addDate || drag) return; // modal open / mid-gesture
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement | null;
    if (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))) return;

    switch (e.key.toLowerCase()) {
      case "w":
        switchToWeek();
        break;
      case "m":
        switchToMonth();
        break;
      case "t":
        goToday();
        break;
      case "arrowleft":
        prev();
        break;
      case "arrowright":
        next();
        break;
      case "escape":
        setPreview(null);
        setOpenMore(null);
        return;
      default:
        return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const h = (e: KeyboardEvent) => keyHandler.current?.(e);
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // ---- Scroll the time grid to the current hour, once per view/date ----
  // Runs on every render but the key guard makes it a no-op after the first, so it never
  // yanks the scroll position out from under someone reading a different part of the day.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const scrolledFor = useRef("");
  useEffect(() => {
    const key = `${view}:${weekStart}`;
    if (!isTimeGrid || scrolledFor.current === key) return;
    const el = scrollRef.current;
    if (!el) return;
    scrolledFor.current = key;
    // Put "now" a third of the way down, the way Google Calendar opens.
    el.scrollTop = Math.max(0, ((nowMin - rangeStart * 60) / 60) * HOUR_PX - el.clientHeight / 3);
  });

  // ---- Renderers ----
  // Plain render functions (NOT nested components) so the rapid re-renders during a drag
  // reconcile in place instead of remounting the whole grid every frame.

  // `openUp` flips the day's popovers to grow upward. The month grid is `overflow-hidden`
  // (for its rounded corners), so a downward popover in the bottom rows would be clipped —
  // cutting off the preview's "Open" link. Bottom-row cells anchor to the bottom instead.
  function renderMonthCell(date: Date, openUp: boolean) {
    const iso = dateKey(date);
    const daySessions = byDate.get(iso) ?? [];
    const visible = daySessions.slice(0, 4);
    const extra = daySessions.length - visible.length;
    const isToday = iso === todayKey;
    const popoverAnchor = openUp ? "bottom-8" : "top-8";
    const isDropTarget = drag?.kind === "monthMove" && drag.iso === iso;

    return (
      <div
        key={iso}
        data-day={iso}
        onClick={() => {
          if (suppressClick.current) return;
          openAdd(iso);
        }}
        className={`group relative min-h-32 min-w-0 cursor-pointer p-1.5 transition-colors duration-150 ${
          isDropTarget
            ? "bg-primary-soft ring-2 ring-inset ring-primary/50"
            : "bg-surface hover:bg-sunken/70"
        }`}
      >
        {/* Today's date sits in a filled pill — the one cell you should find without
            reading. Everything else is a plain muted numeral. */}
        <div className="mb-1 flex justify-end">
          <span
            className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-mono text-xs ${
              isToday ? "bg-primary font-semibold text-white" : "text-muted"
            }`}
          >
            {date.getDate()}
          </span>
        </div>
        <div className="space-y-1">
          {visible.map((s) => (
            <div
              key={s.id}
              onPointerDown={(e) => startMonthMove(e, s, iso)}
              className={`cursor-grab ${drag?.kind === "monthMove" && drag.id === s.id ? "opacity-40" : ""}`}
            >
              <SessionChip
                session={s}
                onSelect={(sel) => {
                  if (suppressClick.current) return;
                  setPreview(sel);
                }}
                showTime
              />
            </div>
          ))}
          {extra > 0 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (suppressClick.current) return;
                setPreview(null);
                setOpenMore(openMore === iso ? null : iso);
              }}
              className="w-full cursor-pointer truncate rounded-[6px] px-1.5 py-0.5 text-left text-xs font-medium text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              +{extra} more
            </button>
          )}
        </div>

        {openMore === iso && (
          <div
            onClick={(e) => e.stopPropagation()}
            className={`absolute left-1 right-1 z-20 max-h-64 space-y-1 overflow-y-auto rounded-card border border-hairline bg-surface p-1.5 shadow-pop ${popoverAnchor}`}
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
            backHref={`/?${viewParams}${studentQuery}`}
            className={`left-1 right-1 ${popoverAnchor}`}
          />
        )}
      </div>
    );
  }

  function renderTimeColumn(date: Date, dayIndex: number) {
    const iso = dateKey(date);
    const positioned = positionedByDate.get(iso) ?? [];
    const showNow = iso === todayKey && nowMin >= rangeStart * 60 && nowMin < rangeEnd * 60;
    const sel =
      drag?.kind === "create" && drag.iso === iso
        ? { a: Math.min(drag.a, drag.b), b: Math.max(drag.a, drag.b) }
        : null;
    const ghost =
      (drag?.kind === "move" || drag?.kind === "resize") && drag.iso === iso ? drag : null;
    const ghostSession = ghost ? byId.get(ghost.id) : null;

    return (
      <div
        key={iso}
        data-day={iso}
        data-grid="time"
        onPointerDown={(e) => startCreate(e, iso)}
        className="relative cursor-pointer select-none touch-none border-l border-hairline"
        style={{ height: gridHeight }}
      >
        {/* hour lines (visual only; the column itself handles press-drag). The
            half-hour rule is lighter than the hour rule, which is what makes a
            15-minute snap readable without counting pixels. */}
        {hours.map((h, i) => (
          <div key={h} className="pointer-events-none absolute inset-x-0" style={{ top: i * HOUR_PX, height: HOUR_PX }}>
            <div className="absolute inset-x-0 top-0 border-t border-hairline" />
            <div className="absolute inset-x-0 border-t border-hairline/50" style={{ top: HOUR_PX / 2 }} />
          </div>
        ))}

        {/* live create selection */}
        {sel && (
          <div
            className="pointer-events-none absolute inset-x-0 z-30 rounded-[6px] border border-primary/60 bg-primary/15"
            style={{
              top: ((sel.a - rangeStart * 60) / 60) * HOUR_PX,
              height: Math.max(((sel.b - sel.a) / 60) * HOUR_PX, 2),
            }}
          >
            <div className="px-1 pt-0.5 font-mono text-[10px] font-medium text-primary">
              {fmtMinLabel(sel.a)}
              {sel.b > sel.a ? ` – ${fmtMinLabel(sel.b)}` : ""}
            </div>
          </div>
        )}

        {/* events */}
        {positioned.map((pos) => {
          const dragging = drag?.kind !== "create" && drag?.id === pos.s.id;
          return (
            <div
              key={pos.s.id}
              style={{
                top: pos.top,
                height: pos.height,
                left: `${pos.left}%`,
                width: `calc(${pos.width}% - 3px)`,
              }}
              // While any gesture runs, events must not swallow the hit-test that finds the
              // column under the pointer.
              className={`absolute z-10 ${drag ? "pointer-events-none" : ""} ${
                dragging ? "opacity-30" : ""
              }`}
            >
              <button
                onPointerDown={(e) => startMove(e, pos.s, iso)}
                onClick={(e) => {
                  e.stopPropagation();
                  if (suppressClick.current) return;
                  setPreview(pos.s.id === preview?.id ? null : pos.s);
                }}
                // A tinted body with a saturated left rule: the rule survives at the
                // 15-minute height where a tint alone would be a faint sliver.
                className={`h-full w-full cursor-grab overflow-hidden rounded-[6px] border border-l-[3px] px-1.5 py-0.5 text-left text-xs leading-tight shadow-sm transition-[background-color,box-shadow] duration-150 hover:shadow-raise active:cursor-grabbing ${
                  pos.s.status === "cancelled"
                    ? "border-hairline border-l-hairline-strong bg-sunken text-faint"
                    : pos.s.paid
                      ? "border-good/25 border-l-good bg-good-soft text-good hover:bg-good/10"
                      : "border-warn/25 border-l-warn bg-warn-soft text-warn hover:bg-warn/10"
                }`}
              >
                <div
                  className={`truncate font-semibold ${pos.s.status === "cancelled" ? "line-through" : ""}`}
                >
                  {pos.s.studentName}
                </div>
                {pos.height >= 30 && (
                  <div className="truncate font-mono opacity-75">{fmtTime(pos.s.start)}</div>
                )}
              </button>
              {/* resize grip along the bottom edge */}
              <div
                onPointerDown={(e) => startResize(e, pos.s, iso)}
                className="absolute inset-x-0 bottom-0 h-1.5 cursor-ns-resize rounded-b"
                aria-hidden
              />
            </div>
          );
        })}

        {/* live move/resize ghost */}
        {ghost && ghostSession && (
          <div
            className="pointer-events-none absolute inset-x-0 z-40 overflow-hidden rounded-[6px] border-2 border-primary bg-primary/20 px-1.5 py-0.5 text-xs leading-tight shadow-raise"
            style={{
              top: ((ghost.startMin - rangeStart * 60) / 60) * HOUR_PX,
              height: Math.max((ghost.durationMin / 60) * HOUR_PX - 2, 16),
            }}
          >
            <div className="truncate font-semibold text-primary">{ghostSession.studentName}</div>
            <div className="truncate font-mono text-[10px] text-primary">
              {fmtMinLabel(ghost.startMin)} – {fmtMinLabel(ghost.startMin + ghost.durationMin)}
            </div>
          </div>
        )}

        {/* current-time indicator. Stays red rather than moving to --primary: it marks
            a moment, not something you can act on, and must not read as a control. */}
        {showNow && (
          <div
            className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-danger"
            style={{ top: ((nowMin - rangeStart * 60) / 60) * HOUR_PX }}
          >
            <span className="absolute -left-1 -top-1 block h-2 w-2 rounded-full bg-danger" />
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
                backHref={`/?${viewParams}${studentQuery}`}
                className={`w-64 ${dayIndex >= 4 ? "right-0" : "left-0"}`}
                style={openUp ? { bottom: Math.max(gridHeight - evTop, 0) } : { top: Math.max(evTop - 4, 0) }}
              />
            );
          })()}
      </div>
    );
  }

  const gridCols = `3.5rem repeat(${gridDays.length}, minmax(0, 1fr))`;

  return (
    <div className="space-y-4">
      {studentFilter && (
        <div className="flex items-center gap-2 rounded-control border border-primary/25 bg-primary-soft px-3 py-1.5 text-sm text-primary">
          <span>Showing only {studentFilter.name}</span>
          {/* Clearing the filter keeps you on the same view and date, not just the month. */}
          <Link href={`/?${viewParams}`} className="font-medium underline-offset-2 hover:underline">
            Clear
          </Link>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
        <h1 className="text-xl font-semibold tracking-tight text-ink">{headerLabel}</h1>
        {/* Three distinct control treatments so they don't read as one wall of
            identical buttons: soft segmented toggle · outlined nav pill · solid action. */}
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <Segmented
            ariaLabel="Calendar view"
            value={view}
            onChange={(v) => (v === "week" ? switchToWeek() : switchToMonth())}
            options={[
              { value: "week", label: "Week" },
              { value: "month", label: "Month" },
            ]}
          />

          {/* Date navigation — one outlined pill reads as a single control */}
          <div className="inline-flex items-center overflow-hidden rounded-control border border-hairline-strong bg-surface shadow-sm">
            <button
              onClick={prev}
              aria-label="Previous"
              title="Previous (←)"
              className="flex h-8 w-8 cursor-pointer items-center justify-center text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <button
              onClick={goToday}
              title="Today (T)"
              className="h-8 cursor-pointer border-x border-hairline px-3 text-sm font-medium text-ink-soft transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              Today
            </button>
            <button
              onClick={next}
              aria-label="Next"
              title="Next (→)"
              className="flex h-8 w-8 cursor-pointer items-center justify-center text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <SyncAllButton month={month} configured={gcalConfigured} unsynced={unsyncedCount} />
        </div>
      </div>

      {dragError && (
        <div className="flex items-center gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
          <span>{dragError}</span>
          <button
            onClick={() => setDragError(null)}
            className="ml-auto cursor-pointer text-xs font-medium underline-offset-2 hover:underline"
          >
            Dismiss
          </button>
        </div>
      )}

      {isTimeGrid ? (
        <div className="overflow-hidden rounded-card border border-hairline bg-surface text-sm shadow-card">
          {/* header: day names + dates (outside the scroller, so it stays put) */}
          <div className="grid bg-sunken/60" style={{ gridTemplateColumns: gridCols }}>
            <div className="border-b border-hairline" />
            {gridDays.map((date) => {
              const isToday = dateKey(date) === todayKey;
              return (
                <div
                  key={dateKey(date)}
                  className="border-b border-l border-hairline px-1 py-2 text-center"
                >
                  <div className="text-[11px] font-medium uppercase tracking-wide text-muted">
                    {WEEKDAYS[date.getDay()]}
                  </div>
                  <div className="mt-0.5 flex justify-center">
                    <span
                      className={`flex h-6 min-w-6 items-center justify-center rounded-full px-1.5 font-mono text-sm ${
                        isToday ? "bg-primary font-semibold text-white" : "text-ink-soft"
                      }`}
                    >
                      {date.getDate()}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
          {/* body: hour gutter + day columns, scrollable and opened at the current hour */}
          <div ref={scrollRef} className="max-h-[70vh] overflow-y-auto">
            <div className="grid" style={{ gridTemplateColumns: gridCols }}>
              <div className="relative" style={{ height: gridHeight }}>
                {hours.map((h, i) => (
                  <div
                    key={h}
                    className={`absolute right-2 font-mono text-[10px] text-faint ${i === 0 ? "" : "-translate-y-1/2"}`}
                    style={{ top: i * HOUR_PX }}
                  >
                    {fmtHour(h)}
                  </div>
                ))}
              </div>
              {gridDays.map((date, i) => renderTimeColumn(date, i))}
            </div>
          </div>
          <p className="border-t border-hairline bg-sunken/40 px-3 py-2 text-xs text-muted">
            Drag an empty slot to create · drag a session to move it · drag its bottom edge to change
            length · keys: W/M, T, ←/→
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-7 gap-px overflow-hidden rounded-card border border-hairline bg-hairline text-sm shadow-card">
          {WEEKDAYS.map((w) => (
            <div
              key={w}
              className="min-w-0 bg-sunken/60 px-2 py-2 text-center text-[11px] font-medium uppercase tracking-wide text-muted"
            >
              {w}
            </div>
          ))}
          {monthCells.map((date, i) =>
            date === null ? (
              <div key={`e${i}`} className="min-h-32 min-w-0 bg-canvas" />
            ) : (
              renderMonthCell(date, Math.floor(i / 7) >= monthCells.length / 7 - 2)
            )
          )}
        </div>
      )}

      {!isTimeGrid && (
        <p className="text-xs text-muted">
          Click a day to add a session · drag a session to another day to reschedule it · keys: W/M,
          T, ←/→
        </p>
      )}

      {!hasVisible && (
        <p className="text-sm text-muted">
          No sessions this {view} — {isTimeGrid ? "drag across a day" : "click a day"} to add one.
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
// `style` let the time grid re-anchor it beside the event.
function PreviewPopover({
  session,
  onClose,
  backHref,
  className = "left-1 right-1 top-8",
  style,
}: {
  session: CalendarSession;
  onClose: () => void;
  // Where the session page's "Back to calendar" link should return to — this exact
  // view/date, not whatever the calendar's default landing page would show. Without
  // this, exiting a session always bounced back to the current month/week.
  backHref: string;
  className?: string;
  style?: CSSProperties;
}) {
  const d = new Date(session.start);
  return (
    <div
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={style}
      className={`absolute z-40 space-y-2.5 rounded-card border border-hairline bg-surface p-3.5 text-left shadow-pop ${className}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-ink">{session.studentName}</div>
        <button
          onClick={onClose}
          className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
          aria-label="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="font-mono text-xs text-muted">
        {formatSessionDate(d)} · {fmtTime(session.start)} · {session.durationMin} min
      </div>
      <div className="max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-ink-soft">
        {session.topic.trim() ? session.topic : <span className="text-faint">No topic yet</span>}
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-hairline pt-2.5">
        {/* A cancelled session isn't owed, so the paid/unpaid chip would be
            misleading — the status replaces it. Every other status keeps the money
            chip, since a no-show is still billable. */}
        {session.status === "cancelled" ? (
          <Badge tone={STATUS_TONE.cancelled}>{STATUS_LABEL.cancelled}</Badge>
        ) : (
          <span className="flex items-center gap-1.5">
            <Badge tone={session.paid ? "good" : "warn"}>
              {session.paid ? "Paid" : "Unpaid"} · <span className="font-mono">${session.amount}</span>
            </Badge>
            {session.status === "no_show" && (
              <Badge tone={STATUS_TONE.no_show}>{STATUS_LABEL.no_show}</Badge>
            )}
          </span>
        )}
        <Link
          href={`/sessions/${session.id}?from=${encodeURIComponent(backHref)}`}
          className={buttonClass({ variant: "secondary", size: "sm" })}
        >
          Open
          <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </div>
  );
}
