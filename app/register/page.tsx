import { isGcalAppConfigured } from "@/lib/gcal-account";
import { RegisterForm } from "./RegisterForm";

export default function RegisterPage() {
  // Show the Google button only when the app's OAuth client is configured.
  return <RegisterForm googleEnabled={isGcalAppConfigured()} />;
}
