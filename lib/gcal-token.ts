// Single-user refresh-token storage. Option A from gcal-agent.md: the token
// lives in the GOOGLE_REFRESH_TOKEN env var (logged once during OAuth, then
// pasted into the environment). No DB table needed for one user.

export function getRefreshToken(): string | undefined {
  return process.env.GOOGLE_REFRESH_TOKEN || undefined;
}

// True only when the full OAuth set is present, so callers can skip sync
// attempts (and "not synced" warnings) when Calendar isn't wired up at all.
export function isGcalConfigured(): boolean {
  return Boolean(
    process.env.GOOGLE_CLIENT_ID &&
      process.env.GOOGLE_CLIENT_SECRET &&
      process.env.GOOGLE_REFRESH_TOKEN
  );
}
