"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pad, formatSessionDate } from "@/lib/format";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";
import ProblemSet, { type Problem } from "./ProblemSet";
import { downloadProblemsPdf } from "@/lib/download-problems";
import { startGeneration, useGeneration } from "@/lib/generation-store";

const DURATIONS = [30, 45, 60, 90, 120];

export type SessionDetailData = {
  id: string;
  start: string; // ISO
  durationMin: number;
  topic: string;
  paid: boolean;
  amount: number;
  problems: Problem[] | null;
  googleEventId: string | null;
  meetLink: string | null;
  student: {
    id: string;
    name: string;
    level: string;
  };
};

export default function SessionDetail({
  session,
  gcalConfigured = false,
}: {
  session: SessionDetailData;
  gcalConfigured?: boolean;
}) {
  const { id } = session;
  const router = useRouter();

  // Canonical schedule state (header reflects it after a save).
  const [startIso, setStartIso] = useState(session.start);
  const [durationMin, setDurationMin] = useState(session.durationMin);
  const [amount, setAmount] = useState(session.amount);

  // Schedule edit form.
  const [editing, setEditing] = useState(false);
  const [draftDate, setDraftDate] = useState("");
  const [draftTime, setDraftTime] = useState("");
  const [draftDuration, setDraftDuration] = useState(60);
  const [draftAmount, setDraftAmount] = useState("");
  const [savingSchedule, setSavingSchedule] = useState(false);
  const [scheduleError, setScheduleError] = useState<string | null>(null);

  // Delete.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const [eventId, setEventId] = useState(session.googleEventId);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  // Meet link — sourced from the student; read-only display on this page.
  // Generate/edit/remove lives on the student profile.
  const meetLink = session.meetLink;

  const [topic, setTopic] = useState(session.topic);
  const [topicStatus, setTopicStatus] = useState<SaveStatus>("idle");

  const [paid, setPaid] = useState(session.paid);
  const [paidError, setPaidError] = useState<string | null>(null);

  const [problems, setProblems] = useState<Problem[]>(session.problems ?? []);
  const [downloadError, setDownloadError] = useState<string | null>(null);

  // Generation lives in a module-level store keyed by session id, so it keeps
  // running (and its result is recovered) when you navigate away and return.
  const gen = useGeneration(id);
  const generating = gen.status === "generating";
  const genError = gen.status === "error" ? gen.error : null;

  // Adopt the latest generated set whenever the store produces a new result —
  // including one that finished while this component was unmounted.
  useEffect(() => {
    if (gen.problems) setProblems(gen.problems);
  }, [gen.problems]);

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function patch(body: Record<string, unknown>) {
    const res = await fetch(`/api/sessions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const { error } = await res.json().catch(() => ({ error: "" }));
      throw new Error(error || "Save failed.");
    }
    return res.json();
  }

  function scheduleSave(
    field: "topic",
    value: string,
    setStatus: (s: SaveStatus) => void
  ) {
    clearTimeout(timers.current[field]);
    timers.current[field] = setTimeout(async () => {
      setStatus("saving");
      try {
        await patch({ [field]: value });
        setStatus("saved");
        setTimeout(() => setStatus("idle"), 1500);
      } catch {
        setStatus("error");
      }
    }, 800);
  }

  async function togglePaid() {
    const nextPaid = !paid;
    setPaid(nextPaid); // optimistic
    setPaidError(null);
    try {
      await patch({ paid: nextPaid });
    } catch {
      setPaid(!nextPaid); // revert
      setPaidError("Could not update payment — try again.");
    }
  }

  async function retrySync() {
    setSyncing(true);
    setSyncError(null);
    try {
      const res = await fetch(`/api/sessions/${id}/sync`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Sync failed.");
      if (data.googleEventId) setEventId(data.googleEventId);
    } catch (e) {
      setSyncError(e instanceof Error ? e.message : "Sync failed — try again.");
    } finally {
      setSyncing(false);
    }
  }

  function generate() {
    // Fire-and-forget into the store; it owns the fetch and survives navigation.
    // The route persists problems server-side; the store delivers them back here.
    startGeneration({ studentId: session.student.id, sessionId: id, topic });
  }

  function openEdit() {
    const dt = new Date(startIso);
    setDraftDate(`${dt.getFullYear()}-${pad(dt.getMonth() + 1)}-${pad(dt.getDate())}`);
    setDraftTime(`${pad(dt.getHours())}:${pad(dt.getMinutes())}`);
    setDraftDuration(durationMin);
    setDraftAmount(String(amount));
    setScheduleError(null);
    setEditing(true);
  }

  async function saveSchedule() {
    setScheduleError(null);
    const start = new Date(`${draftDate}T${draftTime}`);
    if (Number.isNaN(start.getTime())) {
      setScheduleError("Enter a valid date and time.");
      return;
    }
    const amt = Number(draftAmount);
    if (!Number.isFinite(amt) || amt < 0) {
      setScheduleError("Rate must be a non-negative number.");
      return;
    }
    setSavingSchedule(true);
    try {
      const updated = await patch({
        start: start.toISOString(),
        durationMin: draftDuration,
        amount: amt,
      });
      setStartIso(updated.start);
      setDurationMin(updated.durationMin);
      setAmount(updated.amount);
      setEditing(false);
    } catch (e) {
      setScheduleError(e instanceof Error ? e.message : "Save failed — try again.");
    } finally {
      setSavingSchedule(false);
    }
  }

  async function deleteSession() {
    setDeleteError(null);
    setDeleting(true);
    try {
      const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Delete failed.");
      }
      router.push("/");
      router.refresh();
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed — try again.");
      setDeleting(false);
    }
  }

  const d = new Date(startIso);
  const datePart = formatSessionDate(d);
  const timePart = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-blue-600 hover:underline">
        ← Back to calendar
      </Link>

      {/* Header */}
      <div className="space-y-1">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-bold">{session.student.name}</h1>
        </div>
        <p className="flex items-center gap-2 text-sm text-gray-600">
          <span>
            {datePart} · {timePart} · {durationMin} min
          </span>
          {!editing && (
            <button onClick={openEdit} className="text-xs text-blue-600 hover:underline">
              Edit
            </button>
          )}
        </p>
        <div className="flex items-center gap-3">
          <span className="font-mono text-sm">${amount}</span>
          <button
            onClick={togglePaid}
            className={
              paid
                ? "rounded border border-transparent bg-green-100 px-2 py-1 text-sm font-medium text-green-700 hover:bg-green-200"
                : "rounded border border-orange-300 px-2 py-1 text-sm font-medium text-orange-600 hover:bg-orange-50"
            }
          >
            {paid ? "✓ Paid" : "Mark paid"}
          </button>
          {paidError && <span className="text-xs text-red-600">{paidError}</span>}
        </div>

        {editing && (
          <div className="mt-2 space-y-3 rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex flex-wrap items-end gap-3">
              <label className="text-xs text-gray-600">
                Date
                <input
                  type="date"
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-gray-600">
                Time
                <input
                  type="time"
                  value={draftTime}
                  onChange={(e) => setDraftTime(e.target.value)}
                  className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
                />
              </label>
              <label className="text-xs text-gray-600">
                Duration
                <select
                  value={draftDuration}
                  onChange={(e) => setDraftDuration(Number(e.target.value))}
                  className="mt-1 block rounded border border-gray-300 px-2 py-1 text-sm"
                >
                  {DURATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </label>
              <label className="text-xs text-gray-600">
                Rate
                <input
                  type="number"
                  min={0}
                  value={draftAmount}
                  onChange={(e) => setDraftAmount(e.target.value)}
                  className="mt-1 block w-24 rounded border border-gray-300 px-2 py-1 text-sm font-mono"
                />
              </label>
            </div>
            <div className="flex items-center gap-2">
              <button
                onClick={saveSchedule}
                disabled={savingSchedule}
                className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
              >
                {savingSchedule ? "Saving…" : "Save changes"}
              </button>
              <button
                onClick={() => setEditing(false)}
                className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
              >
                Cancel
              </button>
              {scheduleError && <span className="text-xs text-red-600">{scheduleError}</span>}
            </div>
          </div>
        )}
        {gcalConfigured && !eventId && (
          <div className="flex items-center gap-2 text-xs text-orange-600">
            <span>Not synced to Calendar</span>
            <button
              onClick={retrySync}
              disabled={syncing}
              className="text-blue-600 hover:underline disabled:opacity-60"
            >
              {syncing ? "Syncing…" : "Retry sync"}
            </button>
            {syncError && <span className="text-red-600">{syncError}</span>}
          </div>
        )}
      </div>

      {/* Meet link — read-only; source of truth is the student profile */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500">Meet link</h2>
        <div className="mt-1 space-y-1">
          {meetLink ? (
            <a
              href={meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline break-all"
            >
              {meetLink}
            </a>
          ) : (
            <p className="text-xs text-gray-400">No Meet link yet.</p>
          )}
          <p className="text-xs text-gray-400">
            <Link href={`/students/${session.student.id}`} className="text-blue-600 hover:underline">
              Generate, edit, or remove this link on the student&apos;s profile.
            </Link>
          </p>
        </div>
      </section>

      {/* Topic */}
      <section>
        <h2 className="text-sm font-semibold text-gray-500">
          What we&apos;re covering
          <SaveIndicator status={topicStatus} onRetry={() => scheduleSave("topic", topic, setTopicStatus)} className="ml-2 text-xs" />
        </h2>
        <textarea
          value={topic}
          onChange={(e) => {
            setTopic(e.target.value);
            scheduleSave("topic", e.target.value, setTopicStatus);
          }}
          rows={2}
          placeholder="What this session covers"
          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
      </section>

      {/* Practice problems */}
      <section className="space-y-3">
        <h2 className="text-sm font-semibold text-gray-500">Practice problems</h2>
        <div className="flex flex-wrap items-center gap-4">
          <button
            onClick={generate}
            disabled={generating}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-60"
          >
            {generating ? "Generating…" : "Generate problems"}
          </button>
          {problems.length > 0 && (
            <button
              onClick={() => {
                setDownloadError(null);
                const ok = downloadProblemsPdf(problems, {
                  startIso,
                  studentName: session.student.name,
                  topic,
                });
                if (!ok) setDownloadError("Couldn't open the print window — allow pop-ups and retry.");
              }}
              className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-100"
            >
              Download questions
            </button>
          )}
        </div>
        {genError && <p className="text-sm text-red-600">{genError}</p>}
        {downloadError && <p className="text-sm text-red-600">{downloadError}</p>}
        <ProblemSet problems={problems} />
      </section>

      {/* Delete */}
      <section className="border-t border-gray-100 pt-4">
        {!confirmingDelete ? (
          <button
            onClick={() => {
              setDeleteError(null);
              setConfirmingDelete(true);
            }}
            className="text-sm text-red-600 hover:underline"
          >
            Delete session
          </button>
        ) : (
          <div className="flex items-center gap-2">
            <span className="text-sm text-gray-700">Delete this session? This can&apos;t be undone.</span>
            <button
              onClick={deleteSession}
              disabled={deleting}
              className="rounded bg-red-600 px-3 py-1 text-sm text-white hover:bg-red-700 disabled:opacity-60"
            >
              {deleting ? "Deleting…" : "Delete"}
            </button>
            <button
              onClick={() => setConfirmingDelete(false)}
              className="rounded px-3 py-1 text-sm text-gray-600 hover:bg-gray-100"
            >
              Cancel
            </button>
          </div>
        )}
        {deleteError && <p className="mt-2 text-sm text-red-600">{deleteError}</p>}
      </section>
    </div>
  );
}
