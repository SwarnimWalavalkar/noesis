import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "scripts/*.test.mjs"],
    testTimeout: 10_000,
  },
});
