"use client";

import { useState } from "react";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";
import { getProfile, PROFILE_OPTIONS } from "@/lib/subjects";

export type StudentDetailData = {
  id: string;
  name: string;
  subject: string;
  generatorProfile: string;
  level: string;
  rate: number;
  notes: string;
  meetLink: string | null;
};

type Field = "subject" | "generatorProfile" | "level" | "rate" | "notes";

export default function StudentDetail({
  student,
  gcalConfigured,
}: {
  student: StudentDetailData;
  gcalConfigured: boolean;
}) {
  const [subject, setSubject] = useState(student.subject);
  const [generatorProfile, setGeneratorProfile] = useState(student.generatorProfile);
  // Advanced control — collapsed by default so it doesn't add to the form's weight;
  // most tutors never change it (new students are all "General").
  const [showSource, setShowSource] = useState(false);
  const [level, setLevel] = useState(student.level);
  const [rate, setRate] = useState(String(student.rate));
  const [notes, setNotes] = useState(student.notes);
  const [saved, setSaved] = useState({
    subject: student.subject,
    generatorProfile: student.generatorProfile,
    level: student.level,
    rate: String(student.rate),
    notes: student.notes,
  });
  const [status, setStatus] = useState<SaveStatus>("idle");

  // The level field's helper text depends on the chosen generator.
  const profile = getProfile(generatorProfile);

  // Meet link state — separate from the shared status so the indicator doesn't
  // flicker when other fields save.
  const [meetLink, setMeetLink] = useState<string | null>(student.meetLink);
  const [meetDraft, setMeetDraft] = useState(student.meetLink ?? "");
  const [meetSaving, setMeetSaving] = useState(false);
  const [meetGenerating, setMeetGenerating] = useState(false);
  const [meetError, setMeetError] = useState<string | null>(null);

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

  async function saveMeetLink() {
    const trimmed = meetDraft.trim();
    if (!trimmed) {
      setMeetError("Enter a Meet link to save.");
      return;
    }
    if (!trimmed.startsWith("http")) {
      setMeetError("Meet link must start with http — check the URL.");
      return;
    }
    setMeetError(null);
    setMeetSaving(true);
    try {
      const res = await fetch(`/api/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetLink: trimmed }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Save failed.");
      }
      setMeetLink(trimmed);
    } catch (e) {
      setMeetError(e instanceof Error ? e.message : "Save failed — try again.");
    } finally {
      setMeetSaving(false);
    }
  }

  async function removeMeetLink() {
    setMeetError(null);
    setMeetSaving(true);
    try {
      const res = await fetch(`/api/students/${student.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ meetLink: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Remove failed.");
      }
      setMeetLink(null);
      setMeetDraft("");
    } catch (e) {
      setMeetError(e instanceof Error ? e.message : "Remove failed — try again.");
    } finally {
      setMeetSaving(false);
    }
  }

  // Generate a fresh Meet link via Google Calendar — works whether or not a link
  // already exists (replacing it). Requires the student to have a synced session.
  async function generateMeet() {
    setMeetError(null);
    setMeetGenerating(true);
    try {
      const res = await fetch(`/api/students/${student.id}/meet`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((data as { error?: string }).error || "Could not generate Meet link — try again.");
      }
      const link = (data as { meetLink?: unknown }).meetLink;
      setMeetLink(typeof link === "string" ? link : null);
      setMeetDraft("");
    } catch (e) {
      setMeetError(e instanceof Error ? e.message : "Could not generate Meet link — try again.");
    } finally {
      setMeetGenerating(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 text-xs">
        <SaveIndicator status={status} />
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Subject</label>
        <p className="text-xs text-gray-400">What you tutor this student in, e.g. &ldquo;Spanish&rdquo;, &ldquo;AP Physics&rdquo;, &ldquo;Competition Math&rdquo;.</p>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          onBlur={() => saveField("subject", subject)}
          placeholder="Subject"
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </div>

      <div>
        <div className="flex items-center gap-2">
          <label className="text-sm font-semibold text-gray-500">Problem source</label>
          {!showSource && (
            <button
              type="button"
              onClick={() => setShowSource(true)}
              className="text-xs text-blue-600 hover:underline"
            >
              Change
            </button>
          )}
        </div>
        {!showSource ? (
          <p className="text-sm text-gray-700">{profile.label}</p>
        ) : (
          <>
            <p className="text-xs text-gray-400">
              &ldquo;General&rdquo; works for any subject. &ldquo;Competition Math&rdquo; draws on a bank of real AMC / AIME / F=ma contest problems &mdash; only pick it for math-contest prep.
            </p>
            <select
              value={generatorProfile}
              onChange={(e) => {
                setGeneratorProfile(e.target.value);
                saveField("generatorProfile", e.target.value);
              }}
              className="mt-1 rounded border border-gray-300 px-2 py-1.5 text-sm"
            >
              {PROFILE_OPTIONS.map((p) => (
                <option key={p.key} value={p.key}>
                  {p.label}
                </option>
              ))}
            </select>
          </>
        )}
      </div>

      <div>
        <label className="block text-sm font-semibold text-gray-500">Level / goals</label>
        <p className="text-xs text-gray-400">{profile.levelHelp}</p>
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

      <div>
        <label className="block text-sm font-semibold text-gray-500">Meet link</label>
        <p className="text-xs text-gray-400">Used for every session with this student.</p>
        {meetLink ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <a
              href={meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline break-all"
            >
              {meetLink}
            </a>
            {gcalConfigured && (
              <button
                onClick={generateMeet}
                disabled={meetGenerating}
                className="rounded border border-gray-300 px-3 py-1.5 text-xs text-gray-700 hover:bg-gray-100 disabled:opacity-60"
              >
                {meetGenerating ? "Generating…" : "Generate new"}
              </button>
            )}
            <button
              onClick={removeMeetLink}
              disabled={meetSaving}
              className="text-xs text-red-600 hover:underline disabled:opacity-60"
            >
              {meetSaving ? "Removing…" : "Remove"}
            </button>
          </div>
        ) : (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <input
              type="url"
              value={meetDraft}
              onChange={(e) => {
                setMeetDraft(e.target.value);
                setMeetError(null);
              }}
              placeholder="https://meet.google.com/…"
              className="rounded border border-gray-300 px-2 py-1.5 text-sm w-64"
            />
            <button
              onClick={saveMeetLink}
              disabled={meetSaving}
              className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
            >
              {meetSaving ? "Saving…" : "Save"}
            </button>
            {gcalConfigured && (
              <button
                onClick={generateMeet}
                disabled={meetGenerating}
                className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100 disabled:opacity-60"
              >
                {meetGenerating ? "Generating…" : "Generate"}
              </button>
            )}
          </div>
        )}
        {meetError && <p className="mt-1 text-xs text-red-600">{meetError}</p>}
      </div>
    </div>
  );
}
