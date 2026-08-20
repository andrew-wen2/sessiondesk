import type { ReactNode } from "react";

// Status pill. Every tone pairs a tint with an inset ring so the badge still reads as
// a distinct object on both --surface and --sunken, and every badge carries TEXT —
// colour alone never conveys the state (paid vs unpaid vs cancelled is a distinction
// a colour-blind user has to be able to make).

export type BadgeTone = "neutral" | "good" | "warn" | "danger" | "info";

export const BADGE_TONE: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-muted ring-hairline-strong",
  good: "bg-good-soft text-good ring-good/25",
  warn: "bg-warn-soft text-warn ring-warn/25",
  danger: "bg-danger-soft text-danger ring-danger/25",
  info: "bg-primary-soft text-primary ring-primary/25",
};

const BASE =
  "inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset";

export function badgeClass(tone: BadgeTone = "neutral", className = "") {
  return `${BASE} ${BADGE_TONE[tone]} ${className}`;
}

export default function Badge({
  tone = "neutral",
  className = "",
  children,
}: {
  tone?: BadgeTone;
  className?: string;
  children: ReactNode;
}) {
  return <span className={badgeClass(tone, className)}>{children}</span>;
}
