"use client";

import { Suspense, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Inline feedback after the Google OAuth redirect lands on `/?gcal=...`.
// `connected` has two variants: OAuth can succeed before the operator pastes the
// logged refresh token into GOOGLE_REFRESH_TOKEN (single-user Option A), so until
// isGcalConfigured() is true we tell them the token still needs to be set.
function bannerFor(status: string, configured: boolean):
  | { tone: "ok" | "warn" | "error"; text: string }
  | null {
  switch (status) {
    case "connected":
      return configured
        ? { tone: "ok", text: "Calendar connected." }
        : {
            tone: "warn",
            text:
              "Google authorized. Copy the refresh token from the server logs into GOOGLE_REFRESH_TOKEN, then redeploy to finish connecting.",
          };
    case "denied":
      return { tone: "warn", text: "Calendar connection denied." };
    case "error":
      return { tone: "error", text: "Calendar connection failed — try again." };
    default:
      return null;
  }
}

const TONE = {
  ok: "border-green-100 bg-green-100 text-green-600",
  warn: "border-orange-100 bg-orange-100 text-orange-500",
  error: "border-red-200 bg-white text-red-600",
};

function Banner({ configured }: { configured: boolean }) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [dismissed, setDismissed] = useState(false);

  const status = params.get("gcal");
  const banner = status ? bannerFor(status, configured) : null;
  if (!banner || dismissed) return null;

  function dismiss() {
    setDismissed(true);
    // Drop the ?gcal= param so a refresh doesn't re-show the banner.
    const next = new URLSearchParams(params.toString());
    next.delete("gcal");
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div
      className={`flex items-start justify-between gap-4 rounded-lg border px-4 py-3 text-sm ${TONE[banner.tone]}`}
    >
      <span>{banner.text}</span>
      <button
        onClick={dismiss}
        className="shrink-0 text-gray-500 transition-colors duration-150 hover:text-gray-900"
      >
        Dismiss
      </button>
    </div>
  );
}

// useSearchParams requires a Suspense boundary or `next build` fails.
export default function GcalBanner({ configured }: { configured: boolean }) {
  return (
    <Suspense fallback={null}>
      <Banner configured={configured} />
    </Suspense>
  );
}
