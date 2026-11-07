import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end write flows (e2e-stack/) against a running local stack:
 * sign-up, sign-in, alerts, notifications, e-mail switch, account deletion
 * and the admin console. They create real accounts, so they never run
 * against the live site: point DW_STACK_URL at a local Docker Compose stack
 * (default http://localhost:8080; see docs/operations.md, "End-to-end flows").
 */
const baseURL = process.env.DW_STACK_URL ?? "http://localhost:8080";
if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(baseURL)) {
  throw new Error(`e2e-stack writes accounts and must run against a local stack, not ${baseURL}`);
}

export default defineConfig({
  testDir: "e2e-stack",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: "list",
  use: { ...devices["Desktop Chrome"], baseURL, viewport: { width: 1440, height: 900 }, locale: "en-GB" },
});
