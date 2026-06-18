import { google } from "googleapis";
import { getRefreshToken } from "./gcal-token";

// One-way mirror: our DB → Google Calendar. Never the reverse. Every caller
// wraps these in try/catch so a Google failure never blocks a DB write.

export type SessionForGCal = {
  id: string;
  start: Date;
  durationMin: number;
  topic: string;
  student: { name: string; subject: string };
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
    summary: `${session.student.name} — ${session.student.subject}`,
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

export async function updateEvent(
  googleEventId: string,
  session: SessionForGCal
): Promise<void> {
  await calendar().events.patch({
    calendarId: getCalendarId(),
    eventId: googleEventId,
    requestBody: eventBody(session),
  });
}

export async function deleteEvent(googleEventId: string): Promise<void> {
  await calendar().events.delete({
    calendarId: getCalendarId(),
    eventId: googleEventId,
  });
}
