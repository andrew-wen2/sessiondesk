"use client";

import { useEffect } from "react";
import Button from "@/components/ui/Button";
import { AlertCircle } from "@/components/icons";

// Route-level error boundary. Must be a client component — that's Next's contract.
//
// The message is deliberately generic: `error.message` on a server-thrown error is
// redacted in production anyway, and the same rule as the API routes applies — a
// user gets something actionable, the details go to the server log.
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[app/error]", error);
  }, [error]);

  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-danger-soft text-danger">
        <AlertCircle className="h-5 w-5" />
      </span>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Something went wrong</h1>
        <p className="mt-1 text-sm text-muted">
          The page couldn&apos;t load. Try again — if it keeps happening, reload the app.
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-faint">Reference: {error.digest}</p>
        )}
      </div>
      <Button variant="secondary" onClick={reset}>
        Try again
      </Button>
    </div>
  );
}
