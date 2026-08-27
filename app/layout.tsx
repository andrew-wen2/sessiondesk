import type { Metadata } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "katex/dist/katex.min.css";
import AppShell from "@/components/AppShell";

// Self-hosted by Next at build time — no external stylesheet request, no FOUT, and
// the app keeps working with no network at runtime. The variables are what
// tailwind.config.ts's fontFamily points at.
const sans = Inter({
  subsets: ["latin"],
  variable: "--font-sans",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "SessionDesk",
  description: "Tutoring session manager",
};

// Not async and issues no queries: the nav's Calendar connect/disconnect controls
// moved to /settings, which removed the per-render isGcalConnected() lookup that
// every page in the app was paying for. AppShell is a client component, but `children`
// is passed through as a prop, so the pages inside it still render on the server.
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body className="font-sans">
        <AppShell>{children}</AppShell>
      </body>
    </html>
  );
}
