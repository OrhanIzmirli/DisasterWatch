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
