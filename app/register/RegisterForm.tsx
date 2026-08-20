"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import AuthShell, { AuthError, Divider } from "@/components/AuthShell";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";

export function RegisterForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Could not create account — try again.");
        setBusy(false);
        return;
      }
      router.replace("/");
      router.refresh();
    } catch {
      setError("Could not create account — check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Create account" subtitle="Set up your tutoring desk.">
      <form onSubmit={onSubmit} className="space-y-4">
        <Field label="Email" htmlFor="email">
          <Input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password" htmlFor="password" hint="At least 8 characters.">
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <AuthError>{error}</AuthError>}
        <Button
          type="submit"
          loading={busy}
          disabled={!email || password.length < 8}
          className="w-full"
        >
          {busy ? "Creating…" : "Create account"}
        </Button>
      </form>
      {googleEnabled && (
        <>
          <Divider />
          <GoogleSignInButton label="Continue with Google" />
        </>
      )}
      <p className="mt-6 text-center text-sm text-muted">
        Already have an account?{" "}
        <Link
          href="/login"
          className="font-medium text-primary transition-colors duration-150 hover:text-primary-hover"
        >
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
