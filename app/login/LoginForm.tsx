"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { GoogleSignInButton } from "@/components/GoogleSignInButton";

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
    <div className="mx-auto max-w-md">
      <h1 className="mb-6 text-xl font-bold">Sign in</h1>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label htmlFor="email" className="mb-1 block text-sm text-gray-700">
            Email
          </label>
          <input
            id="email"
            type="email"
            autoComplete="username"
            autoFocus
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
          />
        </div>
        <div>
          <label htmlFor="password" className="mb-1 block text-sm text-gray-700">
            Password
          </label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="w-full rounded-lg border border-gray-200 bg-white px-3 py-2 text-base focus:border-blue-500 focus:outline-none"
          />
        </div>
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="submit"
          disabled={busy || !email || !password}
          className="rounded-lg bg-blue-600 px-4 py-2 text-sm text-white transition-colors duration-150 hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>
      {googleEnabled && (
        <>
          <div className="my-4 flex items-center gap-3 text-sm text-gray-500">
            <span className="h-px flex-1 bg-gray-200" />
            or
            <span className="h-px flex-1 bg-gray-200" />
          </div>
          <GoogleSignInButton label="Continue with Google" />
        </>
      )}
      <p className="mt-4 text-sm text-gray-500">
        No account?{" "}
        <Link href="/register" className="font-semibold text-blue-600">
          Create one
        </Link>
      </p>
    </div>
  );
}
