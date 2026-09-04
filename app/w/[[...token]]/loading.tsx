// Route-level skeleton mirroring the real card shape, per the repo's loading convention.
// A cold serverless start plus a Prisma round-trip plus the KaTeX stylesheet on a phone's
// 4G is otherwise a white screen for the least patient user in the system.
export default function Loading() {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
        <div className="mb-8 space-y-2">
          <div className="h-6 w-64 animate-pulse rounded bg-sunken" />
          <div className="h-4 w-80 animate-pulse rounded bg-sunken" />
        </div>
        <div className="space-y-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-card border border-hairline bg-surface p-5 shadow-card">
              <div className="h-6 w-6 animate-pulse rounded-full bg-sunken" />
              <div className="mt-3 h-4 w-full animate-pulse rounded bg-sunken" />
              <div className="mt-2 h-4 w-2/3 animate-pulse rounded bg-sunken" />
              <div className="mt-4 h-11 w-28 animate-pulse rounded-control bg-sunken" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
