// Server component — no "use client".
// Instant skeleton shown by Next.js Suspense streaming while the session page renders.
// Root is <div className="space-y-6"> to match SessionDetail's inner root;
// layout padding (max-w-4xl mx-auto px-4 py-8) is already applied by app/layout.tsx.
// No animation — CLAUDE.md allows only transition-colors duration-150.

export default function Loading() {
  return (
    <div className="space-y-6">
      {/* Back-link line */}
      <div className="h-4 w-32 rounded bg-gray-200" />

      {/* Header: name, date-time row, amount + paid-button row */}
      <div className="space-y-1">
        <div className="h-6 w-40 rounded bg-gray-200" />
        <div className="h-4 w-56 rounded bg-gray-200" />
        <div className="flex items-center gap-3">
          <div className="h-5 w-12 rounded bg-gray-200" />
          <div className="h-7 w-24 rounded bg-gray-200" />
        </div>
      </div>

      {/* Meet link section */}
      <div className="space-y-1">
        <div className="h-3 w-20 rounded bg-gray-200" />
        <div className="h-4 w-48 rounded bg-gray-200" />
      </div>

      {/* What we're covering section */}
      <div className="space-y-1">
        <div className="h-3 w-36 rounded bg-gray-200" />
        <div className="h-16 w-full rounded bg-gray-200" />
      </div>

      {/* Practice problems section */}
      <div className="space-y-3">
        <div className="h-3 w-32 rounded bg-gray-200" />
        <div className="h-8 w-36 rounded bg-gray-200" />
      </div>
    </div>
  );
}
