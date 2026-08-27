"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  CalendarDays,
  LayoutDashboard,
  LogOut,
  Menu,
  Settings as SettingsIcon,
  Users,
  X,
} from "@/components/icons";

// The app shell: a persistent sidebar on lg+, a top bar with a drawer below it.
//
// This is a client component, but `children` arrives as a prop from the server
// layout — so every page underneath still renders on the server. Nothing here queries
// the DB either: the nav used to pay for an isGcalConnected() lookup on every render
// of every page, and that stays gone (the account's email lives on /settings, which
// is the page that can afford to load it).

const LINKS = [
  { href: "/dashboard", label: "Dashboard", Icon: LayoutDashboard },
  { href: "/", label: "Calendar", Icon: CalendarDays },
  { href: "/students", label: "Students", Icon: Users },
] as const;

// Auth pages render bare — there is no session yet, so there is nothing to navigate.
const BARE_PATHS = ["/login", "/register"];

export default function AppShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Close the drawer on navigation. Without this it stays open over the page you just
  // asked for, because the route changes underneath a component that never unmounts.
  useEffect(() => {
    setDrawerOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!drawerOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }

  if (BARE_PATHS.includes(pathname)) return <>{children}</>;

  return (
    <div className="min-h-screen">
      {/* Desktop sidebar */}
      <aside className="fixed inset-y-0 left-0 z-40 hidden w-60 flex-col border-r border-hairline bg-surface lg:flex">
        <SidebarContent pathname={pathname} onLogout={logout} />
      </aside>

      {/* Mobile top bar */}
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-hairline bg-surface/90 px-4 backdrop-blur lg:hidden">
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          aria-label="Open navigation"
          className="-ml-1 flex h-10 w-10 cursor-pointer items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
        >
          <Menu className="h-5 w-5" />
        </button>
        <Wordmark />
      </header>

      {/* Mobile drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div
            className="absolute inset-0 bg-ink/40"
            onClick={() => setDrawerOpen(false)}
            aria-hidden
          />
          <div className="absolute inset-y-0 left-0 flex w-64 flex-col border-r border-hairline bg-surface shadow-pop">
            <button
              type="button"
              onClick={() => setDrawerOpen(false)}
              aria-label="Close navigation"
              className="absolute right-2 top-3 flex h-9 w-9 cursor-pointer items-center justify-center rounded-control text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
            >
              <X className="h-4 w-4" />
            </button>
            <SidebarContent pathname={pathname} onLogout={logout} />
          </div>
        </div>
      )}

      <div className="lg:pl-60">
        <main className="px-4 py-6 sm:px-6 sm:py-8 lg:px-10">{children}</main>
      </div>
    </div>
  );
}

function SidebarContent({
  pathname,
  onLogout,
}: {
  pathname: string;
  onLogout: () => void;
}) {
  return (
    <>
      <div className="flex h-14 shrink-0 items-center px-5">
        <Wordmark />
      </div>

      <nav className="flex-1 space-y-0.5 px-3 py-2">
        {LINKS.map(({ href, label, Icon }) => {
          // "/" is the calendar and would otherwise prefix-match every route.
          const active = href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? "page" : undefined}
              className={`flex items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors duration-150 ${
                active
                  ? "bg-primary-soft font-medium text-primary"
                  : "text-ink-soft hover:bg-sunken hover:text-ink"
              }`}
            >
              <Icon className="h-4 w-4 shrink-0" />
              {label}
            </Link>
          );
        })}
      </nav>

      {/* Account chrome, not a workspace surface — pinned away from the three links
          that are actually the job. */}
      <div className="space-y-0.5 border-t border-hairline px-3 py-3">
        <Link
          href="/settings"
          aria-current={pathname.startsWith("/settings") ? "page" : undefined}
          className={`flex items-center gap-3 rounded-control px-3 py-2 text-sm transition-colors duration-150 ${
            pathname.startsWith("/settings")
              ? "bg-primary-soft font-medium text-primary"
              : "text-muted hover:bg-sunken hover:text-ink"
          }`}
        >
          <SettingsIcon className="h-4 w-4 shrink-0" />
          Settings
        </Link>
        <button
          type="button"
          onClick={onLogout}
          className="flex w-full cursor-pointer items-center gap-3 rounded-control px-3 py-2 text-sm text-muted transition-colors duration-150 hover:bg-sunken hover:text-ink"
        >
          <LogOut className="h-4 w-4 shrink-0" />
          Sign out
        </button>
      </div>
    </>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2.5">
      <span
        className="flex h-7 w-7 items-center justify-center rounded-[9px] bg-primary text-[13px] font-bold text-white"
        aria-hidden
      >
        S
      </span>
      <span className="text-[15px] font-semibold tracking-tight text-ink">SessionDesk</span>
    </span>
  );
}
