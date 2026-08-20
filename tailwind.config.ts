import type { Config } from "tailwindcss";

// The tokens themselves live in app/globals.css; this file only gives them utility
// names. Add a colour in both places or not at all — a raw hex in a component is the
// thing this indirection exists to prevent.
const token = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        canvas: token("canvas"),
        surface: token("surface"),
        sunken: token("sunken"),
        hairline: { DEFAULT: token("hairline"), strong: token("hairline-strong") },
        ink: { DEFAULT: token("ink"), soft: token("ink-soft") },
        muted: token("muted"),
        faint: token("faint"),
        primary: {
          DEFAULT: token("primary"),
          hover: token("primary-hover"),
          soft: token("primary-soft"),
        },
        good: { DEFAULT: token("good"), soft: token("good-soft") },
        warn: { DEFAULT: token("warn"), soft: token("warn-soft") },
        danger: { DEFAULT: token("danger"), soft: token("danger-soft") },
      },
      // Preflight paints every element's border-color from this, so a bare `border`
      // is a hairline rather than Tailwind's stock gray-200.
      borderColor: { DEFAULT: token("hairline") },
      borderRadius: { control: "8px", card: "12px" },
      boxShadow: {
        card: "0 1px 2px rgb(15 23 42 / 0.04), 0 1px 3px rgb(15 23 42 / 0.06)",
        raise: "0 4px 12px -2px rgb(15 23 42 / 0.10), 0 2px 4px -2px rgb(15 23 42 / 0.06)",
        pop: "0 12px 32px -8px rgb(15 23 42 / 0.18), 0 4px 8px -4px rgb(15 23 42 / 0.10)",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "-apple-system", "sans-serif"],
        mono: ["var(--font-mono)", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
} satisfies Config;
