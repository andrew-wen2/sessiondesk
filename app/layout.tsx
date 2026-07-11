import type { Metadata } from "next";
import "./globals.css";
import "katex/dist/katex.min.css";
import Nav from "@/components/Nav";
import { getCurrentUserId } from "@/lib/session";
import { isGcalAppConfigured, isGcalConnected } from "@/lib/gcal-account";

export const metadata: Metadata = {
  title: "Session Desk",
  description: "Tutoring session manager",
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // Per-user Calendar state for the nav. No user (login/register) → not connected;
  // the Nav hides its links on those routes anyway.
  const userId = await getCurrentUserId();
  const gcalConnected = userId ? await isGcalConnected(userId) : false;

  return (
    <html lang="en">
      <body className="bg-gray-50 text-gray-900 antialiased">
        <Nav gcalAvailable={isGcalAppConfigured()} gcalConnected={gcalConnected} />
        {/* Full-bleed shell: the calendar fills the width; reading pages re-constrain
            themselves with `mx-auto max-w-4xl` so their line-length stays comfortable. */}
        <main className="w-full px-4 py-8 sm:px-6 lg:px-8">{children}</main>
      </body>
    </html>
  );
}
