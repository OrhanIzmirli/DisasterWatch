import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.js"],
    // Schema push + safety checks for the test database, once per run
    globalSetup: ["tests/global-setup.js"],
    // Env setup + table cleanup, in every worker before each test file
    setupFiles: ["tests/setup.js"],
    // All test files share one database, so they must not run concurrently
    fileParallelism: false,
    // Remote test databases (Neon branch) are slower than localhost
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
