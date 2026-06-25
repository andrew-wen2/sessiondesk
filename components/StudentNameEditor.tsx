"use client";

import { useState } from "react";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";

// Inline-editable student name styled as the page heading. Saves on blur; an
// empty name reverts to the last saved value (names are required).
export default function StudentNameEditor({
  id,
  initialName,
}: {
  id: string;
  initialName: string;
}) {
  const [name, setName] = useState(initialName);
  const [saved, setSaved] = useState(initialName);
  const [status, setStatus] = useState<SaveStatus>("idle");

  async function save() {
    const trimmed = name.trim();
    if (!trimmed) {
      setName(saved); // can't be empty
      setStatus("idle");
      return;
    }
    if (trimmed === saved) return;
    setStatus("saving");
    try {
      const res = await fetch(`/api/students/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: trimmed }),
      });
      if (!res.ok) throw new Error();
      setName(trimmed);
      setSaved(trimmed);
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("error");
    }
  }

  return (
    <span className="inline-flex items-center gap-2">
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onBlur={save}
        aria-label="Student name"
        className="rounded border border-transparent px-1 text-xl font-bold hover:border-gray-200 focus:border-gray-300 focus:outline-none"
      />
      <SaveIndicator status={status} />
    </span>
  );
}
