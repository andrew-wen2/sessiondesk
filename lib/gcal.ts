import { google } from "googleapis";
import { Prisma } from "@prisma/client";

// One-way mirror: our DB → Google Calendar. Never the reverse. Every caller
// wraps these in try/catch so a Google failure never blocks a DB write.
//
// This module is a pure Google Calendar adapter: it makes Calendar API calls and
// maps DB-shaped rows in, but never touches Prisma itself. Routes own all DB
// reads/writes and hand shaped data in (see SESSION_FOR_GCAL_SELECT / the
// remap return of propagateMeetLink). Calendar is per-user: every CRUD takes a
// GCalAccount (the user's refresh token + target calendar), loaded from the DB by
// the route via lib/gcal-account.ts. App OAuth client id/secret/redirect stay env.

// A single user's Google Calendar credentials. calendarId is the calendar to
// mirror into ("primary" when the user hasn't picked a dedicated one).
export type GCalAccount = { refreshToken: string; calendarId: string };

// Thrown by generateMeetLink when Google hasn't populated the conference link yet
// — a typed signal so callers can show a "try again" message without matching on
// free-text error strings.
export class MeetStillGeneratingError extends Error {
  constructor() {
    super("Meet link still generating — try again in a moment.");
    this.name = "MeetStillGeneratingError";
  }
}

export type SessionForGCal = {
  id: string;
  start: Date;
  durationMin: number;
  topic: string;
  paid: boolean;
  meetLink: string | null;
  student: { name: string; subject: string; level: string };
};

// The Prisma select every route uses to load a session for the GCal mirror, and
// the mapper that flattens such a row into SessionForGCal. Shared so the field
// set and the mapping stay in lock-step across all sync paths (create, patch,
// per-session retry, bulk sync-all).
export const SESSION_FOR_GCAL_SELECT = {
  id: true,
  start: true,
  durationMin: true,
  topic: true,
  paid: true,
  googleEventId: true,
  student: { select: { name: true, subject: true, level: true, meetLink: true } },
} satisfies Prisma.SessionSelect;

export function toSessionForGCal(row: {
  id: string;
  start: Date;
  durationMin: number;
  topic: string;
  paid: boolean;
  student: { name: string; subject: string; level: string; meetLink: string | null };
}): SessionForGCal {
  return {
    id: row.id,
    start: row.start,
    durationMin: row.durationMin,
    topic: row.topic,
    paid: row.paid,
    meetLink: row.student.meetLink,
    student: { name: row.student.name, subject: row.student.subject, level: row.student.level },
  };
}

// Google Calendar colorIds: 10 = Basil (green), 6 = Tangerine (orange).
// Paid sessions show green, unpaid show orange — matches the calendar chips.
const COLOR_PAID = "10";
const COLOR_UNPAID = "6";

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

// Identity scopes for "Sign in with Google" — just enough to read the verified
// email + stable account id from the id_token. No calendar access, no refresh
// token needed (we only consume the identity once, at sign-in).
const LOGIN_SCOPES = ["openid", "email", "profile"];

// App-level OAuth client (no user credentials) — used only for the OAuth flow
// (auth URL + code exchange). Client id/secret/redirect are app-wide env.
function getAppOAuthClient() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

// Calendar clients are cached per refresh token so sync loops don't rebuild the
// OAuth client + service on every event. Keyed by the user's refresh token, which
// is stable for that user; a Map keeps one entry per connected user.
const _calendars = new Map<string, ReturnType<typeof google.calendar>>();
function calendar(account: GCalAccount) {
  let cal = _calendars.get(account.refreshToken);
  if (!cal) {
    const client = getAppOAuthClient();
    client.setCredentials({ refresh_token: account.refreshToken });
    cal = google.calendar({ version: "v3", auth: client });
    _calendars.set(account.refreshToken, cal);
  }
  return cal;
}

function eventBody(session: SessionForGCal) {
  const end = new Date(session.start.getTime() + session.durationMin * 60 * 1000);
  // Append the Meet link to the description as a reliable baseline so it is
  // always visible on the event even if the conferenceData approach is rejected.
  const descParts = [
    session.topic ? `Topic: ${session.topic}` : null,
    session.student.subject ? `Subject: ${session.student.subject}` : null,
    session.student.level ? `Level: ${session.student.level}` : null,
    session.meetLink ? `Meet: ${session.meetLink}` : null,
  ].filter(Boolean);
  return {
    summary: session.student.name,
    start: { dateTime: session.start.toISOString() },
    end: { dateTime: end.toISOString() },
    description: descParts.join("\n\n"),
    colorId: session.paid ? COLOR_PAID : COLOR_UNPAID,
    extendedProperties: { private: { sessionId: session.id } },
  };
}

// --- OAuth flow helpers ---

export function getAuthUrl(): string {
  return getAppOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces refresh_token even on repeat authorization
    scope: SCOPES,
    state: "connect", // the shared callback branches on this (vs "signin")
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await getAppOAuthClient().getToken(code);
  return tokens;
}

// --- Sign-in-with-Google flow (identity only; shares the app OAuth client and
// the single registered redirect URI with the Calendar flow, distinguished by
// the `state` param the callback reads). ---

// `state` carries a per-request CSRF nonce (the caller sets a matching cookie and
// the callback verifies it). Format: "signin:<nonce>".
export function getLoginAuthUrl(state: string): string {
  return getAppOAuthClient().generateAuthUrl({
    scope: LOGIN_SCOPES,
    state,
    prompt: "select_account", // let the user pick which Google account to use
  });
}

// Exchanges the sign-in code for an id_token and returns the verified identity,
// or null if the token is missing / the email isn't verified. We verify the
// id_token's signature + audience rather than trusting the email blindly.
export async function verifyGoogleLogin(
  code: string
): Promise<{ email: string; googleId: string } | null> {
  const client = getAppOAuthClient();
  const { tokens } = await client.getToken(code);
  if (!tokens.id_token) return null;
  const ticket = await client.verifyIdToken({
    idToken: tokens.id_token,
    audience: process.env.GOOGLE_CLIENT_ID,
  });
  const payload = ticket.getPayload();
  if (!payload?.email || !payload.email_verified || !payload.sub) return null;
  return { email: payload.email.toLowerCase(), googleId: payload.sub };
}

// --- Event CRUD --- (each takes the acting user's GCalAccount)

export async function createEvent(account: GCalAccount, session: SessionForGCal): Promise<string> {
  const res = await calendar(account).events.insert({
    calendarId: account.calendarId,
    requestBody: eventBody(session),
  });
  const id = res.data.id;
  if (!id) throw new Error("Calendar did not return an event ID");
  return id;
}

// Returns the event id the caller should persist: the same id when the event
// was patched in place, or a brand-new id when the event was gone and had to be
// recreated. Recreate is necessary because a cleared Google Calendar leaves
// events in status "cancelled" rather than truly deleting them — a patch then
// returns HTTP 200 but silently writes to a dead event that never reappears
// (and a hard-deleted event 404s). In both cases we re-create so the mirror
// self-heals instead of pointing at a phantom id forever.
export async function updateEvent(
  account: GCalAccount,
  googleEventId: string,
  session: SessionForGCal
): Promise<string> {
  try {
    const res = await calendar(account).events.patch({
      calendarId: account.calendarId,
      eventId: googleEventId,
      requestBody: eventBody(session),
    });
    if (res.data.status === "cancelled") {
      // Patched a cleared event — it stays cancelled and invisible; recreate.
      return createEvent(account, session);
    }
    return googleEventId;
  } catch (e) {
    if (isEventGone(e)) return createEvent(account, session);
    throw e;
  }
}

// 404 (not found) / 410 (gone) from Google mean the event id no longer exists.
function isEventGone(e: unknown): boolean {
  const status =
    (e as { code?: unknown })?.code ??
    (e as { response?: { status?: unknown } })?.response?.status;
  return status === 404 || status === 410 || status === "404" || status === "410";
}

export async function deleteEvent(account: GCalAccount, googleEventId: string): Promise<void> {
  await calendar(account).events.delete({
    calendarId: account.calendarId,
    eventId: googleEventId,
  });
}

// --- Meet link helpers ---

// generateMeetLink: asks Google to attach a new Meet conference to an existing
// calendar event. Returns the hangout link or throws if Google hasn't populated
// it yet (the caller should surface a "try again" message — it usually resolves
// within a second on a retry).
export async function generateMeetLink(account: GCalAccount, googleEventId: string): Promise<string> {
  const res = await calendar(account).events.patch({
    calendarId: account.calendarId,
    eventId: googleEventId,
    conferenceDataVersion: 1,
    requestBody: {
      conferenceData: {
        createRequest: {
          requestId: `meet-${googleEventId}-${Date.now()}`,
          conferenceSolutionKey: { type: "hangoutsMeet" },
        },
      },
    },
  });

  // Google may return the link as hangoutLink or inside conferenceData entries.
  const link =
    res.data.hangoutLink ??
    res.data.conferenceData?.entryPoints?.find(
      (e) => e.entryPointType === "video"
    )?.uri;

  if (!link) {
    // Conference creation is still pending — caller should retry.
    throw new MeetStillGeneratingError();
  }
  return link;
}

// attachMeetLink: best-effort patch that writes a manual Meet URL into the event
// as structured conferenceData. A Google rejection (e.g. workspace restriction)
// is swallowed — the link already appears in the event description via eventBody.
export async function attachMeetLink(
  account: GCalAccount,
  googleEventId: string,
  meetLink: string
): Promise<void> {
  // Derive a stable conference id from the event id + a hash of the link so
  // repeated patches don't create duplicate conference entries.
  const conferenceId = `manual-${googleEventId}`;
  try {
    await calendar(account).events.patch({
      calendarId: account.calendarId,
      eventId: googleEventId,
      conferenceDataVersion: 1,
      requestBody: {
        conferenceData: {
          conferenceSolution: { key: { type: "hangoutsMeet" } },
          conferenceId,
          entryPoints: [
            {
              entryPointType: "video",
              uri: meetLink,
            },
          ],
        },
      },
    });
  } catch (e) {
    // Non-blocking: the link is already in the event description.
    console.error("GCal attachMeetLink failed (non-blocking):", e);
  }
}

// A session row loaded with SESSION_FOR_GCAL_SELECT (includes googleEventId).
type SessionRowForGCal = Prisma.SessionGetPayload<{ select: typeof SESSION_FOR_GCAL_SELECT }>;

// propagateMeetLink: mirrors a meetLink onto every passed synced GCal event. Run
// after a student's meetLink changes (via generate or manual edit). Sequential on
// purpose — small volume, rate-limit friendly. Per-event failures are swallowed;
// the link will show up on the next sync or retry. Pure: the caller loads the rows
// (filtered to googleEventId != null) and persists the returned event-id remaps —
// this module never touches Prisma.
export async function propagateMeetLink(
  account: GCalAccount,
  rows: SessionRowForGCal[],
  meetLink: string | null
): Promise<Array<{ id: string; newEventId: string }>> {
  const remaps: Array<{ id: string; newEventId: string }> = [];
  for (const row of rows) {
    if (!row.googleEventId) continue;
    const eventId = row.googleEventId;
    try {
      // Reuse the shared mapper, but override meetLink with the new value being
      // propagated (the caller's param is the source of truth for this run).
      const newId = await updateEvent(account, eventId, { ...toSessionForGCal(row), meetLink });
      // updateEvent recreates a deleted event and returns a fresh id — the caller
      // must persist these so the mirror stays linked.
      if (newId !== eventId) remaps.push({ id: row.id, newEventId: newId });
      if (meetLink) await attachMeetLink(account, newId, meetLink);
    } catch (e) {
      console.error(`GCal propagateMeetLink failed for session ${row.id} (non-blocking):`, e);
    }
  }
  return remaps;
}
