import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit tests: pure logic in src/**/*.test.ts (node), components in
// src/**/*.test.tsx (each file opts into jsdom with `// @vitest-environment jsdom`).
export default defineConfig({
  plugins: [react()],
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
    css: false,
  },
});
