// Server component — no "use client".
// Instant skeleton shown by Next.js Suspense streaming while the session page renders.
// Root is <div className="space-y-6"> to match SessionDetail's inner root; the page
// shell (mx-auto max-w-4xl) and the layout padding are already applied above it.
//
// Shapes mirror the real cards, so the page doesn't reflow when content lands. The
// pulse is the app's only ambient animation and it respects prefers-reduced-motion
// via the global rule in globals.css.

const Bar = ({ className }: { className: string }) => (
  <div className={`rounded bg-hairline ${className}`} />
);

export default function Loading() {
  return (
    <div className="mx-auto max-w-4xl animate-pulse space-y-6">
      {/* Back-link line */}
      <Bar className="h-4 w-32" />

      {/* Header card: avatar, name, schedule line, amount, then the control row */}
      <div className="space-y-3 rounded-card border border-hairline bg-surface px-5 py-4">
        <div className="flex items-start gap-3">
          <div className="h-10 w-10 shrink-0 rounded-full bg-hairline" />
          <div className="flex-1 space-y-2">
            <Bar className="h-6 w-40" />
            <Bar className="h-4 w-56" />
          </div>
          <Bar className="h-6 w-14" />
        </div>
        <div className="flex items-center gap-3 border-t border-hairline pt-3">
          <Bar className="h-8 w-24" />
          <Bar className="h-8 w-32" />
        </div>
      </div>

      {/* Meet link card */}
      <div className="rounded-card border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <Bar className="h-4 w-20" />
        </div>
        <div className="px-5 py-4">
          <Bar className="h-4 w-48" />
        </div>
      </div>

      {/* Topic card */}
      <div className="rounded-card border border-hairline bg-surface">
        <div className="border-b border-hairline px-5 py-3.5">
          <Bar className="h-4 w-36" />
        </div>
        <div className="px-5 py-4">
          <Bar className="h-16 w-full" />
        </div>
      </div>

      {/* Practice card */}
      <div className="rounded-card border border-hairline bg-surface">
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <Bar className="h-4 w-32" />
          <Bar className="h-8 w-36" />
        </div>
        <div className="px-5 py-4">
          <Bar className="h-4 w-64" />
        </div>
      </div>
    </div>
  );
}
