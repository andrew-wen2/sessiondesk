"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { SaveIndicator, type SaveStatus } from "./SaveIndicator";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Field, Input, Textarea } from "./ui/Field";
import Button from "./ui/Button";
import { LinkIcon } from "./icons";

export type StudentDetailData = {
  id: string;
  name: string;
  profile: string;
  rate: number;
  notes: string;
  meetLink: string | null;
};

type Field = "profile" | "rate" | "notes";

export default function StudentDetail({
  student,
  gcalConfigured,
}: {
  student: StudentDetailData;
  gcalConfigured: boolean;
}) {
  const router = useRouter();
  const [profile, setProfile] = useState(student.profile);
  const [rate, setRate] = useState(String(student.rate));
  const [notes, setNotes] = useState(student.notes);
  const [saved, setSaved] = useState({
    profile: student.profile,
    rate: String(student.rate),
    notes: student.notes,
  });
  const [status, setStatus] = useState<SaveStatus>("idle");

  // Meet link state — separate from the shared status so the indicator doesn't
  // flicker when other fields save.
  const [meetLink, setMeetLink] = useState<string | null>(student.meetLink);
  const [meetDraft, setMeetDraft] = useState(student.meetLink ?? "");
  const [meetSaving, setMeetSaving] = useState(false);
  const [meetGenerating, setMeetGenerating] = useState(false);
  const [meetError, setMeetError] = useState<string | null>(null);

  // Every successful save calls router.refresh(). These edits go out through a plain
  // fetch, which Next knows nothing about, so the client Router Cache keeps serving the
  // payload it already has — and back/forward navigation is restored from that cache
  // regardless of staleTime. Without the refresh, going back to /students (or to the
  // calendar, whose chips carry the student name) replays pre-edit data until a hard
  // reload. refresh() invalidates the cache and re-renders the current route; local
  // draft state is untouched, since these useState initializers don't re-run.
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
      router.refresh();
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
      router.refresh();
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
      router.refresh();
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
      router.refresh();
    } catch (e) {
      setMeetError(e instanceof Error ? e.message : "Could not generate Meet link — try again.");
    } finally {
      setMeetGenerating(false);
    }
  }

  return (
    <Card>
      <CardHeader
        title="Profile"
        description="What the generator knows about this student."
        action={<SaveIndicator status={status} />}
      />
      <CardBody className="space-y-5">
        <Field
          label="Student profile"
          htmlFor="student-profile"
          hint={
            <>
              Subject, level, goals, and anything the generator should know. The more specific, the
              better the problems &mdash; e.g. &ldquo;AIME, problems 10&ndash;15, number
              theory&rdquo; or &ldquo;AP Biology, unit 3 genetics, shaky on meiosis&rdquo;.
            </>
          }
        >
          <Textarea
            id="student-profile"
            value={profile}
            onChange={(e) => setProfile(e.target.value)}
            onBlur={() => saveField("profile", profile)}
            rows={3}
          />
        </Field>

        <Field label="Rate (per session)" htmlFor="student-rate" className="max-w-[12rem]">
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 font-mono text-sm text-muted">
              $
            </span>
            <Input
              id="student-rate"
              type="number"
              min={0}
              value={rate}
              onChange={(e) => setRate(e.target.value)}
              onBlur={() => saveField("rate", rate)}
              className="pl-7 font-mono"
            />
          </div>
        </Field>

        <Field label="Notes" htmlFor="student-notes">
          <Textarea
            id="student-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            onBlur={() => saveField("notes", notes)}
            rows={3}
            placeholder="Anything not captured per-session"
          />
        </Field>

        <Field
          label="Meet link"
          hint="Used for every session with this student."
          error={meetError}
        >
          {meetLink ? (
            <div className="flex flex-wrap items-center gap-2 rounded-control border border-hairline bg-sunken/60 px-3 py-2">
              <a
                href={meetLink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex min-w-0 items-center gap-1.5 break-all text-sm text-primary transition-colors duration-150 hover:text-primary-hover"
              >
                <LinkIcon className="h-3.5 w-3.5 shrink-0" />
                {meetLink}
              </a>
              <span className="ml-auto flex items-center gap-2">
                {gcalConfigured && (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={generateMeet}
                    loading={meetGenerating}
                  >
                    {meetGenerating ? "Generating…" : "Generate new"}
                  </Button>
                )}
                <Button variant="danger" size="sm" onClick={removeMeetLink} loading={meetSaving}>
                  {meetSaving ? "Removing…" : "Remove"}
                </Button>
              </span>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="url"
                value={meetDraft}
                onChange={(e) => {
                  setMeetDraft(e.target.value);
                  setMeetError(null);
                }}
                placeholder="https://meet.google.com/…"
                className="w-64"
              />
              <Button onClick={saveMeetLink} loading={meetSaving}>
                {meetSaving ? "Saving…" : "Save"}
              </Button>
              {gcalConfigured && (
                <Button variant="secondary" onClick={generateMeet} loading={meetGenerating}>
                  {meetGenerating ? "Generating…" : "Generate"}
                </Button>
              )}
            </div>
          )}
        </Field>
      </CardBody>
    </Card>
  );
}
