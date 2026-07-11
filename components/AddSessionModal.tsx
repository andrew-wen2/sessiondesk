"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StudentOption } from "@/lib/types";

const DURATIONS = [30, 45, 60, 90, 120];

export default function AddSessionModal({
  dateISO,
  timeHHMM,
  durationMin,
  onClose,
  onCreated,
}: {
  dateISO: string; // YYYY-MM-DD of the clicked day
  timeHHMM?: string; // HH:MM when opened from a week-view hour slot / drag
  durationMin?: number; // swept length when opened via week-view drag-to-create
  onClose: () => void;
  onCreated: () => void;
}) {
  const [students, setStudents] = useState<StudentOption[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<StudentOption | null>(null);
  const [showList, setShowList] = useState(false);

  const [rate, setRate] = useState<string>("");
  // Captured only when creating a NEW student (existing students keep their own).
  // New students are always created on the "general" engine (the API default); the
  // competition-math corpus is an opt-in toggle in Student detail, not a decision
  // forced at creation time.
  const [subject, setSubject] = useState("");
  const [date, setDate] = useState(dateISO);
  const [time, setTime] = useState(timeHHMM ?? "17:00");
  const [duration, setDuration] = useState(durationMin ?? 60);
  // A dragged length may not be one of the presets — offer it as an extra option.
  const durationOptions = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);
  const [topic, setTopic] = useState("");

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let active = true;
    fetch("/api/students")
      .then((r) => (r.ok ? r.json() : Promise.reject()))
      .then((data: StudentOption[]) => active && setStudents(data))
      .catch(() => active && setError("Could not load students — close and reopen."));
    nameRef.current?.focus();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return students;
    return students.filter((s) => s.name.toLowerCase().includes(q));
  }, [query, students]);

  function pick(student: StudentOption) {
    setSelected(student);
    setQuery(student.name);
    setRate(String(student.rate));
    setShowList(false);
  }

  const trimmedName = query.trim();
  const existing = students.find(
    (s) => s.name.toLowerCase() === trimmedName.toLowerCase()
  );
  const willCreate = trimmedName.length > 0 && !existing;

  async function save() {
    setError(null);
    if (!trimmedName) {
      setError("Enter a student name to save.");
      return;
    }
    const rateNum = Number(rate);
    if (!Number.isFinite(rateNum) || rateNum < 0) {
      setError("Rate must be a non-negative number.");
      return;
    }

    setSaving(true);
    try {
      let studentId = existing?.id ?? selected?.id;

      if (!studentId) {
        const res = await fetch("/api/students", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName, rate: rateNum, subject: subject.trim() }),
        });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: "" }));
          throw new Error(error || "Could not create student.");
        }
        studentId = (await res.json()).id;
      }

      const start = new Date(`${date}T${time}`);
      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          start: start.toISOString(),
          durationMin: duration,
          topic: topic.trim(),
          amount: rateNum,
        }),
      });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Could not create session.");
      }

      onCreated();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed — try again.");
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border border-gray-200 bg-white p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-lg font-semibold">Add session</h2>

        <div className="mt-4 space-y-4">
          {/* Student combobox */}
          <div className="relative">
            <label className="block text-sm text-gray-600">Student</label>
            <input
              ref={nameRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setSelected(null);
                setShowList(true);
              }}
              onFocus={() => setShowList(true)}
              placeholder="Search or type a new name"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
            {showList && matches.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-44 w-full overflow-auto rounded border border-gray-200 bg-white shadow">
                {matches.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => pick(s)}
                      className="flex w-full items-center justify-between px-2 py-1.5 text-left text-sm hover:bg-gray-50"
                    >
                      <span>{s.name}</span>
                      <span className="font-mono text-gray-500">${s.rate}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {willCreate && (
              <p className="mt-1 text-xs text-gray-500">
                New student — created on save. Set the level later in Students.
              </p>
            )}
            {!willCreate && selected?.subject && (
              <p className="mt-1 text-xs text-gray-500">Subject: {selected.subject}</p>
            )}
            {!willCreate && selected?.level && (
              <p className="mt-1 text-xs text-gray-500">Level: {selected.level}</p>
            )}
          </div>

          {/* New-student subject (only when creating one) */}
          {willCreate && (
            <div>
              <label className="block text-sm text-gray-600">Subject</label>
              <input
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder="e.g. Spanish, AP Physics, Competition Math"
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
          )}

          {/* Rate */}
          <div>
            <label className="block text-sm text-gray-600">Rate (per session)</label>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-gray-500">$</span>
              <input
                type="number"
                min={0}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="w-28 rounded border border-gray-300 px-2 py-1.5 text-sm font-mono"
              />
            </div>
          </div>

          {/* Date + time */}
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-sm text-gray-600">Date</label>
              <input
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">Time</label>
              <input
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600">Duration</label>
              <select
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
                className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
              >
                {durationOptions.map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Topic */}
          <div>
            <label className="block text-sm text-gray-600">What we&apos;ll cover</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
              placeholder="Optional"
              className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
            />
          </div>

          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={save}
            disabled={saving}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {saving ? "Saving..." : "Add session"}
          </button>
        </div>
      </div>
    </div>
  );
}
