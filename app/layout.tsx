import type { Metadata } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import Nav from "@/components/Nav";
import { isGcalConfigured } from "@/lib/gcal-token";

export const metadata: Metadata = {
  title: "Session Desk",
  description: "Single-tutor session manager",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <Nav gcalConnected={isGcalConfigured()} />
        <main className="mx-auto max-w-4xl px-4 py-8">{children}</main>
      </body>
    </html>
  );
}
