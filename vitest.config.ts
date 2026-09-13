import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "scripts/*.test.mjs"],
    setupFiles: ["packages/tui/test/support/synthetic-keyboard.ts"],
    // Bound file workers; unlimited CPU-count concurrency overloads nested CLI/PTY processes.
    maxWorkers: Math.min(8, availableParallelism()),
    // Only explicitly concurrent suites opt in; PTYs keep independent homes and process cleanup.
    maxConcurrency: 3,
    testTimeout: 10_000,
  },
});
