"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import { AlertCircle, Refresh } from "./icons";

// "Sync all to Calendar" — reconciles every session in the visible month with
// Google Calendar (backfills missing events, patches existing ones). Renders
// nothing when Calendar isn't connected; the GcalBanner owns that messaging.
type Status = "idle" | "syncing" | "done" | "error";

export default function SyncAllButton({
  month,
  configured,
  unsynced = 0,
}: {
  month: string; // YYYY-MM, the visible month
  configured: boolean;
  // How many sessions in view have no mirrored event. Was a "needs attention" row on
  // the dashboard that linked back here; showing it ON the button that fixes it makes
  // the round trip unnecessary.
  unsynced?: number;
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
      const { created = 0, patched = 0, removed = 0, failed = 0 } = data;
      let msg = `Synced — ${created} added, ${patched} updated`;
      // Only mentioned when it happened: removing leftover events for cancelled
      // sessions is a repair, not part of the normal reconcile.
      if (removed > 0) msg += `, ${removed} removed`;
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
      {/* Once a sync has run, its result is the more specific message — don't show a
          stale backlog count next to "Synced — 3 added". */}
      {result ? (
        <span className={`text-xs ${status === "error" ? "text-danger" : "text-muted"}`}>
          {result}
        </span>
      ) : (
        unsynced > 0 && (
          <Badge tone="warn">
            <AlertCircle className="h-3 w-3" />
            {unsynced} not on Calendar
          </Badge>
        )
      )}
      <Button size="sm" onClick={syncAll} loading={status === "syncing"}>
        {status === "syncing" ? "Syncing…" : <Refresh className="h-3.5 w-3.5" />}
        {status === "syncing" ? null : "Sync all to Calendar"}
      </Button>
    </div>
  );
}
