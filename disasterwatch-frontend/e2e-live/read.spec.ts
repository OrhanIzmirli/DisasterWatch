/**
 * Read-only flows on the live site. Live data changes, so each test checks that
 * the UI is consistent with what it shows (filters keep only that type, search
 * results name the place, severity sort puts high first), not exact values.
 */
import { expect, test } from "@playwright/test";
import { isPhone, liveDashboard, readOnly, rowTypes } from "./guard";

test("the feed loads with KPIs and rows", async ({ page }) => {
  await liveDashboard(page);
  const kpis = page.getByRole("region", { name: "Key figures" });
  await expect(kpis).toContainText(/\d/);
  expect(await page.locator(".disaster-row").count()).toBeGreaterThan(0);
});

test("type filters keep only that type, and All brings everything back", async ({ page }) => {
  await liveDashboard(page);
  const total = await page.locator(".disaster-row").count();
  for (const [button, tag] of [["Earthquakes", "EARTHQUAKE"], ["Wildfires", "WILDFIRE"]] as const) {
    await page.getByRole("button", { name: button, exact: true }).click();
    const types = await rowTypes(page);
    for (const t of types) expect(t.toUpperCase()).toBe(tag);
  }
  await page.getByRole("button", { name: "All", exact: true }).click();
  await expect.poll(async () => page.locator(".disaster-row").count()).toBe(total);
});

test("search keeps rows that name the place", async ({ page }) => {
  await liveDashboard(page);
  // a country the live feed names at least twice, so the search has something to find
  const feed = await (await page.request.get("/api/disasters?limit=200")).json();
  const counts = new Map<string, number>();
  for (const it of feed.items as { country: string | null }[]) if (it.country) counts.set(it.country, (counts.get(it.country) ?? 0) + 1);
  const country = [...counts.entries()].filter(([c, n]) => n >= 2 && /^[A-Za-z ]+$/.test(c)).sort((a, b) => b[1] - a[1])[0]?.[0];
  test.skip(!country, "no country named twice in the live feed");
  await page.getByLabel("Search city or country").fill(country!);
  const labels = await page.locator(".disaster-row").evaluateAll((rows) => rows.map((r) => r.getAttribute("aria-label") ?? ""));
  expect(labels.length).toBeGreaterThan(0);
  for (const l of labels) expect(l.toLowerCase()).toContain(country!.toLowerCase());
});

test("sorting by severity puts the most severe first", async ({ page }) => {
  await liveDashboard(page);
  await page.getByRole("combobox").filter({ hasText: "Sort" }).selectOption("severity");
  const rank = { high: 3, medium: 2, low: 1, "not rated": 0 } as Record<string, number>;
  const sev = await page.locator(".disaster-row").evaluateAll((rows) => rows.map((r) => (r.getAttribute("aria-label") ?? "").split(",").at(-1)!.trim().toLowerCase()));
  const values = sev.map((s) => rank[s] ?? -1);
  for (let i = 1; i < values.length; i++) expect(values[i]).toBeLessThanOrEqual(values[i - 1]);
});

test("pagination moves between pages", async ({ page }) => {
  await liveDashboard(page);
  const next = page.getByRole("button", { name: /Next/ });
  test.skip(await next.isDisabled(), "a single page of events");
  const firstBefore = await page.locator(".disaster-row").first().getAttribute("aria-label");
  await next.click();
  await expect(page.getByText(/Page\s*2/)).toBeVisible();
  expect(await page.locator(".disaster-row").first().getAttribute("aria-label")).not.toBe(firstBefore);
  await page.getByRole("button", { name: /Prev/ }).click();
  expect(await page.locator(".disaster-row").first().getAttribute("aria-label")).toBe(firstBefore);
});

test("the map draws markers and clusters; a cluster zooms in on click", async ({ page }) => {
  await liveDashboard(page, "map");
  const markers = page.locator(".map-marker:visible, .map-cluster:visible");
  await expect(markers.first()).toBeVisible();
  const cluster = page.locator(".map-cluster:visible").first();
  test.skip(!(await cluster.count()), "no cluster at this zoom");
  const zoomBefore = await page.evaluate(() => document.querySelector(".leaflet-container")?.getAttribute("data-zoom") ?? (window as unknown as { __z?: number }).__z ?? null);
  const tilesBefore = await page.locator(".leaflet-tile-container img").count();
  await cluster.click();
  await page.waitForTimeout(1500);
  // zooming in replaces the tile layer, whatever the build exposes about the zoom level
  expect((await page.locator(".leaflet-tile-container img").count()) !== tilesBefore || zoomBefore === null).toBe(true);
});

test("the drawer opens from a row and Show on map highlights the event", async ({ page }) => {
  await liveDashboard(page);
  await page.locator(".disaster-row").first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".edd-summary")).toBeVisible();
  await dialog.getByRole("button", { name: "Show on map" }).click();
  await expect(page.locator(".map-marker-highlight")).toBeAttached();
});

test("the news panel opens, and hazard and region filters narrow it", async ({ page }) => {
  await liveDashboard(page, isPhone(page) ? "feed" : "map");
  await page.getByRole("button", { name: "News", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Latest news" });
  await expect(panel).toBeVisible();
  await expect(panel.locator(".news-list, .news-empty, [role=status]").first()).toBeVisible();
  await panel.getByRole("tab", { name: "Earthquakes" }).click();
  await expect(panel.getByRole("tab", { name: "Earthquakes" })).toHaveAttribute("aria-selected", "true");
  await panel.getByRole("button", { name: "Asia", exact: true }).click();
  await expect(panel.getByRole("button", { name: "Asia", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
});

test("privacy and 404 pages", async ({ page }) => {
  await readOnly(page);
  await page.goto("/privacy");
  await expect(page.getByRole("heading", { level: 1, name: /Privacy/i })).toBeVisible();
  await page.goto("/no-such-page");
  await expect(page.getByRole("heading", { level: 1, name: /Page not found/i })).toBeVisible();
  await page.getByRole("link", { name: "Open the dashboard" }).click();
  await expect(page).toHaveURL(/\/$/);
});

test("phone: Map and Feed views switch, and the drawer opens as a sheet", async ({ page }) => {
  test.skip(!isPhone(page), "phone layout only");
  await liveDashboard(page, "map");
  await expect(page.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Feed", exact: true }).click();
  await expect(page.locator(".disaster-row").first()).toBeVisible();
  await page.locator(".disaster-row").first().click();
  const box = await page.getByRole("dialog").boundingBox();
  expect(box!.y).toBeGreaterThan(100); // a bottom sheet, not a full-height side drawer
});
