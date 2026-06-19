"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Calendar" },
  { href: "/students", label: "Students" },
  { href: "/books", label: "Books" },
  { href: "/payments", label: "Payments" },
];

export default function Nav({ gcalConnected = false }: { gcalConnected?: boolean }) {
  const pathname = usePathname();
  return (
    <nav className="border-b border-gray-200 bg-white">
      <div className="mx-auto flex max-w-4xl items-center gap-4 px-4 py-3 text-sm">
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
        <div className="ml-auto">
          {gcalConnected ? (
            <span className="text-gray-500">Calendar connected</span>
          ) : (
            <a
              href="/api/auth/google/connect"
              className="text-gray-600 transition-colors duration-150 hover:text-gray-900"
            >
              Connect Google Calendar
            </a>
          )}
        </div>
      </div>
    </nav>
  );
}
