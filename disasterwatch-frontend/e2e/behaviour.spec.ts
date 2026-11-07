/**
 * The map interactions reported broken: they must move the map to the event,
 * also when the marker caps leave that event out of the map at first.
 */
import { expect, test } from "@playwright/test";
import { isPhone, openDashboard, openEvent } from "./pages";

test("'Show on map' draws and highlights an event the map left out", async ({ page }) => {
  // M 4.5 near Ierapetra is the weakest quake of the fixture feed
  await openEvent(page, /Ierapetra/);
  await page.getByRole("button", { name: "Show on map" }).click();
  if (isPhone(page)) await expect(page.getByRole("button", { name: "Map", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".map-marker-highlight")).toBeVisible();
});

test("a Today's events card opens the event and highlights it on the map", async ({ page }) => {
  await openDashboard(page, "feed");
  await page.getByRole("button", { name: /Open on the map/ }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.locator(".map-marker-highlight")).toBeAttached();
});

test("'Show on map' in the news panel opens the linked event", async ({ page }) => {
  await openDashboard(page, isPhone(page) ? "feed" : "map");
  await page.getByRole("button", { name: "News", exact: true }).click();
  await page.getByRole("button", { name: "Show on map" }).first().click();
  await expect(page.getByRole("dialog", { name: "Tropical Cyclone Arnab" })).toBeVisible();
  await expect(page.locator(".map-marker-highlight")).toBeAttached();
});

test("a news link to an event no longer in the feed says so", async ({ page }) => {
  await openDashboard(page, "map");
  await page.goto("/?event=999");
  await expect(page.getByRole("status").filter({ hasText: "no longer in the live feed" })).toBeVisible();
});
