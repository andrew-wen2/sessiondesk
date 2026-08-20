import type { ReactNode } from "react";

// An empty state says what to do next, not just that there is nothing here. Used
// anywhere a list can come back with no rows — an unexplained blank panel is the
// thing this replaces.
export default function EmptyState({
  icon,
  title,
  action,
  className = "",
}: {
  icon?: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={`flex flex-col items-center justify-center gap-2 rounded-card border border-dashed border-hairline-strong bg-surface/60 px-6 py-10 text-center ${className}`}
    >
      {icon && (
        <span className="flex h-9 w-9 items-center justify-center rounded-full bg-sunken text-muted">
          {icon}
        </span>
      )}
      <p className="text-sm text-muted">{title}</p>
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
