import { expect, type Page } from "@playwright/test";

/** Aborts every non-GET request, so a read-only test cannot change anything on the live site. */
export async function readOnly(page: Page) {
  const blocked: string[] = [];
  await page.route("**/*", (route) => {
    const req = route.request();
    if (req.method() !== "GET" && req.method() !== "HEAD" && req.method() !== "OPTIONS") {
      blocked.push(`${req.method()} ${req.url()}`);
      return route.abort();
    }
    return route.continue();
  });
  return blocked;
}

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600;

/** Dashboard with the live feed in; the free hosting may need a minute to wake. */
export async function liveDashboard(page: Page, view: "map" | "feed" = "feed") {
  await readOnly(page);
  await page.goto("/", { timeout: 120_000 });
  await expect(page.locator(".disaster-row").first()).toBeAttached({ timeout: 120_000 });
  if (isPhone(page)) await page.getByRole("button", { name: view === "feed" ? "Feed" : "Map", exact: true }).click();
}

/** Type tags of the feed rows on the current page. */
export const rowTypes = (page: Page) => page.locator(".disaster-row .disaster-type-tag").allTextContents();
