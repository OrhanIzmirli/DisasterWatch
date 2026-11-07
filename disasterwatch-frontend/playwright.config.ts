import { defineConfig, devices } from "@playwright/test";

/**
 * Visual regression and accessibility tests (e2e/). They run against the
 * production build with every API call answered by e2e/fixtures.ts.
 *
 * Screenshots depend on font rendering, so the baselines are made in the same
 * Linux image CI uses (see "Visual tests" in docs/operations.md):
 *   docker run --rm -v "$PWD":/work -w /work/disasterwatch-frontend \
 *     mcr.microsoft.com/playwright:v1.56.1-noble \
 *     bash -lc "npm ci && npm run build && npx playwright test --update-snapshots"
 */
export default defineConfig({
  testDir: "e2e",
  snapshotPathTemplate: "{testDir}/__screenshots__/{projectName}/{arg}{ext}",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  expect: {
    toHaveScreenshot: {
      animations: "disabled",
      caret: "hide",
      // anti-aliasing noise only; a moved or restyled element changes far more pixels
      maxDiffPixelRatio: 0.002,
    },
  },
  use: {
    baseURL: "http://localhost:4173",
    reducedMotion: "reduce",
    colorScheme: "dark",
    locale: "en-GB",
    timezoneId: "UTC",
  },
  projects: [
    { name: "desktop-1440", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } } },
    { name: "phone-390", use: { ...devices["Desktop Chrome"], viewport: { width: 390, height: 844 }, isMobile: false, hasTouch: true } },
  ],
  webServer: {
    command: "npx vite preview --port 4173 --strictPort",
    url: "http://localhost:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
