import type { ReactNode } from "react";
import { Card, CardBody } from "./ui/Card";
import { AlertCircle } from "./icons";

// Login and register are the only pages with no navigation, so they get their own
// frame: the wordmark, then a single centred card. Both forms are otherwise
// identical in structure, and keeping the chrome in one place is what stops them
// drifting apart the way their input styling once did.
export default function AuthShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center bg-canvas px-4 py-12">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex items-center justify-center gap-2.5">
          <span
            className="flex h-8 w-8 items-center justify-center rounded-[10px] bg-primary text-sm font-bold text-white"
            aria-hidden
          >
            S
          </span>
          <span className="text-base font-semibold tracking-tight text-ink">SessionDesk</span>
        </div>

        <Card>
          <CardBody className="px-6 py-6">
            <h1 className="text-lg font-semibold tracking-tight text-ink">{title}</h1>
            {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
            <div className="mt-5">{children}</div>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}

export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

export function Divider({ label = "or" }: { label?: string }) {
  return (
    <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wider text-muted">
      <span className="h-px flex-1 bg-hairline" />
      {label}
      <span className="h-px flex-1 bg-hairline" />
    </div>
  );
}
