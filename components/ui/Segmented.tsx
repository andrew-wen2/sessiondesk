"use client";

// The calendar's Day/Week/Month switcher, extracted so anything else needing a small
// exclusive choice gets the same control. The active thumb is a real surface with a
// shadow sitting on a sunken track, which is what makes the selection legible at this
// size without a border fighting the neighbouring controls.
export default function Segmented<T extends string>({
  options,
  value,
  onChange,
  className = "",
  ariaLabel,
}: {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  className?: string;
  ariaLabel?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center rounded-control bg-sunken p-0.5 ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(o.value)}
            className={`cursor-pointer rounded-[6px] px-3 py-1 text-sm font-medium transition-[color,background-color,box-shadow] duration-150 ${
              active ? "bg-surface text-ink shadow-sm" : "text-muted hover:text-ink"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
