import type { ReactNode } from "react";

// The app's surface. `rounded-lg border border-gray-200 bg-white p-4` was repeated at
// eight sites with drifting padding; this fixes the chrome and leaves padding to the
// body, so a card can also hold a full-bleed list or grid.
//
// Deliberately three pieces rather than one component with a dozen props — a card
// with a header, a card with only a body, and a card wrapping a divided list all
// compose from the same parts.

export function Card({
  className = "",
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`rounded-card border border-hairline bg-surface shadow-card ${className}`}>
      {children}
    </div>
  );
}

// `size` picks the padding, rather than letting a caller override it via className —
// Tailwind resolves conflicting utilities by their order in the generated stylesheet,
// not the order they appear in the class attribute, so a caller passing `py-2` next
// to the default `py-3.5` can silently lose (see the same rule in ui/Field.tsx). A
// prop can't conflict. "sm" exists for dense stacks of small cards — the dashboard
// charts are the first user — everywhere else keeps the default "md" rhythm.
export type CardSize = "sm" | "md";

const HEADER_PAD: Record<CardSize, string> = { sm: "px-4 py-2.5", md: "px-5 py-3.5" };
const BODY_PAD: Record<CardSize, string> = { sm: "px-4 py-3", md: "px-5 py-4" };

export function CardHeader({
  title,
  description,
  action,
  size = "md",
  className = "",
}: {
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  size?: CardSize;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-wrap items-start justify-between gap-x-4 gap-y-2 border-b border-hairline ${HEADER_PAD[size]} ${className}`}
    >
      <div className="min-w-0">
        <h2 className="text-sm font-semibold text-ink">{title}</h2>
        {description && <p className="mt-0.5 text-sm text-muted">{description}</p>}
      </div>
      {action && <div className="flex shrink-0 items-center gap-2">{action}</div>}
    </div>
  );
}

export function CardBody({
  size = "md",
  className = "",
  children,
}: {
  size?: CardSize;
  className?: string;
  children: ReactNode;
}) {
  return <div className={`${BODY_PAD[size]} ${className}`}>{children}</div>;
}
