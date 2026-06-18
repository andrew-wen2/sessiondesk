"use client";

import { useState } from "react";

export type StudentDetailData = {
  id: string;
  name: string;
  subject: string;
  level: string;
  rate: number;
  notes: string;
};

type Status = "idle" | "saving" | "saved" | "error";
type Field = "level" | "rate" | "notes";

export default function StudentDetail({ student }: { student: StudentDetailData }) {
  const [level, setLevel] = useState(student.level);
  const [rate, setRate] = useState(String(student.rate));
  const [notes, setNotes] = useState(student.notes);
  const [saved, setSaved] = useState({
    level: student.level,
    rate: String(student.rate),
    notes: student.notes,
  });
  const [status, setStatus] = useState<Status>("idle");

  async function saveField(field: Field, value: string) {
    if (value === saved[field]) return;
    if (field === "rate") {
      const n = Number(value);
      if (!Number.isFinite(n) || n < 0) {
        setStatus("error");
        return;
      }
    }
    setStatus("saving");
    try {
      const res = await fetch(`/api/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: field === "rate" ? Number(value) : value }),
      });
      if (!res.ok) throw new Error();
      setSaved((s) => ({ ...s, [field]: value }));
      setStatus("saved");
      setTimeout(() => setStatus((s) => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setStatus("error");
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        {status === "saving" && <span className="text-gray-400">Saving…</span>}
        {status === "saved" && <span className="text-gray-400">Saved</span>}
        {status === "error" && (
          <span className="text-red-600">Save failed — edit and blur again to retry</span>
        )}
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Level</label>
        <p className="text-xs text-gray-400">
          Calibration string for the generator — the difficulty (competition + problem-number band)
          is inferred from this text, so keep it specific, e.g. &ldquo;AIME, problems 10–15&rdquo;.
        </p>
        <textarea
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          onBlur={() => saveField("level", level)}
          rows={3}
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Rate (per session)</label>
        <div className="mt-1 flex items-center gap-1">
          <span className="text-gray-500">$</span>
          <input
            type="number"
            min={0}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onBlur={() => saveField("rate", rate)}
            className="w-28 rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
          />
        </div>
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Notes</label>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          onBlur={() => saveField("notes", notes)}
          rows={3}
          placeholder="Anything not captured per-session"
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>
    </div>
  );
}
