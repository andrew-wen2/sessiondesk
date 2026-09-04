import type { ButtonHTMLAttributes } from "react";

// The app's one button. Before this existed the same class string was retyped at
// ~20 call sites with three different paddings, which is why nothing looked aligned.
//
// `buttonClass` is exported separately because a good third of the app's "buttons"
// are <Link>s or <a>s (Join Meet, Export CSV, Continue with Google) — those take the
// class and stay anchors rather than becoming buttons with onClick navigation.

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger" | "dangerSolid";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-primary text-white shadow-sm hover:bg-primary-hover",
  secondary: "border border-hairline-strong bg-surface text-ink-soft shadow-sm hover:bg-sunken",
  ghost: "text-muted hover:bg-sunken hover:text-ink",
  danger: "text-danger hover:bg-danger-soft",
  dangerSolid: "bg-danger text-white shadow-sm hover:bg-danger/90",
};

// A size variant, not a `className="h-11"` at the call site: Tailwind resolves
// conflicting utilities by stylesheet order, so an h-11 passed alongside md's h-9
// loses and the button silently stays 36px.
const SIZE: Record<ButtonSize, string> = {
  sm: "h-8 gap-1.5 px-2.5 text-sm",
  md: "h-9 gap-2 px-3.5 text-sm",
  // 44px is the iOS touch-target floor. `md` is fine everywhere the tutor works on a
  // desktop; this is for the controls a student taps on a phone.
  lg: "h-11 gap-2 px-4 text-sm",
};

// Icon-only: square, so a lone glyph isn't stranded in a pill.
const ICON_SIZE: Record<ButtonSize, string> = {
  sm: "h-8 w-8 px-0",
  md: "h-9 w-9 px-0",
  lg: "h-11 w-11 px-0",
};

const BASE =
  "inline-flex shrink-0 cursor-pointer select-none items-center justify-center rounded-control font-medium " +
  "transition-[color,background-color,border-color,box-shadow] duration-150 " +
  "disabled:pointer-events-none disabled:opacity-55";

export function buttonClass({
  variant = "primary",
  size = "md",
  iconOnly = false,
  className = "",
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  className?: string;
} = {}) {
  return `${BASE} ${VARIANT[variant]} ${iconOnly ? ICON_SIZE[size] : SIZE[size]} ${className}`;
}

export default function Button({
  variant = "primary",
  size = "md",
  iconOnly = false,
  loading = false,
  className = "",
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  loading?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled || loading}
      className={buttonClass({ variant, size, iconOnly, className })}
      {...rest}
    >
      {loading && <Spinner />}
      {children}
    </button>
  );
}

// Inline, on the triggering button, never a full-page overlay — the loading rule the
// app has always specified but never actually had a spinner for.
export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="3" className="opacity-25" />
      <path
        d="M21 12a9 9 0 0 0-9-9"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
        className="opacity-90"
      />
    </svg>
  );
}
