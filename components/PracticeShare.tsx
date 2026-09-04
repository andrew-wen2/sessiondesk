"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Button from "./ui/Button";
import Badge from "./ui/Badge";
import { Check, LinkIcon } from "./icons";
import type { PracticeState } from "./SessionDetail";

// The tutor's half of the practice link, as a strip INSIDE the Practice card — it is an
// attribute of the problem set, not a peer of it, so it doesn't become a fourth card
// competing with Generate.
//
// Six states derive from three fields; the old three-row table predated `sentAt` and the
// submission and could not tell "revoked" from "never sent", which erased the exact
// signal the feature exists to produce.
//
// Dates are ABSOLUTE, never "3d ago": this component server-renders and then hydrates,
// and a clock read on each side produces a different string. Anything derived from "now"
// (whether the student has stalled) is computed once on the server and passed in.

function shortDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export default function PracticeShare({
  sessionId,
  practice,
  hasProblems,
}: {
  sessionId: string;
  practice: PracticeState;
  hasProblems: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<"send" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [token, setToken] = useState(practice.shareToken);

  const { sentAtIso, expiresOnIso, expired, progress, stalled } = practice;
  const url = token ? `${typeof window === "undefined" ? "" : window.location.origin}/w/${token}` : null;

  async function send() {
    setBusy("send");
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/share`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Couldn't create the link.");
      setToken(data.token);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the link — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function revoke() {
    setBusy("revoke");
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${sessionId}/share`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error ?? "Couldn't turn off the link.");
      setToken(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't turn off the link — try again.");
    } finally {
      setBusy(null);
    }
  }

  async function copy() {
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      // No clipboard API (older Safari, insecure context). Selecting the text is the
      // fallback — the input below is readOnly, not disabled, precisely so it can be.
      setError("Couldn't copy — select the link and copy it manually.");
    }
  }

  if (!hasProblems) return null;

  const done = progress && progress.checked > 0;

  return (
    <div className="space-y-2 rounded-control bg-sunken/60 px-3 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        {done ? (
          // The number the tutor opened the page for, above the ten problem cards rather
          // than below them. `missed` is what turns a stat into a lesson plan.
          <p className="font-mono text-sm tabular-nums text-ink">
            {progress.checked} of {progress.total} · {progress.right} right
            {progress.missed.length > 0 && (
              <>
                {" "}
                · <span className="text-warn">missed {progress.missed.join(", ")}</span>
              </>
            )}
            {progress.secondTry > 0 && (
              <span className="text-muted"> ({progress.secondTry} on the second try)</span>
            )}
          </p>
        ) : sentAtIso ? (
          <p className="text-sm text-muted">
            Sent {shortDate(sentAtIso)}
            {expired ? " · expired" : token ? "" : " · turned off"} · nothing back yet
          </p>
        ) : (
          <p className="text-sm text-muted">Send this set for the student to work through.</p>
        )}

        {stalled && <Badge tone="warn">Stopped at {progress!.checked}</Badge>}

        <div className="ml-auto flex items-center gap-2">
          {token && !expired ? (
            <Button variant="ghost" size="sm" onClick={revoke} loading={busy === "revoke"}>
              Turn off link
            </Button>
          ) : (
            <Button
              variant="secondary"
              size="sm"
              onClick={send}
              loading={busy === "send"}
              // Re-sending after a revoke keeps the frozen set when work exists, so
              // stored indices stay anchored to the problems they were answered against.
            >
              <LinkIcon className="h-3.5 w-3.5" />
              {sentAtIso ? "Send again" : "Send to student"}
            </Button>
          )}
        </div>
      </div>

      {token && !expired && url && (
        <div className="flex items-center gap-2">
          <input
            readOnly
            value={url}
            onFocus={(e) => e.currentTarget.select()}
            className="h-8 w-full min-w-0 rounded-control border border-hairline bg-surface px-2.5 font-mono text-xs text-muted"
          />
          <Button variant="ghost" size="sm" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5 text-good" /> : null}
            {copied ? "Copied" : "Copy"}
          </Button>
        </div>
      )}

      {token && !expired && expiresOnIso && (
        <p className="text-xs text-faint">
          Works until{" "}
          {new Date(expiresOnIso).toLocaleDateString("en-US", { month: "short", day: "numeric" })}.
        </p>
      )}

      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
