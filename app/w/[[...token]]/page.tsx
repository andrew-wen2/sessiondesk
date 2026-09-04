import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { prisma } from "@/lib/prisma";
import {
  MAX_ATTEMPTS,
  isWellFormedToken,
  linkExpiresAt,
  linkState,
  publicProblems,
  resolveAnswerFormat,
  type StoredResult,
} from "@/lib/worksheet";
import type { Problem } from "@/lib/types";
import { formatSessionDate } from "@/lib/format";
import WorksheetForm from "./WorksheetForm";

// A bearer-token page must never be statically rendered or edge-cached.
export const dynamic = "force-dynamic";

// The tutor texts a naked link; iMessage and WhatsApp fetch it and render a card. With
// no tags that card is blank on an unfamiliar domain, which is exactly the phishing read
// the page's own trust line exists to prevent. No student name, no problem text.
export const metadata: Metadata = {
  title: "Practice set",
  description: "Sent by your tutor.",
  robots: { index: false, follow: false },
  openGraph: { title: "Practice set", description: "Sent by your tutor." },
};

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas">
      <div className="mx-auto flex min-h-screen max-w-2xl flex-col px-4 py-10 sm:px-6">
        {children}
      </div>
    </div>
  );
}

export default async function WorksheetPage({
  params,
}: {
  params: Promise<{ token?: string[] }>;
}) {
  const { token: segments } = await params;

  // An OPTIONAL catch-all: `[...token]` would require at least one segment, so a bare
  // `/w` would fall through to the ROOT not-found — the one that tells a logged-out
  // minor the page belongs to another account. Reject the wrong shape rather than
  // joining, which would turn `/w/a/b` into a lookup of "a/b" and make the guard depend
  // on the token charset.
  if (!segments || segments.length !== 1 || !isWellFormedToken(segments[0])) notFound();
  const token = segments[0];

  const session = await prisma.session.findUnique({
    where: { shareToken: token },
    select: {
      start: true,
      status: true,
      shareToken: true,
      sentAt: true,
      sentSet: true,
      genMeta: true,
      user: { select: { displayName: true } },
      student: { select: { profile: true } },
      submission: { select: { results: true } },
    },
  });
  if (!session) notFound();

  const state = linkState(session, new Date());
  // Revoked and unknown read identically on purpose — a 404 that distinguishes them
  // tells a stranger holding a stale link that it was once real.
  if (state === "no-link" || state === "cancelled") notFound();

  // The tutor's own first name is not the student's data, and it is the single thing
  // that stops this page reading as phishing.
  const tutor = session.user.displayName?.trim() || "your tutor";

  if (state === "expired") {
    return (
      <Shell>
        <div className="my-auto space-y-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">This link has expired</h1>
          <p className="text-sm text-muted">
            It stopped working on {formatSessionDate(linkExpiresAt(session.sentAt!))}. Ask{" "}
            {tutor} for a new one.
          </p>
        </div>
      </Shell>
    );
  }

  const sentSet = (session.sentSet ?? []) as unknown as Problem[];
  const results = (session.submission?.results ?? []) as unknown as StoredResult[];

  if (!Array.isArray(sentSet) || sentSet.length === 0) {
    return (
      <Shell>
        <div className="my-auto space-y-2 text-center">
          <h1 className="text-xl font-semibold tracking-tight text-ink">Nothing here yet</h1>
          <p className="text-sm text-muted">This set isn&apos;t ready. Check back later.</p>
        </div>
      </Shell>
    );
  }

  // THE containment boundary. Everything the client ever sees goes through this: an
  // unresolved problem has no `answer` or `solution` key at all, so a leak is a compile
  // error rather than something review has to catch. Answers arrive only in a check
  // response, only for the index just committed.
  const items = publicProblems(sentSet, results, MAX_ATTEMPTS);
  const { format } = resolveAnswerFormat(session.genMeta, session.student.profile);

  return (
    <Shell>
      <WorksheetForm
        token={token}
        tutor={tutor}
        sessionDate={formatSessionDate(session.start)}
        expiresOn={formatSessionDate(linkExpiresAt(session.sentAt!))}
        items={items}
        answerFormat={format}
        maxAttempts={MAX_ATTEMPTS}
      />
    </Shell>
  );
}
