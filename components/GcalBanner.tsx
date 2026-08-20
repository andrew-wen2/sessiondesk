"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { AlertCircle, CircleCheck, X } from "./icons";

// Inline feedback after the Google OAuth redirect lands on `/?gcal=...`. The
// callback stores the user's refresh token on connect, so success is terminal —
// no follow-up step.
function bannerFor(status: string):
  | { tone: "ok" | "warn" | "error"; text: string }
  | null {
  switch (status) {
    case "connected":
      return { tone: "ok", text: "Calendar connected." };
    case "denied":
      return { tone: "warn", text: "Calendar connection denied." };
    case "error":
      return { tone: "error", text: "Calendar connection failed — try again." };
    default:
      return null;
  }
}

const TONE = {
  ok: "border-good/25 bg-good-soft text-good",
  warn: "border-warn/25 bg-warn-soft text-warn",
  error: "border-danger/25 bg-danger-soft text-danger",
};

const ICON = {
  ok: CircleCheck,
  warn: AlertCircle,
  error: AlertCircle,
};

function Banner() {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);

  const status = params.get("gcal");
  const banner = status ? bannerFor(status) : null;
  if (!banner || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    // Drop the ?gcal= param so a refresh doesn't re-show the banner.
    const next = new URLSearchParams(params.toString());
    next.delete("gcal");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  const Icon = ICON[banner.tone];

  return (
    <div
      className={`flex items-center justify-between gap-4 rounded-card border px-4 py-3 text-sm ${TONE[banner.tone]}`}
    >
      <span className="flex items-center gap-2">
        <Icon className="h-4 w-4 shrink-0" />
        {banner.text}
      </span>
      <button
        onClick={dismiss}
        aria-label="Dismiss"
        className="-mr-1 flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md transition-colors duration-150 hover:bg-ink/5"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}

// useSearchParams requires a Suspense boundary or `next build` fails.
export default function GcalBanner() {
  return (
    <Suspense fallback={null}>
      <Banner />
    </Suspense>
  );
}
