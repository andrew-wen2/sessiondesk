"use client";

import { useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { niceMax } from "@/lib/analytics";

// Shared geometry, hover math, and chrome for the dashboard's line/column charts
// (RevenueByMonth, SessionsPerWeek, PaidVsUnpaid). Built once so five charts don't
// grow five slightly-different copies of "where is the mouse, in chart units".
//
// Every chart renders into a FIXED internal coordinate space and scales via the SVG
// viewBox + CSS width — never JS resize-observers — so it never overflows its card
// and never needs a resize listener.
export const CHART_W = 600;
export const CHART_H = 168;
export const PAD = { top: 8, right: 8, bottom: 20, left: 38 };
export const PLOT_W = CHART_W - PAD.left - PAD.right;
export const PLOT_H = CHART_H - PAD.top - PAD.bottom;

export const bandWidth = (count: number) => (count > 0 ? PLOT_W / count : PLOT_W);

// Pixel center-x of bucket `i` of `count`, in the padded plot area.
export const xForIndex = (i: number, count: number) => PAD.left + (i + 0.5) * bandWidth(count);

// Pixel y for a value against `max`, larger values nearer the top. `max` is expected
// to already be run through niceMax so it's never 0 (which would divide by zero).
export const yFor = (value: number, max: number) => PAD.top + PLOT_H - (value / max) * PLOT_H;

// Track which bucket the pointer is over, in the shared coordinate space. Attach
// `handlers` to the outermost `<svg ref={svgRef}>`; `index` is null when the pointer
// is outside the plot (including the axis margins, which aren't a bucket).
export function useChartHover(count: number) {
  const svgRef = useRef<SVGSVGElement>(null);
  const [index, setIndex] = useState<number | null>(null);

  const handlers = {
    onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => {
      const svg = svgRef.current;
      if (!svg || count === 0) return;
      const rect = svg.getBoundingClientRect();
      // The rendered box is whatever CSS width the card gave it; convert back to the
      // fixed 600x220 coordinate space the geometry above is written in.
      const scaleX = CHART_W / rect.width;
      const plotX = (e.clientX - rect.left) * scaleX - PAD.left;
      if (plotX < 0 || plotX > PLOT_W) {
        setIndex(null);
        return;
      }
      setIndex(Math.min(count - 1, Math.max(0, Math.floor(plotX / bandWidth(count)))));
    },
    onPointerLeave: () => setIndex(null),
  };

  return { svgRef, index, handlers };
}

// Horizontal gridlines at 0 / half / max, with a left-aligned tick label. Recessive
// by design — `text-faint`/`hairline` — the marks are the point, not the ruler.
export function GridLines({
  max,
  formatY = String,
}: {
  max: number;
  formatY?: (v: number) => string;
}) {
  const ticks = [0, max / 2, max];
  return (
    <g>
      {ticks.map((t, i) => {
        const y = yFor(t, max);
        return (
          <g key={i}>
            <line
              x1={PAD.left}
              x2={CHART_W - PAD.right}
              y1={y}
              y2={y}
              className="stroke-hairline"
              strokeWidth={1}
            />
            <text x={PAD.left - 8} y={y} textAnchor="end" dominantBaseline="middle" className="fill-faint text-[9px]">
              {formatY(t)}
            </text>
          </g>
        );
      })}
    </g>
  );
}

// Bucket labels under the x-axis. Skips labels when there isn't room for all of
// them, rather than shrinking text past legibility or letting them overlap.
export function XAxisLabels({ labels }: { labels: string[] }) {
  const count = labels.length;
  const maxLabels = Math.floor(PLOT_W / 34); // ~34px is the narrowest a "Aug 30" label survives
  const step = Math.max(1, Math.ceil(count / Math.max(maxLabels, 1)));
  return (
    <g>
      {labels.map((label, i) =>
        i % step !== 0 && i !== count - 1 ? null : (
          <text
            key={i}
            x={xForIndex(i, count)}
            y={CHART_H - 6}
            textAnchor="middle"
            className="fill-muted text-[9px]"
          >
            {label}
          </text>
        )
      )}
    </g>
  );
}

// Floating tooltip positioned by fraction-of-width/height so it tracks the hovered
// mark without measuring the DOM. The parent must be `position: relative`.
// Clamped away from the edges so it never renders half off the card.
export function ChartTooltip({
  xFrac,
  yFrac = 0.15,
  children,
}: {
  xFrac: number;
  yFrac?: number;
  children: ReactNode;
}) {
  const left = Math.min(88, Math.max(12, xFrac * 100));
  return (
    <div
      className="pointer-events-none absolute z-10 -translate-x-1/2 rounded-control border border-hairline bg-surface px-2.5 py-1.5 text-xs shadow-pop"
      style={{ left: `${left}%`, top: `${yFrac * 100}%` }}
    >
      {children}
    </div>
  );
}

// A vertical rule marking the hovered bucket, drawn behind the marks.
export function HoverRule({ x }: { x: number }) {
  return (
    <line
      x1={x}
      x2={x}
      y1={PAD.top}
      y2={CHART_H - PAD.bottom}
      className="stroke-hairline-strong"
      strokeWidth={1}
      strokeDasharray="3 3"
    />
  );
}

// Dot + label legend, used only where a chart has 2+ series — a single series is
// named by its card title and gets no legend box.
export function Legend({ items }: { items: { label: string; swatchClassName: string }[] }) {
  return (
    <div className="flex flex-wrap items-center gap-3 text-xs text-muted">
      {items.map((it) => (
        <span key={it.label} className="flex items-center gap-1.5">
          <span className={`h-2 w-2 rounded-full ${it.swatchClassName}`} aria-hidden />
          {it.label}
        </span>
      ))}
    </div>
  );
}

// Screen-reader / no-JS fallback: every value a chart plots, as a real table. Visual
// charts are supplementary to this, not the only way to reach the data.
export function SrOnlyTable({
  caption,
  headers,
  rows,
}: {
  caption: string;
  headers: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="sr-only">
      <caption>{caption}</caption>
      <thead>
        <tr>
          {headers.map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i}>
            {r.map((c, j) => (
              <td key={j}>{c}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

// A chart with nothing to plot yet still draws its frame — never a blank box, and
// dividing by a real max (never 0) means no chart's path math has to special-case it.
export function EmptyChart({ message }: { message: string }) {
  return (
    <div className="flex h-[180px] items-center justify-center rounded-control bg-sunken/50 text-sm text-muted">
      {message}
    </div>
  );
}

// niceMax, re-exported from lib/analytics so chart components only need one import
// line from this file for the common case.
export { niceMax };

// Fixed month/day-of-week short labels, shared by every chart that needs them so the
// abbreviation style (3-letter month) matches across the dashboard.
export const useMax = (values: number[]) => useMemo(() => niceMax(Math.max(0, ...values)), [values]);
