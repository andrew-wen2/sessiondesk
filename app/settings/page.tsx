import { prisma } from "@/lib/prisma";
import { requireUserId } from "@/lib/session";
import { isGcalAppConfigured } from "@/lib/gcal-account";
import GcalBanner from "@/components/GcalBanner";
import SettingsForm from "@/components/SettingsForm";
import PageHeader from "@/components/ui/PageHeader";

// Reads live DB data — render on demand.
export const dynamic = "force-dynamic";

// Account settings. Server shell: loads the user, derives BOOLEANS from the secret
// fields, and passes only those across the client boundary — the password hash and
// the Google refresh token must never reach the browser, not even as props.
export default async function SettingsPage() {
  const userId = await requireUserId();

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { email: true, passwordHash: true, googleRefreshToken: true },
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <GcalBanner />
      <PageHeader title="Settings" description="Your account and connected services." />
      <SettingsForm
        email={user.email}
        hasPassword={user.passwordHash !== ""}
        gcalAvailable={isGcalAppConfigured()}
        gcalConnected={Boolean(user.googleRefreshToken)}
      />
    </div>
  );
}
