"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardBody, CardHeader } from "./ui/Card";
import { Field, Input } from "./ui/Field";
import Button, { buttonClass } from "./ui/Button";
import Badge from "./ui/Badge";
import { Check, CircleCheck } from "./icons";

// Account settings UI. Every prop here is already safe to expose — the server page
// derives `hasPassword`/`gcalConnected` from the secret columns so no hash or token
// crosses the boundary.
export default function SettingsForm({
  email,
  hasPassword,
  gcalAvailable,
  gcalConnected,
}: {
  email: string;
  hasPassword: boolean;
  gcalAvailable: boolean;
  gcalConnected: boolean;
}) {
  const router = useRouter();

  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const [disconnecting, setDisconnecting] = useState(false);

  async function savePassword(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    if (next.length < 8) {
      setError("Password must be at least 8 characters.");
      return;
    }
    setSaving(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // Only sent when there's an existing password to check against.
        body: JSON.stringify(hasPassword ? { currentPassword: current, newPassword: next } : { newPassword: next }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error((data as { error?: string }).error || "Could not save password.");
      }
      setCurrent("");
      setNext("");
      setSaved(true);
      // A Google-only account now has a password — re-read so the form switches from
      // "Set a password" to "Change password".
      if (!hasPassword) router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save password — try again.");
    } finally {
      setSaving(false);
    }
  }

  async function disconnectGcal() {
    setDisconnecting(true);
    await fetch("/api/auth/google/disconnect", { method: "POST" });
    router.refresh();
    setDisconnecting(false);
  }

  return (
    <div className="space-y-5">
      {/* Account */}
      <Card>
        <CardHeader title="Account" />
        <CardBody>
          <p className="text-xs text-muted">Signed in as</p>
          <p className="mt-0.5 font-mono text-sm text-ink">{email}</p>
        </CardBody>
      </Card>

      {/* Password */}
      <Card>
        <CardHeader
          title={hasPassword ? "Change password" : "Set a password"}
          description={
            hasPassword ? undefined : "Set a password so you can sign in without Google."
          }
        />
        <CardBody>
          <form onSubmit={savePassword} className="space-y-4">
            {hasPassword && (
              <Field label="Current password" htmlFor="current" className="max-w-sm">
                <Input
                  id="current"
                  type="password"
                  autoComplete="current-password"
                  value={current}
                  onChange={(e) => setCurrent(e.target.value)}
                />
              </Field>
            )}
            <Field
              label="New password"
              htmlFor="next"
              hint="At least 8 characters."
              className="max-w-sm"
            >
              <Input
                id="next"
                type="password"
                autoComplete="new-password"
                value={next}
                onChange={(e) => setNext(e.target.value)}
              />
            </Field>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="submit" loading={saving}>
                {saving ? "Saving…" : "Save password"}
              </Button>
              {saved && (
                <span className="inline-flex items-center gap-1 text-sm text-good">
                  <Check className="h-3.5 w-3.5" />
                  Password saved.
                </span>
              )}
              {error && <span className="text-sm text-danger">{error}</span>}
            </div>
          </form>
          <p className="mt-4 border-t border-hairline pt-3 text-xs text-muted">
            Changing your password does not sign out other devices.
          </p>
        </CardBody>
      </Card>

      {/* Google Calendar */}
      {gcalAvailable && (
        <Card>
          <CardHeader
            title="Google Calendar"
            description="Sessions are mirrored one way — this app is the source of truth. Events go to your primary calendar."
            action={
              gcalConnected ? (
                <Badge tone="good">
                  <CircleCheck className="h-3 w-3" />
                  Connected
                </Badge>
              ) : (
                <Badge tone="neutral">Not connected</Badge>
              )
            }
          />
          <CardBody>
            {gcalConnected ? (
              <Button variant="secondary" onClick={disconnectGcal} loading={disconnecting}>
                {disconnecting ? "Disconnecting…" : "Disconnect"}
              </Button>
            ) : (
              <a href="/api/auth/google/connect" className={buttonClass()}>
                Connect Google Calendar
              </a>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
