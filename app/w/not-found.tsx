// The 404 a STUDENT sees, and it exists because the root app/not-found.tsx is written
// for the tutor: it says the page "belongs to another account" and offers a Back to
// dashboard link, which sits behind middleware and bounces a logged-out reader to a
// sign-in wall for an app they have no account on. A mistyped character in a link should
// not accuse a 15-year-old of trespassing.
//
// Deliberately gives nothing away: a revoked link, a wrong token and a link for a
// different student all land here and read identically.
export default function WorksheetNotFound() {
  return (
    <div className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-xl font-semibold tracking-tight text-ink">This link isn&apos;t working</h1>
      <p className="text-sm text-muted">
        It may have been turned off, or the address may be missing a character. Ask your tutor
        for a new one.
      </p>
    </div>
  );
}
