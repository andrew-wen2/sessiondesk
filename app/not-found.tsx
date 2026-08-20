import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";
import { AlertCircle } from "@/components/icons";

// A student or session id that doesn't exist (or isn't yours) reaches here via
// notFound(). Before this file that fell through to Next's stock 404, which is the
// one screen in the app that looked like a different product.
export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-4 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-sunken text-muted">
        <AlertCircle className="h-5 w-5" />
      </span>
      <div>
        <h1 className="text-xl font-semibold tracking-tight text-ink">Not found</h1>
        <p className="mt-1 text-sm text-muted">
          This page doesn&apos;t exist, or it belongs to another account.
        </p>
      </div>
      <Link href="/dashboard" className={buttonClass({ variant: "secondary" })}>
        Back to dashboard
      </Link>
    </div>
  );
}
