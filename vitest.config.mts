import { defineConfig } from "vitest/config";

// The recurrence suite asserts wall-clock survival across DST, so tests pin
// TZ themselves rather than depending on the machine's zone (see vitest.setup.ts).
export default defineConfig({
  resolve: {
    // Mirrors tsconfig.json's "@/*": ["./*"]. Every existing test imported its
    // subject via a relative path or a type-only "@/..." import (erased before
    // runtime), so this alias was never exercised until a test imported a VALUE
    // through "@/..." (lib/generation/solve.test.ts, via solve.ts's import of
    // lib/generation-prompt) — Vite/Vitest has no tsconfig-paths awareness by
    // default and threw "Cannot find package" without it.
    alias: { "@": import.meta.dirname },
  },
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
