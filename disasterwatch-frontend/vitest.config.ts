import { defineConfig } from "vitest/config";

// Unit tests for pure frontend logic (no DOM): src/**/*.test.ts
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
  },
});
