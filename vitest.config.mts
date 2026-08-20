import { defineConfig } from "vitest/config";

// The recurrence suite asserts wall-clock survival across DST, so tests pin
// TZ themselves rather than depending on the machine's zone (see vitest.setup.ts).
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./vitest.setup.ts"],
  },
});
