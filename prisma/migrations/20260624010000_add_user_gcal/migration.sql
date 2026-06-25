-- Per-user Google Calendar link: the user's own refresh token + chosen calendar.
ALTER TABLE "User" ADD COLUMN "googleRefreshToken" TEXT;
ALTER TABLE "User" ADD COLUMN "googleCalendarId" TEXT;
