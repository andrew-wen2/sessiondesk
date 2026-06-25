-- Add Google identity for "Sign in with Google". Nullable + unique: linked to the
-- account whose email matches the Google account; null for password-only users.
ALTER TABLE "User" ADD COLUMN "googleId" TEXT;
CREATE UNIQUE INDEX "User_googleId_key" ON "User"("googleId");
