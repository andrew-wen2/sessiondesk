"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { pad, formatSessionDate } from "@/lib/format";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";
import ProblemSet, { type Problem } from "./ProblemSet";
import PracticeShare from "./PracticeShare";
import LessonView from "./LessonView";
import type { Lesson } from "@/lib/types";
import { downloadProblemsPdf, downloadLessonPdf, downloadStudentHtml } from "@/lib/download-problems";
import { downloadProblemsDocx, downloadLessonDocx } from "@/lib/download-docx";
import { startGeneration, useGeneration, startLessonGeneration, useLessonGeneration } from "@/lib/generation-store";
import {
  SESSION_STATUSES,
  STATUS_LABEL,
  effectiveStatus,
  type SessionStatus,
} from "@/lib/session-status";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Field, Input, Select, Textarea } from "./ui/Field";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import { AlertCircle, Check, ChevronLeft, Download, LinkIcon, Sparkles, Trash } from "./icons";

const DURATIONS = [30, 45, 60, 90, 120];

// The this-vs-future choice shown on a session that belongs to a recurring series.
// A radio pair rather than two buttons: it's a mode you set before acting, and it
// has to be readable at a glance before you press an irreversible Delete.
function ScopeChoice({
  name,
  value,
  onChange,
  thisLabel,
  futureLabel,
  hint,
}: {
  name: string;
  value: "this" | "future";
  onChange: (v: "this" | "future") => void;
  thisLabel: string;
  futureLabel: string;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5 text-sm">
      {(["this", "future"] as const).map((v) => (
        <label
          key={v}
          className={`flex cursor-pointer items-center gap-2 rounded-control border px-3 py-2 transition-colors duration-150 ${
            value === v
              ? "border-primary/40 bg-primary-soft text-primary"
              : "border-hairline text-ink-soft hover:bg-sunken"
          }`}
        >
          <input
            type="radio"
            name={name}
            value={v}
            checked={value === v}
            onChange={() => onChange(v)}
            className="accent-[rgb(var(--primary))]"
          />
          {v === "this" ? thisLabel : futureLabel}
        </label>
      ))}
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </div>
  );
}

export type SessionDetailData = {
  id: string;
  start: string; // ISO
  durationMin: number;
  topic: string;
  paid: boolean;
  amount: number;
  status: SessionStatus;
  seriesId: string | null;
  laterInSeries: number; // sessions after this one in the same series; 0 when standalone
  problems: Problem[] | null;
  lesson: Lesson | null;
  googleEventId: string | null;
  meetLink: string | null;
  student: {
    id: string;
    name: string;
  };
  // Student practice link. Computed server-side (lib/worksheet.ts imports node:crypto,
  // so it must never reach a client bundle) and handed down as plain data.
  practice: PracticeState;
};

export type PracticeState = {
  shareToken: string | null;
  sentAtIso: string | null;
  expiresOnIso: string | null;
  expired: boolean;
  hasSubmission: boolean;
  /** Derived from "now" on the SERVER only — this component hydrates, so it must not read a clock. */
  stalled: boolean;
  progress: { total: number; checked: number; right: number; missed: number[]; secondTry: number } | null;
};

export default function SessionDetail({
  session,
  backHref = "/",
  gcalConfigured = false,
}: {
  session: SessionDetailData;
  // Where "Back to calendar" returns to — the exact view/date the tutor came from
  // when they arrived via the calendar's preview popover, so exiting a session
  // doesn't bounce them back to today's month/week. Defaults to a bare `/` for
  // every other entry point (dashboard, student payments), which have no "previous
  // calendar state" to return to anyway.
  backHref?: string;
  gcalConfigured?: boolean;
}) {
  const { id } = session;
  const router = useRouter();

  // Canonical schedule state (header reflects it after a save).
  const [startIso, setStartIso] = useState(session.start);
  const [durationMin, setDurationMin] = useState(session.durationMin);
  const [amount, setAmount] = useState(session.amount);

  // Series scope. Only meaningful when this session has later siblings; the controls
  // are hidden otherwise so a standalone session looks exactly as it did before.
  // Schedule edits and deletes each carry their own scope — changing one shouldn't
  // silently arm the other.
  const inSeries = session.seriesId !== null && session.laterInSeries > 0;
  const [scheduleScope, setScheduleScope] = useState<"this" | "future">("this");
  const [deleteScope, setDeleteScope] = useState<"this" | "future">("this");

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

  // Re-derive from the prop on every router.refresh(): a useState initializer
  // doesn't re-run when this instance is reused with a new session, which is
  // exactly what left the "Not synced" badge stuck after un-cancelling.
  useEffect(() => setEventId(session.googleEventId), [session.googleEventId]);

  // Meet link — sourced from the student; read-only display on this page.
  // Generate/edit/remove lives on the student profile.
  const meetLink = session.meetLink;

  const [topic, setTopic] = useState(session.topic);
  const [topicStatus, setTopicStatus] = useState<SaveStatus>("idle");

  const [paid, setPaid] = useState(session.paid);
  const [paidError, setPaidError] = useState<string | null>(null);

  const [status, setStatus] = useState<SessionStatus>(session.status);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaving, setStatusSaving] = useState(false);

  // "Now" is read after mount, never during render: this component server-renders
  // and then hydrates, so a clock read during render would mismatch for a session
  // that started in between. Until the effect runs, derivedStatus === status.
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => setNow(Date.now()), []);
  const derivedStatus = now === null ? status : effectiveStatus(status, startIso, now);

  const [problems, setProblems] = useState<Problem[]>(session.problems ?? []);
  const [downloadError, setDownloadError] = useState<string | null>(null);
  const [lessonDownloadError, setLessonDownloadError] = useState<string | null>(null);
  const [lesson, setLesson] = useState<Lesson | null>(session.lesson);

  // Generation lives in a module-level store keyed by session id, so it keeps
  // running (and its result is recovered) when you navigate away and return.
  // A live link or any submitted work locks regeneration — see the Regenerate button.
  const practiceLocked = Boolean(session.practice.shareToken || session.practice.hasSubmission);

  const gen = useGeneration(id);
  const generating = gen.status === "generating";
  const genError = gen.status === "error" ? gen.error : null;

  const lessonGen = useLessonGeneration(id);
  const generatingLesson = lessonGen.status === "generating";
  const lessonError = lessonGen.status === "error" ? lessonGen.error : null;

  // Adopt the latest generated set whenever the store produces a new result —
  // including one that finished while this component was unmounted.
  useEffect(() => {
    if (gen.problems) setProblems(gen.problems);
  }, [gen.problems]);

  useEffect(() => {
    if (lessonGen.lesson) setLesson(lessonGen.lesson);
  }, [lessonGen.lesson]);

  const timers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});

  async function patch(body: Record<string, unknown>, scope: "this" | "future" = "this") {
    const res = await fetch(`/api/sessions/${id}?scope=${scope}`, {
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

  // Status changes carry a Calendar side effect at the cancelled boundary: the route
  // deletes the mirrored event when cancelling and recreates it when un-cancelling.
  // Mirror that here so the "Not synced" affordance doesn't lie — and refresh on
  // un-cancel, since the new event id is assigned after the response flushes.
  async function changeStatus(next: SessionStatus) {
    const prev = status;
    if (next === prev) return;
    setStatus(next); // optimistic
    setStatusError(null);
    setStatusSaving(true);
    try {
      await patch({ status: next });
      if (next === "cancelled") setEventId(null);
      else if (prev === "cancelled") router.refresh();
    } catch {
      setStatus(prev); // revert
      setStatusError("Could not update status — try again.");
    } finally {
      setStatusSaving(false);
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

  function generateLessonNow() {
    startLessonGeneration({ studentId: session.student.id, sessionId: id, topic });
  }

  // Downloadable lesson files. PDF opens a print window (needs pop-ups); .docx builds
  // a Blob and saves directly. Each file is a student worksheet followed by a separate
  // tutor answer key. Monospace-vs-prose answer styling is detected per item there.
  const POPUP_ERR = "Couldn't open the print window — allow pop-ups and retry.";
  const DOCX_ERR = "Couldn't build the Word file — try again.";
  const HTML_ERR = "Couldn't build the practice file — try again.";
  const fileOpts = () => ({
    startIso,
    studentName: session.student.name,
    topic,
  });

  function problemsPdf() {
    setDownloadError(null);
    if (!downloadProblemsPdf(problems, fileOpts())) setDownloadError(POPUP_ERR);
  }
  async function problemsDocx() {
    setDownloadError(null);
    if (!(await downloadProblemsDocx(problems, fileOpts()))) setDownloadError(DOCX_ERR);
  }
  // The one export that is safe to hand a student: answers and solutions sit behind a
  // per-problem toggle instead of on the next page.
  function problemsStudent() {
    setDownloadError(null);
    if (!downloadStudentHtml(problems, fileOpts())) setDownloadError(HTML_ERR);
  }
  function lessonPdf() {
    if (!lesson) return;
    setLessonDownloadError(null);
    if (!downloadLessonPdf(lesson, fileOpts())) setLessonDownloadError(POPUP_ERR);
  }
  async function lessonDocx() {
    if (!lesson) return;
    setLessonDownloadError(null);
    if (!(await downloadLessonDocx(lesson, fileOpts()))) setLessonDownloadError(DOCX_ERR);
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
      const updated = await patch(
        {
          start: start.toISOString(),
          durationMin: draftDuration,
          amount: amt,
        },
        scheduleScope
      );
      setStartIso(updated.start);
      setDurationMin(updated.durationMin);
      setAmount(updated.amount);
      setEditing(false);
      // The later occurrences moved on the server; re-read so the calendar and any
      // series count on this page reflect it.
      if (scheduleScope === "future") router.refresh();
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
      const res = await fetch(`/api/sessions/${id}?scope=${deleteScope}`, { method: "DELETE" });
      if (!res.ok) {
        const { error } = await res.json().catch(() => ({ error: "" }));
        throw new Error(error || "Delete failed.");
      }
      router.push(backHref);
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
      <Link
        href={backHref}
        className="inline-flex items-center gap-1 text-sm text-muted transition-colors duration-150 hover:text-ink"
      >
        <ChevronLeft className="h-3.5 w-3.5" />
        Back to calendar
      </Link>

      {/* Header */}
      <Card className="space-y-3 px-5 py-4">
        <div className="flex flex-wrap items-start gap-3">
          <span
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-sm font-semibold text-primary"
            aria-hidden
          >
            {session.student.name.trim().charAt(0).toUpperCase() || "?"}
          </span>
          <div className="min-w-0 flex-1">
            <h1 className="text-xl font-semibold tracking-tight text-ink">
              {session.student.name}
            </h1>
            <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
              <span className="font-mono">
                {datePart} · {timePart} · {durationMin} min
              </span>
              {!editing && (
                <button
                  onClick={openEdit}
                  className="cursor-pointer text-xs font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
                >
                  Edit
                </button>
              )}
            </p>
            {inSeries && (
              <p className="mt-1 text-xs text-muted">
                Repeats — {session.laterInSeries} later session
                {session.laterInSeries === 1 ? "" : "s"} in this series.
              </p>
            )}
          </div>
          <span className="font-mono text-lg font-semibold text-ink">${amount}</span>
        </div>

        <div className="flex flex-wrap items-center gap-3 border-t border-hairline pt-3">
          {/* A cancelled session isn't owed, so offering "Mark paid" on one would be
              nonsense. Every other status keeps it — a no-show is still billable. */}
          {status !== "cancelled" && (
            <Button
              size="sm"
              variant="secondary"
              onClick={togglePaid}
              className={
                paid
                  ? "border-good/30 bg-good-soft text-good hover:bg-good/15"
                  : "border-warn/40 text-warn hover:bg-warn-soft"
              }
            >
              {paid ? <Check className="h-3.5 w-3.5" /> : null}
              {paid ? "Paid" : "Mark paid"}
            </Button>
          )}
          {paidError && <span className="text-xs text-danger">{paidError}</span>}

          <label className="flex items-center gap-2 text-xs text-muted">
            Status
            <Select
              value={status}
              onChange={(e) => changeStatus(e.target.value as SessionStatus)}
              disabled={statusSaving}
              size="sm"
              className="w-auto"
            >
              {SESSION_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </label>
          {/* A past session nobody touched already reads as completed everywhere else;
              say so here rather than nagging the tutor to mark each one. */}
          {status === "scheduled" && derivedStatus === "completed" && (
            <span className="text-xs text-muted">Counts as completed — it&apos;s in the past.</span>
          )}
          {statusError && <span className="text-xs text-danger">{statusError}</span>}
        </div>

        {status === "cancelled" && (
          <p className="rounded-control bg-sunken px-3 py-2 text-xs text-muted">
            Cancelled — not counted as owed, and removed from Google Calendar.
          </p>
        )}

        {editing && (
          <div className="space-y-3 rounded-control border border-hairline bg-sunken/50 p-3">
            <div className="flex flex-wrap gap-3">
              <Field label="Date" htmlFor="edit-date" className="w-[9.5rem]">
                <Input
                  id="edit-date"
                  type="date"
                  value={draftDate}
                  onChange={(e) => setDraftDate(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Time" htmlFor="edit-time" className="w-[9.5rem]">
                <Input
                  id="edit-time"
                  type="time"
                  value={draftTime}
                  onChange={(e) => setDraftTime(e.target.value)}
                  className="font-mono"
                />
              </Field>
              <Field label="Duration" htmlFor="edit-duration" className="w-[7.5rem]">
                <Select
                  id="edit-duration"
                  value={draftDuration}
                  onChange={(e) => setDraftDuration(Number(e.target.value))}
                >
                  {DURATIONS.map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Rate" htmlFor="edit-rate" className="w-[6.5rem]">
                <Input
                  id="edit-rate"
                  type="number"
                  min={0}
                  value={draftAmount}
                  onChange={(e) => setDraftAmount(e.target.value)}
                  className="font-mono"
                />
              </Field>
            </div>
            {inSeries && (
              <ScopeChoice
                name="schedule-scope"
                value={scheduleScope}
                onChange={setScheduleScope}
                thisLabel="This session only"
                futureLabel={`This and the ${session.laterInSeries} later session${
                  session.laterInSeries === 1 ? "" : "s"
                }`}
                hint="Date, time, duration and rate carry across. The topic never does."
              />
            )}
            <div className="flex items-center gap-2">
              <Button size="sm" onClick={saveSchedule} loading={savingSchedule}>
                {savingSchedule ? "Saving…" : "Save changes"}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
              {scheduleError && <span className="text-xs text-danger">{scheduleError}</span>}
            </div>
          </div>
        )}
        {/* A cancelled session is *meant* to have no event, so a null id is the
            correct state here — not a sync failure worth flagging. */}
        {gcalConfigured && !eventId && status !== "cancelled" && (
          <div className="flex items-center gap-2 text-xs">
            <Badge tone="warn">
              <AlertCircle className="h-3 w-3" />
              Not synced to Calendar
            </Badge>
            <button
              onClick={retrySync}
              disabled={syncing}
              className="cursor-pointer font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline disabled:opacity-60"
            >
              {syncing ? "Syncing…" : "Retry sync"}
            </button>
            {syncError && <span className="text-danger">{syncError}</span>}
          </div>
        )}
      </Card>

      {/* Meet link — read-only; source of truth is the student profile */}
      <Card>
        <CardHeader title="Meet link" />
        <CardBody className="space-y-1.5">
          {meetLink ? (
            <a
              href={meetLink}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 break-all text-sm text-primary transition-colors duration-150 hover:text-primary-hover"
            >
              <LinkIcon className="h-3.5 w-3.5 shrink-0" />
              {meetLink}
            </a>
          ) : (
            <p className="text-sm text-muted">No Meet link yet.</p>
          )}
          <p className="text-xs text-muted">
            <Link
              href={`/students/${session.student.id}`}
              className="text-primary underline-offset-2 transition-colors duration-150 hover:underline"
            >
              Generate, edit, or remove this link on the student&apos;s profile.
            </Link>
          </p>
        </CardBody>
      </Card>

      {/* Topic */}
      <Card>
        <CardHeader
          title="What we're covering"
          action={
            <SaveIndicator
              status={topicStatus}
              onRetry={() => scheduleSave("topic", topic, setTopicStatus)}
              className="text-xs"
            />
          }
        />
        <CardBody>
          <Textarea
            value={topic}
            onChange={(e) => {
              setTopic(e.target.value);
              scheduleSave("topic", e.target.value, setTopicStatus);
            }}
            rows={2}
            placeholder="What this session covers"
          />
        </CardBody>
      </Card>

      {/* Lesson */}
      <Card>
        <CardHeader
          title="Lesson"
          action={
            <>
              {lesson && <DownloadGroup onPdf={lessonPdf} onDocx={lessonDocx} />}
              <Button size="sm" onClick={generateLessonNow} loading={generatingLesson}>
                {!generatingLesson && <Sparkles className="h-3.5 w-3.5" />}
                {generatingLesson ? "Generating…" : lesson ? "Regenerate" : "Generate lesson"}
              </Button>
            </>
          }
        />
        <CardBody className="space-y-3">
          {lessonError && <ErrorLine>{lessonError}</ErrorLine>}
          {lessonDownloadError && <ErrorLine>{lessonDownloadError}</ErrorLine>}
          {lesson ? (
            <LessonView lesson={lesson} />
          ) : (
            !lessonError && (
              <p className="text-sm text-muted">
                No lesson yet — generate one calibrated to this student&apos;s profile.
              </p>
            )
          )}
        </CardBody>
      </Card>

      {/* Practice */}
      <Card>
        <CardHeader
          title="Practice problems"
          action={
            <>
              {problems.length > 0 && (
                <DownloadGroup onPdf={problemsPdf} onDocx={problemsDocx} onStudent={problemsStudent} />
              )}
              <Button
                size="sm"
                onClick={generate}
                loading={generating}
                // Blocked once a link is live OR any work exists. results[].index points
                // into the frozen sentSet, and countForTier is deterministic — a
                // replacement set has the SAME length, so nothing would error; the
                // student's answers would just silently describe different problems.
                // Turning the link off is not enough on its own once they have started.
                disabled={practiceLocked}
                title={
                  practiceLocked
                    ? "Turn off the link first — regenerating would re-anchor the student's answers to different problems."
                    : undefined
                }
              >
                {!generating && <Sparkles className="h-3.5 w-3.5" />}
                {generating
                  ? "Generating…"
                  : problems.length > 0
                    ? "Regenerate"
                    : "Generate problems"}
              </Button>
            </>
          }
        />
        <CardBody className="space-y-3">
          {genError && <ErrorLine>{genError}</ErrorLine>}
          {downloadError && <ErrorLine>{downloadError}</ErrorLine>}
          <PracticeShare
            sessionId={id}
            practice={session.practice}
            hasProblems={problems.length > 0}
          />
          {problems.length > 0 ? (
            <ProblemSet problems={problems} />
          ) : (
            !genError && (
              <p className="text-sm text-muted">
                No problems yet — generate a set calibrated to this student&apos;s profile.
              </p>
            )
          )}
        </CardBody>
      </Card>

      {/* Delete */}
      <section className="border-t border-hairline pt-5">
        {!confirmingDelete ? (
          <Button
            variant="danger"
            size="sm"
            onClick={() => {
              setDeleteError(null);
              setConfirmingDelete(true);
            }}
          >
            <Trash className="h-3.5 w-3.5" />
            Delete session
          </Button>
        ) : (
          <div className="space-y-3 rounded-control border border-danger/25 bg-danger-soft p-3">
            {inSeries && (
              <ScopeChoice
                name="delete-scope"
                value={deleteScope}
                onChange={setDeleteScope}
                thisLabel="Delete this session"
                futureLabel={`Delete this and the ${session.laterInSeries} later session${
                  session.laterInSeries === 1 ? "" : "s"
                }`}
              />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-sm text-danger">
                {deleteScope === "future"
                  ? `Delete ${session.laterInSeries + 1} sessions? This can't be undone.`
                  : "Delete this session? This can't be undone."}
              </span>
              <Button
                variant="dangerSolid"
                size="sm"
                onClick={deleteSession}
                loading={deleting}
                className="ml-auto"
              >
                {deleting ? "Deleting…" : "Delete"}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirmingDelete(false)}>
                Cancel
              </Button>
            </div>
          </div>
        )}
        {deleteError && <p className="mt-2 text-sm text-danger">{deleteError}</p>}
      </section>
    </div>
  );
}

// Both generated artefacts offer the same two formats. One control, so PDF and Word
// read as two halves of "download" rather than two more buttons competing with
// Generate — which is the action that matters on this page.
function DownloadGroup({
  onPdf,
  onDocx,
  onStudent,
}: {
  onPdf: () => void;
  onDocx: () => void;
  // Problems only. A lesson has no answers to withhold, so there is nothing for a
  // student copy to do differently.
  onStudent?: () => void;
}) {
  return (
    <span className="inline-flex h-8 items-center gap-1.5 rounded-control border border-hairline bg-sunken px-2.5 text-sm">
      <Download className="h-3.5 w-3.5 text-muted" />
      <button
        onClick={onPdf}
        className="cursor-pointer font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
      >
        PDF
      </button>
      <span className="text-hairline-strong" aria-hidden>
        ·
      </span>
      <button
        onClick={onDocx}
        className="cursor-pointer font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
      >
        Word
      </button>
      {onStudent && (
        <>
          <span className="text-hairline-strong" aria-hidden>
            ·
          </span>
          <button
            onClick={onStudent}
            title="Answers and solutions hidden behind a per-problem toggle"
            className="cursor-pointer font-medium text-primary underline-offset-2 transition-colors duration-150 hover:underline"
          >
            Student copy
          </button>
        </>
      )}
    </span>
  );
}

function ErrorLine({ children }: { children: React.ReactNode }) {
  return (
    <p className="flex items-start gap-2 rounded-control border border-danger/25 bg-danger-soft px-3 py-2 text-sm text-danger">
      <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}
