"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { StudentOption } from "@/lib/types";
import { expandLocal, MAX_OCCURRENCES, type Repeat } from "@/lib/recurrence";
import { formatSessionDate } from "@/lib/format";
import { toDateKey } from "@/lib/dates";
import { Field, Input, Select, Textarea } from "./ui/Field";
import Button from "./ui/Button";
import { AlertCircle, X } from "./icons";

const DURATIONS = [30, 45, 60, 90, 120];

// Eight weeks out — long enough to be worth repeating, short enough that nobody
// accidentally books a year. Built from local calendar components, like the
// expansion itself.
function defaultUntil(dateYMD: string): string {
  const [y, m, d] = dateYMD.split("-").map(Number);
  if (!y || !m || !d) return "";
  return toDateKey(new Date(y, m - 1, d + 7 * 8));
}

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
  const [date, setDate] = useState(dateISO);
  const [time, setTime] = useState(timeHHMM ?? "17:00");
  const [duration, setDuration] = useState(durationMin ?? 60);
  // A dragged length may not be one of the presets — offer it as an extra option.
  const durationOptions = DURATIONS.includes(duration) ? DURATIONS : [...DURATIONS, duration].sort((a, b) => a - b);
  const [topic, setTopic] = useState("");

  // Recurrence. The expansion runs HERE, in the browser, because only the browser
  // knows the tutor's timezone — stepping calendar days in the wrong zone shifts the
  // wall-clock hour across a DST boundary (see lib/recurrence.ts). The server
  // re-validates the resulting instants but can't re-derive them.
  const [repeat, setRepeat] = useState<Repeat>("none");
  const [until, setUntil] = useState("");
  const occurrences = useMemo(
    () => (repeat === "none" ? [] : expandLocal(date, time, repeat, until)),
    [repeat, date, time, until]
  );
  const capped = occurrences.length === MAX_OCCURRENCES;

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
    if (repeat !== "none" && occurrences.length === 0) {
      setError("Pick an “until” date on or after the session date.");
      return;
    }

    setSaving(true);
    try {
      let studentId = existing?.id ?? selected?.id;

      if (!studentId) {
        const res = await fetch("/api/students", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: trimmedName, rate: rateNum }),
        });
        if (!res.ok) {
          const { error } = await res.json().catch(() => ({ error: "" }));
          throw new Error(error || "Could not create student.");
        }
        studentId = (await res.json()).id;
      }

      // A repeat sends the whole expanded series; a one-off keeps the original
      // single-`start` shape.
      const schedule =
        repeat === "none"
          ? { start: new Date(`${date}T${time}`).toISOString() }
          : { starts: occurrences.map((d) => d.toISOString()) };

      const res = await fetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          studentId,
          ...schedule,
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
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4 backdrop-blur-[2px]"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-md overflow-y-auto rounded-card border border-hairline bg-surface shadow-pop"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-hairline px-5 py-3.5">
          <h2 className="text-base font-semibold text-ink">Add session</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="-mr-1 flex h-8 w-8 cursor-pointer items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-4 px-5 py-4">
          {/* Student combobox */}
          <div className="relative">
            <Field label="Student" htmlFor="add-student">
              <Input
                id="add-student"
                ref={nameRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setSelected(null);
                  setShowList(true);
                }}
                onFocus={() => setShowList(true)}
                placeholder="Search or type a new name"
              />
            </Field>
            {showList && matches.length > 0 && (
              <ul className="absolute z-10 mt-1 max-h-44 w-full overflow-auto rounded-control border border-hairline bg-surface py-1 shadow-pop">
                {matches.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      onClick={() => pick(s)}
                      className="flex w-full cursor-pointer items-center justify-between px-3 py-1.5 text-left text-sm text-ink-soft transition-colors duration-150 hover:bg-sunken"
                    >
                      <span>{s.name}</span>
                      <span className="font-mono text-muted">${s.rate}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {willCreate && (
              <p className="mt-1.5 text-xs text-muted">
                New student — created on save. Fill in their profile later in Students.
              </p>
            )}
            {!willCreate && selected?.profile && (
              <p className="mt-1.5 rounded-control bg-sunken px-2.5 py-1.5 text-xs text-muted">
                {selected.profile}
              </p>
            )}
          </div>

          {/* Rate */}
          <Field label="Rate (per session)" htmlFor="add-rate" className="max-w-[10rem]">
            <div className="relative">
              <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted">
                $
              </span>
              <Input
                id="add-rate"
                type="number"
                min={0}
                value={rate}
                onChange={(e) => setRate(e.target.value)}
                className="pl-7 font-mono"
              />
            </div>
          </Field>

          {/* Date + time */}
          <div className="flex flex-wrap gap-3">
            <Field label="Date" htmlFor="add-date" className="min-w-[9rem] flex-1">
              <Input
                id="add-date"
                type="date"
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Time" htmlFor="add-time" className="w-[9.5rem]">
              <Input
                id="add-time"
                type="time"
                value={time}
                onChange={(e) => setTime(e.target.value)}
                className="font-mono"
              />
            </Field>
            <Field label="Duration" htmlFor="add-duration" className="w-[7.5rem]">
              <Select
                id="add-duration"
                value={duration}
                onChange={(e) => setDuration(Number(e.target.value))}
              >
                {durationOptions.map((d) => (
                  <option key={d} value={d}>
                    {d} min
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          {/* Repeat */}
          <div className="flex flex-wrap gap-3">
            <Field label="Repeats" htmlFor="add-repeat" className="min-w-[9rem] flex-1">
              <Select
                id="add-repeat"
                value={repeat}
                onChange={(e) => {
                  const next = e.target.value as Repeat;
                  setRepeat(next);
                  // Seed a sensible end date the first time a repeat is chosen, so the
                  // preview says something useful instead of opening on an error.
                  if (next !== "none" && !until) setUntil(defaultUntil(date));
                }}
              >
                <option value="none">Does not repeat</option>
                <option value="weekly">Weekly</option>
                <option value="biweekly">Every 2 weeks</option>
              </Select>
            </Field>
            {repeat !== "none" && (
              <Field label="Until" htmlFor="add-until" className="w-[9rem]">
                <Input
                  id="add-until"
                  type="date"
                  value={until}
                  min={date}
                  onChange={(e) => setUntil(e.target.value)}
                  className="font-mono"
                />
              </Field>
            )}
          </div>
          {/* Say what will be created before the tutor commits — a repeat that turns
              out to be 40 sessions should be visible here, not a surprise afterwards. */}
          {repeat !== "none" && (
            <p
              className={`rounded-control px-3 py-2 text-xs ${
                occurrences.length === 0
                  ? "bg-danger-soft text-danger"
                  : "bg-primary-soft text-primary"
              }`}
            >
              {occurrences.length === 0 ? (
                <>Pick an &ldquo;until&rdquo; date on or after the session date.</>
              ) : (
                <>
                  Creates {occurrences.length} session{occurrences.length === 1 ? "" : "s"},{" "}
                  {formatSessionDate(occurrences[0])} –{" "}
                  {formatSessionDate(occurrences[occurrences.length - 1])}.
                  {capped && ` Capped at ${MAX_OCCURRENCES} — shorten the date range for fewer.`}
                </>
              )}
            </p>
          )}

          {/* Topic */}
          <Field
            label={repeat === "none" ? "What we'll cover" : "What we'll cover (this session only)"}
            htmlFor="add-topic"
          >
            <Textarea
              id="add-topic"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              rows={2}
              placeholder="Optional"
            />
          </Field>

          {error && (
            <p className="flex items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{error}</span>
            </p>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-hairline bg-sunken/40 px-5 py-3">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            {saving
              ? "Saving…"
              : occurrences.length > 1
                ? `Add ${occurrences.length} sessions`
                : "Add session"}
          </Button>
        </div>
      </div>
    </div>
  );
}
