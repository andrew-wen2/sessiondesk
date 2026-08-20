import { Check } from "./icons";

// Shared autosave status indicator. Two error variants: a clickable retry button
// (pass onRetry — used where there's a debounced retry handler) or a static
// "edit and blur again to retry" hint (omit onRetry — used by onBlur-save forms).
export type SaveStatus = "idle" | "saving" | "saved" | "error";

export function SaveIndicator({
  status,
  onRetry,
  className = "text-xs",
}: {
  status: SaveStatus;
  onRetry?: () => void;
  className?: string;
}) {
  if (status === "idle") return null;
  if (status === "saving") return <span className={`${className} text-muted`}>Saving…</span>;
  if (status === "saved")
    return (
      <span className={`${className} inline-flex items-center gap-1 text-good`}>
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  return onRetry ? (
    <button
      onClick={onRetry}
      className={`${className} cursor-pointer font-medium text-danger hover:underline`}
    >
      Save failed — retry
    </button>
  ) : (
    <span className={`${className} font-medium text-danger`}>
      Save failed — edit and blur again to retry
    </span>
  );
}
