// Skeleton for the roster. Six cards is the shape of a typical roster; the grid
// breakpoints match the real page so the columns don't jump when data lands.

const Bar = ({ className }: { className: string }) => (
  <div className={`rounded bg-hairline ${className}`} />
);

export default function Loading() {
  return (
    <div className="mx-auto max-w-5xl animate-pulse space-y-5">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="space-y-2">
          <Bar className="h-7 w-32" />
          <Bar className="h-4 w-40" />
        </div>
        <div className="flex gap-2">
          <Bar className="h-8 w-36" />
          <Bar className="h-8 w-40" />
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div key={i} className="rounded-card border border-hairline bg-surface">
            <div className="flex items-start gap-3 px-5 pt-4">
              <div className="h-9 w-9 shrink-0 rounded-full bg-hairline" />
              <div className="flex-1 space-y-2">
                <Bar className="h-4 w-28" />
                <Bar className="h-3 w-40" />
              </div>
              <Bar className="h-4 w-10" />
            </div>
            <div className="mt-4 space-y-2 border-t border-hairline px-5 py-3">
              <Bar className="h-3 w-24" />
              <Bar className="h-3 w-full" />
              <Bar className="h-3 w-3/4" />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
