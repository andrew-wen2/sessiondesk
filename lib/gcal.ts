import { google } from "googleapis";
import { getRefreshToken } from "./gcal-token";

// One-way mirror: our DB → Google Calendar. Never the reverse. Every caller
// wraps these in try/catch so a Google failure never blocks a DB write.

export type SessionForGCal = {
  id: string;
  start: Date;
  durationMin: number;
  topic: string;
  student: { name: string };
};

const SCOPES = ["https://www.googleapis.com/auth/calendar.events"];

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const refresh = getRefreshToken();
  if (refresh) client.setCredentials({ refresh_token: refresh });
  return client;
}

// calendar.events scope can't create calendars, so we target a calendar the
// user designates (GOOGLE_TUTORING_CALENDAR_ID) or fall back to primary.
function getCalendarId(): string {
  return process.env.GOOGLE_TUTORING_CALENDAR_ID || "primary";
}

function calendar() {
  return google.calendar({ version: "v3", auth: getOAuthClient() });
}

function eventBody(session: SessionForGCal) {
  const end = new Date(session.start.getTime() + session.durationMin * 60 * 1000);
  return {
    summary: session.topic ? `${session.student.name} — ${session.topic}` : session.student.name,
    start: { dateTime: session.start.toISOString() },
    end: { dateTime: end.toISOString() },
    description: session.topic || "",
    extendedProperties: { private: { sessionId: session.id } },
  };
}

// --- OAuth flow helpers ---

export function getAuthUrl(): string {
  return getOAuthClient().generateAuthUrl({
    access_type: "offline",
    prompt: "consent", // forces refresh_token even on repeat authorization
    scope: SCOPES,
  });
}

export async function exchangeCode(code: string) {
  const { tokens } = await getOAuthClient().getToken(code);
  return tokens;
}

// --- Event CRUD ---

export async function createEvent(session: SessionForGCal): Promise<string> {
  const res = await calendar().events.insert({
    calendarId: getCalendarId(),
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
  googleEventId: string,
  session: SessionForGCal
): Promise<string> {
  try {
    const res = await calendar().events.patch({
      calendarId: getCalendarId(),
      eventId: googleEventId,
      requestBody: eventBody(session),
    });
    if (res.data.status === "cancelled") {
      // Patched a cleared event — it stays cancelled and invisible; recreate.
      return createEvent(session);
    }
    return googleEventId;
  } catch (e) {
    if (isEventGone(e)) return createEvent(session);
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

export async function deleteEvent(googleEventId: string): Promise<void> {
  await calendar().events.delete({
    calendarId: getCalendarId(),
    eventId: googleEventId,
  });
}
