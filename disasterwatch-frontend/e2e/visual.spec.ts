/**
 * Visual regression: each page at 1440 px and 390 px against a reviewed
 * baseline. A failing test means the page looks different; if the change is
 * intended, update the baselines (see playwright.config.ts) and review the
 * new images in the pull request.
 */
import { expect, test } from "@playwright/test";
import { isPhone, open, openDashboard, openEvent, volatile } from "./pages";

test("dashboard", async ({ page }) => {
  await openDashboard(page, "map");
  await expect(page).toHaveScreenshot("dashboard.png", { fullPage: true, mask: volatile(page) });
});

test("dashboard feed and today's events", async ({ page }) => {
  await openDashboard(page, "feed");
  await expect(page).toHaveScreenshot("dashboard-feed.png", { fullPage: true, mask: volatile(page) });
});

test("event drawer: earthquake", async ({ page }) => {
  await openEvent(page, /Palekastro/);
  await expect(page.getByRole("dialog")).toHaveScreenshot("drawer-earthquake.png");
});

test("event drawer: wildfire rated by GDACS", async ({ page }) => {
  await openEvent(page, /Wildfire in Australia/);
  await expect(page.getByRole("dialog")).toHaveScreenshot("drawer-wildfire.png");
});

test("event drawer: storm", async ({ page }) => {
  await openEvent(page, /Tropical Cyclone Arnab/);
  await expect(page.getByRole("dialog")).toHaveScreenshot("drawer-storm.png");
});

test("news panel", async ({ page }) => {
  await openDashboard(page, isPhone(page) ? "feed" : "map");
  await page.getByRole("button", { name: "News", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Latest news" })).toContainText("Example coverage");
  await expect(page).toHaveScreenshot("news.png", { mask: volatile(page) });
});

for (const [name, path] of [
  ["alerts-signed-out", "/alerts"],
  ["sign-in", "/signin"],
  ["sign-up", "/signup"],
  ["privacy", "/privacy"],
  ["not-found", "/no-such-page"],
] as const) {
  test(name, async ({ page }) => {
    await open(page, path);
    await expect(page).toHaveScreenshot(`${name}.png`, { fullPage: true, mask: volatile(page) });
  });
}

test("public API page with its interactive reference", async ({ page }) => {
  await open(page, "/api");
  await expect(page.locator(".swagger-ui .opblock").first()).toBeVisible();
  // the "One event" example swaps in the newest event's id once it has loaded: wait for it, or the page height varies
  await expect(page.getByText("usgs:ex000001", { exact: false })).toBeVisible();
  // the main element, not a full-page shot: a full-page capture resizes the viewport to the page height, and the
  // page's 100vh minimum then grows with it, so successive captures never settle on one height
  await expect(page.locator("main.api-page")).toHaveScreenshot("api.png", { mask: volatile(page) });
});

test("map tooltip and its pointer", async ({ page }) => {
  test.skip(isPhone(page), "hover tooltips are a pointer-device feature");
  await openDashboard(page, "map");
  await page.locator(".map-cluster:visible").first().hover();
  const tooltip = page.locator(".leaflet-tooltip.dw-tooltip");
  await expect(tooltip).toBeVisible();
  // the tooltip plus the 12 px below it, where its pointer sits
  const box = (await tooltip.boundingBox())!;
  await expect(page).toHaveScreenshot("map-tooltip.png", {
    clip: { x: box.x - 8, y: box.y - 8, width: box.width + 16, height: box.height + 28 },
  });
});

test("event drawer: flood with GDACS impact figures", async ({ page }) => {
  await openEvent(page, /Flood in Indonesia/);
  await expect(page.getByRole("dialog")).toContainText("people evacuated");
  await expect(page.getByRole("dialog")).toHaveScreenshot("drawer-flood.png");
});

test("event drawer sections: GDACS impact and storm development", async ({ page }) => {
  await openEvent(page, /Flood in Indonesia/);
  const impact = page.locator(".edd-section").filter({ has: page.getByRole("heading", { name: "Impact" }) });
  await expect(impact).toContainText("houses damaged");
  await impact.scrollIntoViewIfNeeded();
  await expect(impact).toHaveScreenshot("drawer-section-impact.png");

  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: /Tropical Cyclone Arnab/ }).first().click();
  const development = page.locator(".edd-section").filter({ has: page.getByRole("heading", { name: "How it developed" }) });
  await development.scrollIntoViewIfNeeded();
  await expect(development.getByRole("img")).toBeVisible();
  await expect(development).toHaveScreenshot("drawer-section-development.png");
});

test("event drawer section: why these scores", async ({ page }) => {
  await openEvent(page, /Hasaki/);
  const scores = page.locator(".edd-section").filter({ has: page.getByRole("heading", { name: "Why these scores?" }) });
  await expect(scores.getByRole("table", { name: /Confidence 80/ })).toBeVisible();
  await scores.scrollIntoViewIfNeeded();
  await expect(scores).toHaveScreenshot("drawer-section-scores.png");
});
