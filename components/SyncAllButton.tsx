"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

// "Sync all to Calendar" — reconciles every session in the visible month with
// Google Calendar (backfills missing events, patches existing ones). Renders
// nothing when Calendar isn't connected; the GcalBanner owns that messaging.
type Status = "idle" | "syncing" | "done" | "error";

export default function SyncAllButton({
  month,
  configured,
}: {
  month: string; // YYYY-MM, the visible month
  configured: boolean;
}) {
  const router = useRouter();
  const [status, setStatus] = useState<Status>("idle");
  const [result, setResult] = useState("");

  if (!configured) return null;

  async function syncAll() {
    setStatus("syncing");
    setResult("");
    try {
      const res = await fetch("/api/sessions/sync-all", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ month }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setStatus("error");
        setResult(data.error ?? "Sync failed — try again.");
        return;
      }
      const { created = 0, patched = 0, failed = 0 } = data;
      let msg = `Synced — ${created} added, ${patched} updated`;
      if (failed > 0) msg += `, ${failed} failed — try again`;
      setStatus("done");
      setResult(msg + ".");
      // Refresh so any newly-stored googleEventIds are reflected in the page data.
      router.refresh();
    } catch {
      setStatus("error");
      setResult("Sync failed — check your connection and try again.");
    }
  }

  return (
    <div className="flex items-center gap-2">
      {result && (
        <span className={`text-xs ${status === "error" ? "text-red-600" : "text-gray-500"}`}>
          {result}
        </span>
      )}
      <button
        onClick={syncAll}
        disabled={status === "syncing"}
        className="rounded bg-blue-600 px-2 py-1 text-white transition-colors duration-150 hover:bg-blue-700 disabled:opacity-60"
      >
        {status === "syncing" ? "Syncing…" : "Sync all to Calendar"}
      </button>
    </div>
  );
}
