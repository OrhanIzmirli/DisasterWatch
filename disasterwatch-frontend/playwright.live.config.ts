import { defineConfig, devices } from "@playwright/test";

/**
 * Read-only checks against the live site (e2e-live/): feed, filters, search,
 * sorting, map, drawer, news, static pages, phone view. Every request that is
 * not a GET is aborted (see e2e-live/guard.ts), so these tests cannot write.
 * The data is live, so they check consistency, never exact values.
 */
export default defineConfig({
  testDir: "e2e-live",
  fullyParallel: true,
  workers: 2,
  retries: 1,
  timeout: 120_000,
  expect: { timeout: 30_000 },
  reporter: "list",
  use: { baseURL: process.env.DW_LIVE_URL ?? "https://disasterwatch-frontend.onrender.com", locale: "en-GB" },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, hasTouch: true } },
  ],
});
