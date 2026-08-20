// Skeleton for the dashboard. Mirrors the real grid — six tiles, the next-session
// strip, and the chart panels — so nothing reflows when the data resolves. Sizes
// track the real page's compact rhythm (see page.tsx / DashboardCharts.tsx / the
// CHART_H constant in chart-kit.tsx) — keep the two in sync when either changes.

const Bar = ({ className }: { className: string }) => (
  <div className={`rounded bg-hairline ${className}`} />
);

const ChartPanel = ({ className = "" }: { className?: string }) => (
  <div className={`rounded-card border border-hairline bg-surface ${className}`}>
    <div className="border-b border-hairline px-4 py-2.5">
      <Bar className="h-3 w-28" />
    </div>
    <div className="h-36 px-4 py-3">
      <Bar className="h-full w-full" />
    </div>
  </div>
);

export default function Loading() {
  return (
    <div className="mx-auto max-w-[1600px] animate-pulse space-y-5">
      <Bar className="h-7 w-36" />

      <div className="grid gap-3 grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rounded-card border border-hairline bg-surface px-4 py-3">
            <Bar className="h-3 w-20" />
            <Bar className="mt-1 h-7 w-16" />
            <Bar className="mt-1.5 h-3 w-20" />
            <Bar className="mt-1.5 h-6 w-full" />
          </div>
        ))}
      </div>

      <div className="space-y-1.5">
        <Bar className="h-3 w-24" />
        <div className="flex items-center gap-4 rounded-card border border-hairline bg-surface px-4 py-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-hairline" />
          <div className="flex-1 space-y-2">
            <Bar className="h-4 w-32" />
            <Bar className="h-3 w-48" />
          </div>
          <Bar className="h-9 w-28" />
        </div>
      </div>

      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Bar className="h-3 w-16" />
          <Bar className="h-8 w-32" />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartPanel className="lg:col-span-2" />
          <ChartPanel />
        </div>
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
          <ChartPanel />
          <ChartPanel className="lg:col-span-2" />
        </div>
      </div>
    </div>
  );
}
