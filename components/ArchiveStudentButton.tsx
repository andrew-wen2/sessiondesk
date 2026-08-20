"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "./ui/Button";

// Archiving is reversible and non-destructive — unlike Delete, it never needs an
// inline confirm. It only changes which section of the roster this student renders
// in (the main list vs. "Past students" on /students); every other page — calendar,
// payments, the Add-session combobox — is untouched by this flag.
export default function ArchiveStudentButton({
  id,
  archived,
}: {
  id: string;
  archived: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/students/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ archived: !archived }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.error ?? "Could not update — try again.");
      }
      // Same reason as every other client write in this app: without this the
      // Router Cache keeps serving the pre-toggle student, so navigating back to
      // /students would still show them in their old section.
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update — try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" size="sm" onClick={toggle} loading={busy}>
        {busy ? (archived ? "Unarchiving…" : "Archiving…") : archived ? "Unarchive" : "Archive student"}
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </span>
  );
}
