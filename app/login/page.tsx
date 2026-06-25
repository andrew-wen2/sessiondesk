import { Suspense } from "react";
import { isGcalAppConfigured } from "@/lib/gcal-account";
import { LoginForm } from "./LoginForm";

export default function LoginPage() {
  // Show the Google button only when the app's OAuth client is configured.
  const googleEnabled = isGcalAppConfigured();
  // useSearchParams (in LoginForm) needs a Suspense boundary in the App Router.
  return (
    <Suspense>
      <LoginForm googleEnabled={googleEnabled} />
    </Suspense>
  );
}
