"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import Button from "./ui/Button";
import { Trash } from "./icons";

// Delete a student (and all their sessions) with an inline confirm. On success
// it refreshes the list (or navigates to /students when used on the detail page).
export default function DeleteStudentButton({
  id,
  name,
  redirectTo,
}: {
  id: string;
  name: string;
  redirectTo?: string;
}) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/students/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not delete — try again.");
      }
      if (redirectTo) router.push(redirectTo);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not delete — try again.");
      setBusy(false);
      setConfirming(false);
    }
  }

  if (confirming) {
    return (
      <div className="flex flex-wrap items-center gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm">
        <span className="text-danger">Delete {name} and all their sessions?</span>
        <Button
          variant="dangerSolid"
          size="sm"
          onClick={handleDelete}
          loading={busy}
          className="ml-auto"
        >
          {busy ? "Deleting…" : "Delete"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3">
      <Button variant="danger" size="sm" onClick={() => setConfirming(true)}>
        <Trash className="h-3.5 w-3.5" />
        Delete student
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
