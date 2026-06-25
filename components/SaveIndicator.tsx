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
  if (status === "saving") return <span className={`${className} text-gray-400`}>Saving…</span>;
  if (status === "saved") return <span className={`${className} text-gray-400`}>Saved</span>;
  return onRetry ? (
    <button onClick={onRetry} className={`${className} text-red-600 hover:underline`}>
      Save failed — retry
    </button>
  ) : (
    <span className={`${className} text-red-600`}>Save failed — edit and blur again to retry</span>
  );
}
