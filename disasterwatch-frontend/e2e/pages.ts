import { expect, type Page } from "@playwright/test";
import { mockApi } from "./fixtures";

/** Varies between runs (measured client-side), so it is masked in screenshots. */
export const volatile = (page: Page) => [page.locator(".status-right")];

export async function open(page: Page, path: string) {
  await mockApi(page);
  await page.goto(path);
  await expect(page.locator(".status-right")).toContainText("News:");
  // pages are loaded lazily: wait for the page itself, not just the app shell ("Loading…")
  await expect(page.locator("main h1, main h2").first()).toBeVisible();
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600;

/** Dashboard with the feed loaded; on a phone the feed view is shown. */
export async function openDashboard(page: Page, view: "map" | "feed" = "feed") {
  await open(page, "/");
  await expect(page.locator(".disaster-row").first()).toBeAttached();
  if (isPhone(page)) {
    await page.getByRole("button", { name: view === "feed" ? "Feed" : "Map", exact: true }).click();
  }
  // markers are drawn once the lazy map chunk has loaded (desktop, or the phone map view)
  if (!isPhone(page) || view === "map") await expect(page.locator(".map-marker:visible, .map-cluster:visible").first()).toBeVisible();
}

/** Opens an event in the drawer from its feed row. */
export async function openEvent(page: Page, name: RegExp) {
  await openDashboard(page, "feed");
  await page.getByRole("button", { name }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}
