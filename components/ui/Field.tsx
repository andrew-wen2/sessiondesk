import type { ComponentPropsWithRef, ReactNode } from "react";
import { ChevronDown } from "@/components/icons";

// Form controls. There used to be two competing input idioms — `px-2 py-1.5` in-app
// and `px-3 py-2` on the auth pages — so a field looked like a different control
// depending on which page you were on. One set of chrome now, everywhere.
//
// Focus rings come from the global :focus-visible rule in globals.css. Nothing here
// sets focus:outline-none.

const CONTROL =
  "w-full rounded-control border border-hairline-strong bg-surface text-ink " +
  "placeholder:text-faint transition-colors duration-150 hover:border-muted/60 " +
  "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted";

// Padding AND font size live here rather than being overridden per call site. Tailwind
// resolves conflicting utilities by their order in the generated stylesheet, not by the
// order they appear in the class attribute — so a caller passing `py-0` next to the base
// `py-2` silently loses and the control clips its own text. A size prop can't conflict.
//
// `text-sm` used to live in CONTROL. It moved here because `lg` needs `text-base` and
// two font-size utilities on one element is exactly the conflict this map exists to
// prevent — it would have happened to work (Tailwind emits `text-base` after `text-sm`),
// which is worse than failing, because the next size added might not.
export type ControlSize = "sm" | "md" | "lg";

const PAD: Record<ControlSize, string> = {
  sm: "h-8 px-2.5 py-0 text-sm",
  md: "px-3 py-2 text-sm",
  // 16px is not a taste call: iOS Safari zooms the viewport on focus for any input
  // below it, and h-11 clears the 44px touch target. Use this for anything a student
  // types into on a phone.
  lg: "h-11 px-3 py-2.5 text-base",
};

// ComponentPropsWithRef, not InputHTMLAttributes: React 19 passes `ref` as an ordinary
// prop to function components, and the add-session combobox focuses its field by ref.
export function Input({
  size = "md",
  className = "",
  ...rest
}: Omit<ComponentPropsWithRef<"input">, "size"> & { size?: ControlSize }) {
  return <input className={`${CONTROL} ${PAD[size]} ${className}`} {...rest} />;
}

export function Textarea({ className = "", ...rest }: ComponentPropsWithRef<"textarea">) {
  return (
    <textarea className={`${CONTROL} ${PAD.md} resize-y leading-relaxed ${className}`} {...rest} />
  );
}

// The native chevron differs per platform and never matches the rest of the app, so
// the control is appearance-none with our own glyph laid over it. The glyph is
// pointer-events-none — clicking where it sits must still open the select.
export function Select({
  size = "md",
  className = "",
  children,
  ...rest
}: Omit<ComponentPropsWithRef<"select">, "size"> & { size?: ControlSize }) {
  // Its own map rather than PAD, because the chevron needs right padding — but it
  // carries the font size for the same reason PAD does.
  const SELECT_PAD: Record<ControlSize, string> = {
    sm: "h-8 py-0 pl-2.5 pr-8 text-sm",
    md: "py-2 pl-3 pr-9 text-sm",
    lg: "h-11 py-2.5 pl-3 pr-9 text-base",
  };
  const pad = SELECT_PAD[size];
  return (
    <div className={`relative ${size === "sm" ? "inline-block" : ""}`}>
      <select className={`${CONTROL} ${pad} cursor-pointer appearance-none ${className}`} {...rest}>
        {children}
      </select>
      <ChevronDown
        className={`pointer-events-none absolute top-1/2 h-4 w-4 -translate-y-1/2 text-muted ${
          size === "sm" ? "right-2.5" : "right-3"
        }`}
      />
    </div>
  );
}

// Label above, helper below, error replacing the helper — never a placeholder doing
// the label's job, and never an error collected at the top of the form away from the
// field that caused it.
export function Field({
  label,
  htmlFor,
  hint,
  error,
  tone = "danger",
  className = "",
  children,
}: {
  label: ReactNode;
  htmlFor?: string;
  hint?: ReactNode;
  error?: string | null;
  /**
   * `danger` (default) for a real error. `warn` for a message that is NOT a failure —
   * a first wrong answer on a practice problem, say. `danger` is the destructive
   * colour in this app (it is what Delete uses), and painting a student's near-miss
   * in it tells them they broke something.
   */
  tone?: "danger" | "warn";
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        // aria-live because this message replaces the hint AFTER an interaction: a
        // screen-reader user gets no other signal that their answer was checked.
        <p role="status" aria-live="polite" className={`text-xs ${tone === "warn" ? "text-warn" : "text-danger"}`}>
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

// The eyebrow used above dense groups that aren't full cards.
export function Eyebrow({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <h2
      className={`text-[11px] font-semibold uppercase tracking-wider text-muted ${className}`}
    >
      {children}
    </h2>
  );
}
