"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";
import AuthShell, { AuthError, Divider } from "@/components/AuthShell";
import { Field, Input } from "@/components/ui/Field";
import Button from "@/components/ui/Button";

export function LoginForm({ googleEnabled }: { googleEnabled: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const from = params.get("from") || "/";
  // The Google callback redirects here with ?error=google on a failed sign-in.
  const googleError = params.get("error") === "google";

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState(googleError ? "Google sign-in failed — try again or use your password." : "");
  const [busy, setBusy] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data.error || "Sign in failed — try again.");
        setBusy(false);
        return;
      }
      // Avoid an open redirect: only honor same-app relative paths.
      const dest = from.startsWith("/") && !from.startsWith("//") ? from : "/";
      router.replace(dest);
      router.refresh();
    } catch {
      setError("Sign in failed — check your connection and try again.");
      setBusy(false);
    }
  }

  return (
    <AuthShell title="Sign in" subtitle="Welcome back.">
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
        <Field label="Password" htmlFor="password">
          <Input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        {error && <AuthError>{error}</AuthError>}
        <Button
          type="submit"
          loading={busy}
          disabled={!email || !password}
          className="w-full"
        >
          {busy ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      {googleEnabled && (
        <>
          <Divider />
          <GoogleSignInButton label="Continue with Google" />
        </>
      )}
      <p className="mt-6 text-center text-sm text-muted">
        No account?{" "}
        <Link
          href="/register"
          className="font-medium text-primary transition-colors duration-150 hover:text-primary-hover"
        >
          Create one
        </Link>
      </p>
    </AuthShell>
  );
}
