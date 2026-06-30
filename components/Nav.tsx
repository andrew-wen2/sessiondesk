"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const LINKS = [
  { href: "/", label: "Calendar" },
  { href: "/students", label: "Students" },
  { href: "/payments", label: "Payments" },
];

export default function Nav({
  gcalAvailable = false,
  gcalConnected = false,
}: {
  gcalAvailable?: boolean;
  gcalConnected?: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  async function disconnectGcal() {
    await fetch("/api/auth/google/disconnect", { method: "POST" });
    router.refresh();
  }

  // Auth pages render without the nav links (the user isn't signed in yet).
  if (pathname === "/login" || pathname === "/register") return null;

  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3 text-sm">
        <span className="font-semibold">Session Desk</span>
        <div className="flex gap-3">
          {LINKS.map((l) => {
            const active = l.href === "/" ? pathname === "/" : pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className={active ? "font-semibold text-blue-600" : "text-gray-600 hover:text-gray-900"}
              >
                {l.label}
              </Link>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {/* Calendar affordance only when the app's Google OAuth is configured. */}
          {gcalAvailable &&
            (gcalConnected ? (
              <span className="flex items-center gap-2 text-gray-500">
                Calendar connected
                <button
                  onClick={disconnectGcal}
                  className="text-gray-600 transition-colors duration-150 hover:text-gray-900"
                >
                  Disconnect
                </button>
              </span>
            ) : (
              <a
                href="/api/auth/google/connect"
                className="text-gray-600 transition-colors duration-150 hover:text-gray-900"
              >
                Connect Google Calendar
              </a>
            ))}
          <button
            onClick={logout}
            className="text-gray-600 transition-colors duration-150 hover:text-gray-900"
          >
            Sign out
          </button>
        </div>
      </div>
    </nav>
  );
}
