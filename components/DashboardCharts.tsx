"use client";

import { useEffect, useMemo, useState } from "react";
import {
  computeDashboardSeries,
  topNWithOther,
  compactMoney,
  isBillable,
  type ChartRow,
  type DashboardSeries,
  type Bucket,
} from "@/lib/analytics";
import { Card, CardBody, CardHeader } from "./ui/Card";
import Segmented from "./ui/Segmented";
import {
  CHART_W,
  CHART_H,
  PAD,
  xForIndex,
  yFor,
  bandWidth,
  GridLines,
  XAxisLabels,
  ChartTooltip,
  HoverRule,
  SrOnlyTable,
  EmptyChart,
  useChartHover,
  useMax,
} from "./charts/chart-kit";

// The dashboard's chart section: revenue, session volume, per-student composition,
// and a teaching-time heatmap. Client-only because charts need
// hover state — everything ABOVE this component (the KPI tiles, the next-session
// strip) stays server-rendered, per the same reasoning components/StudentPayments.tsx
// already documents for "now": a value read from the clock during render can
// disagree between the SSR pass and hydration, so it must never happen here either.
//
// The hydration-safety trick: `seed` is computeDashboardSeries() ALREADY COMPUTED
// server-side (Node, UTC) by app/dashboard/page.tsx. `useState(seed)` means the
// very first client render — hydration — renders the exact same numbers the server
// HTML already contains, so there is nothing to mismatch. Only the effect below,
// which runs after mount and therefore only in the browser, recomputes the same
// pure function with the browser's OWN timezone and swaps the state in. A UTC month
// boundary silently becomes a local one one render later, with no flash — the seed
// is real data, not a placeholder.
export type ChartRowWithStudent = ChartRow & { studentName: string };

export default function DashboardCharts({
  rows,
  nowMs,
  seed,
}: {
  rows: ChartRowWithStudent[];
  nowMs: number;
  seed: DashboardSeries;
}) {
  const [series, setSeries] = useState<DashboardSeries>(seed);
  useEffect(() => {
    setSeries(computeDashboardSeries(rows, new Date(nowMs)));
    // rows/nowMs are stable for the life of the page (a fresh server render on
    // navigation supplies new ones), so this runs once per mount — exactly the
    // "correct after hydration" timing the pattern needs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3/6/12 months governs the calendar-month charts (revenue, students, paid mix) —
  // the ones whose x-axis IS months. Sessions-per-week and the heatmap keep their
  // own fixed rolling windows (16 weeks; the whole fetched range) since neither
  // chart's axis subdivides by month, and re-scoping them wouldn't change what
  // question they answer.
  const [range, setRange] = useState<3 | 6 | 12>(6);
  const monthly = series.monthly.slice(series.monthly.length - range);
  const revenueByMonth = series.revenueByMonth.slice(series.revenueByMonth.length - range);

  // Top students within the same monthly window — filtered by the same cutoff the
  // chart above it uses, so the two panels always describe the same period.
  const cutoff = monthly[0]?.start ?? 0;
  const byStudent = useMemo(() => {
    const totals = new Map<string, { name: string; value: number }>();
    for (const r of rows) {
      if (r.start < cutoff || !isBillable(r, nowMs)) continue;
      const cur = totals.get(r.studentId);
      if (cur) cur.value += r.amount;
      else totals.set(r.studentId, { name: r.studentName, value: r.amount });
    }
    const slices = Array.from(totals, ([key, v]) => ({ key, label: v.name, value: v.value }));
    return topNWithOther(slices, 6);
  }, [rows, cutoff, nowMs]);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Trends</h2>
        <Segmented
          ariaLabel="Chart range"
          value={String(range)}
          onChange={(v) => setRange(Number(v) as 3 | 6 | 12)}
          options={[
            { value: "3", label: "3M" },
            { value: "6", label: "6M" },
            { value: "12", label: "12M" },
          ]}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader size="sm" title="Revenue" description="Billable, by month" />
          <CardBody size="sm">
            <RevenueByMonth buckets={monthly} values={revenueByMonth} />
          </CardBody>
        </Card>
        <Card>
          <CardHeader size="sm" title="Sessions" description="Per week, last 16 weeks" />
          <CardBody size="sm">
            <SessionsPerWeek buckets={series.weekly} values={series.sessionsByWeek} />
          </CardBody>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <Card>
          <CardHeader size="sm" title="Revenue by student" />
          <CardBody size="sm">
            <RevenueByStudent slices={byStudent} />
          </CardBody>
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader size="sm" title="When you teach" description="Sessions by weekday and hour" />
          <CardBody size="sm">
            <TeachingHeatmap grid={series.heatmap} range={series.heatmapRange} />
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

// ---------- Revenue by month (area + crosshair) ----------

function RevenueByMonth({ buckets, values }: { buckets: Bucket[]; values: number[] }) {
  const max = useMax(values);
  const { svgRef, index, handlers } = useChartHover(buckets.length);

  if (buckets.every((b, i) => values[i] === 0)) {
    return <EmptyChart message="No billable sessions in this range yet." />;
  }

  const points = values.map((v, i) => [xForIndex(i, buckets.length), yFor(v, max)] as const);
  const line = points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const baseline = yFor(0, max);
  const area = `${line} L${points[points.length - 1][0]},${baseline} L${points[0][0]},${baseline} Z`;

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full touch-none"
        {...handlers}
      >
        <GridLines max={max} formatY={compactMoney} />
        <path d={area} className="fill-primary/10" stroke="none" />
        <path d={line} className="stroke-primary" fill="none" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
        {points.map(([x, y], i) => {
          // The current (partial) month renders as a hollow ring rather than a
          // solid dot — a visual note that this bar is still filling, so the last
          // point on the line never reads as a sudden drop.
          const partial = buckets[i].partial;
          return (
            <circle
              key={i}
              cx={x}
              cy={y}
              r={partial ? 3.5 : 2.5}
              className={partial ? "fill-surface stroke-primary" : "fill-primary"}
              strokeWidth={partial ? 2 : 0}
            />
          );
        })}
        {index !== null && <HoverRule x={xForIndex(index, buckets.length)} />}
        <XAxisLabels labels={buckets.map((b) => b.label)} />
      </svg>
      {index !== null && (
        <ChartTooltip xFrac={(index + 0.5) / buckets.length}>
          <div className="font-medium text-ink">
            {buckets[index].label}
            {buckets[index].partial ? " (so far)" : ""}
          </div>
          <div className="font-mono text-muted">${values[index]}</div>
        </ChartTooltip>
      )}
      <SrOnlyTable
        caption="Billable revenue by month"
        headers={["Month", "Revenue"]}
        rows={buckets.map((b, i) => [b.label + (b.partial ? " (partial)" : ""), `$${values[i]}`])}
      />
    </div>
  );
}

// ---------- Sessions per week (columns) ----------

function SessionsPerWeek({ buckets, values }: { buckets: Bucket[]; values: number[] }) {
  const max = useMax(values);
  const { svgRef, index, handlers } = useChartHover(buckets.length);

  if (values.every((v) => v === 0)) {
    return <EmptyChart message="No sessions in this range yet." />;
  }

  const bw = bandWidth(buckets.length);
  const barW = Math.max(bw * 0.5, 3);

  return (
    <div className="relative">
      <svg
        ref={svgRef}
        viewBox={`0 0 ${CHART_W} ${CHART_H}`}
        className="h-auto w-full touch-none"
        {...handlers}
      >
        <GridLines max={max} />
        {values.map((v, i) => {
          const x = xForIndex(i, buckets.length) - barW / 2;
          const y = yFor(v, max);
          const h = CHART_H - PAD.bottom - y;
          const hovered = index === i;
          return (
            <rect
              key={i}
              x={x}
              y={h > 0 ? y : CHART_H - PAD.bottom}
              width={barW}
              height={Math.max(h, 0)}
              rx={2}
              className={hovered ? "fill-primary" : buckets[i].partial ? "fill-primary/50" : "fill-primary/80"}
            >
              <title>{`${buckets[i].label}: ${v} session${v === 1 ? "" : "s"}`}</title>
            </rect>
          );
        })}
        {index !== null && <HoverRule x={xForIndex(index, buckets.length)} />}
        {/* Weekly labels are too dense to all fit — chart-kit's XAxisLabels already
            skips to fit, so no separate handling needed here. */}
        <XAxisLabels labels={buckets.map((b) => b.label)} />
      </svg>
      {index !== null && (
        <ChartTooltip xFrac={(index + 0.5) / buckets.length}>
          <div className="font-medium text-ink">{buckets[index].label}</div>
          <div className="text-muted">
            {values[index]} session{values[index] === 1 ? "" : "s"}
          </div>
        </ChartTooltip>
      )}
      <SrOnlyTable
        caption="Sessions per week"
        headers={["Week of", "Sessions"]}
        rows={buckets.map((b, i) => [b.label, values[i]])}
      />
    </div>
  );
}

// ---------- Revenue by student (horizontal bars) ----------

function RevenueByStudent({ slices }: { slices: { key: string; label: string; value: number }[] }) {
  if (slices.length === 0) {
    return <EmptyChart message="No billable revenue in this range yet." />;
  }

  const W = 400;
  const rowH = 21;
  const gap = 4;
  const H = slices.length * (rowH + gap);
  const max = Math.max(...slices.map((s) => s.value), 1);
  const labelW = 76; // room for a student name before the bar starts
  const barMax = W - labelW - 44; // leave room for the trailing value label

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {slices.map((s, i) => {
          const y = i * (rowH + gap);
          const w = Math.max((s.value / max) * barMax, 2);
          return (
            <g key={s.key}>
              <text
                x={labelW - 8}
                y={y + rowH / 2}
                textAnchor="end"
                dominantBaseline="middle"
                className="fill-ink-soft text-[11px]"
              >
                {s.label.length > 10 ? `${s.label.slice(0, 9)}…` : s.label}
              </text>
              <rect
                x={labelW}
                y={y + 3}
                width={w}
                height={rowH - 6}
                rx={4}
                className={s.key === "__other" ? "fill-muted/60" : "fill-primary"}
              >
                <title>{`${s.label}: $${s.value}`}</title>
              </rect>
              <text
                x={labelW + w + 6}
                y={y + rowH / 2}
                dominantBaseline="middle"
                className="fill-muted font-mono text-[10px]"
              >
                {compactMoney(s.value)}
              </text>
            </g>
          );
        })}
      </svg>
      <SrOnlyTable
        caption="Revenue by student"
        headers={["Student", "Revenue"]}
        rows={slices.map((s) => [s.label, `$${s.value}`])}
      />
    </div>
  );
}

// ---------- Teaching heatmap (weekday x hour) ----------

const WEEKDAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtHour(h: number) {
  const ampm = h < 12 ? "AM" : "PM";
  const hr = h % 12 === 0 ? 12 : h % 12;
  return `${hr} ${ampm}`;
}

function TeachingHeatmap({
  grid,
  range,
}: {
  grid: number[][];
  range: { from: number; to: number };
}) {
  const hours = Array.from({ length: range.to - range.from + 1 }, (_, i) => range.from + i);
  const max = Math.max(...grid.flat(), 1);
  const [hovered, setHovered] = useState<{ day: number; hour: number } | null>(null);

  // Cells are wider than they are tall on purpose: this card spans 2/3 of its row,
  // and aspect-preserving scaling (every chart on this page relies on it — a
  // non-uniform "none" stretch was tried and rejected, because it distorts the
  // weekday/hour TEXT along with the cells) means the panel's rendered height
  // tracks W:H at whatever width the grid gives it. A flatter ratio keeps this
  // panel from towering over its row-mate on a wide screen without touching how
  // scaling works anywhere else.
  const cellW = 46;
  const cellH = 13;
  const labelW = 34;
  const labelH = 13;
  const W = labelW + 7 * cellW;
  const H = labelH + hours.length * cellH;

  const anyData = grid.some((row) => row.some((v) => v > 0));
  if (!anyData) {
    return <EmptyChart message="No sessions yet to show a pattern." />;
  }

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full">
        {WEEKDAY.map((d, di) => (
          <text
            key={d}
            x={labelW + di * cellW + cellW / 2}
            y={labelH - 5}
            textAnchor="middle"
            className="fill-muted text-[9px]"
          >
            {d}
          </text>
        ))}
        {hours.map((h, hi) => (
          <text
            key={h}
            x={labelW - 6}
            y={labelH + hi * cellH + cellH / 2}
            textAnchor="end"
            dominantBaseline="middle"
            className="fill-muted text-[9px]"
          >
            {fmtHour(h)}
          </text>
        ))}
        {hours.map((h, hi) =>
          WEEKDAY.map((_, di) => {
            const count = grid[di][h];
            // Five discrete opacity steps on one hue — sequential magnitude, never
            // a rainbow. An empty cell still renders (at --sunken) so the grid
            // reads as "checked, zero" rather than a hole.
            const step = count === 0 ? 0 : Math.min(4, Math.ceil((count / max) * 4));
            const opacityClass = [
              "fill-sunken",
              "fill-primary/25",
              "fill-primary/45",
              "fill-primary/65",
              "fill-primary/90",
            ][step];
            const isHovered = hovered?.day === di && hovered?.hour === h;
            return (
              <rect
                key={`${di}-${h}`}
                x={labelW + di * cellW + 1}
                y={labelH + hi * cellH + 1}
                width={cellW - 2}
                height={cellH - 2}
                rx={3}
                className={`${opacityClass} transition-opacity duration-150 ${isHovered ? "opacity-80" : ""}`}
                onPointerEnter={() => setHovered({ day: di, hour: h })}
                onPointerLeave={() => setHovered((cur) => (cur?.day === di && cur?.hour === h ? null : cur))}
              >
                <title>{`${WEEKDAY[di]} ${fmtHour(h)}: ${count} session${count === 1 ? "" : "s"}`}</title>
              </rect>
            );
          })
        )}
      </svg>
      {hovered && (
        <div className="pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 rounded-control border border-hairline bg-surface px-2.5 py-1.5 text-xs shadow-pop">
          <span className="font-medium text-ink">
            {WEEKDAY[hovered.day]} {fmtHour(hovered.hour)}
          </span>
          <span className="ml-1.5 text-muted">
            {grid[hovered.day][hovered.hour]} session{grid[hovered.day][hovered.hour] === 1 ? "" : "s"}
          </span>
        </div>
      )}
    </div>
  );
}
