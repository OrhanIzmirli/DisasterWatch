/**
 * Automated accessibility checks (axe-core, WCAG 2.1 A and AA rules) on every
 * page and on the open drawer and news panel. Serious and critical findings
 * fail the test; the full list is printed either way.
 */
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { isPhone, open, openDashboard, openEvent } from "./pages";

async function audit(page: Page, include?: string) {
  // label-content-name-mismatch (WCAG 2.5.3) is "experimental" in axe-core and off by default; Lighthouse runs it
  let builder = new AxeBuilder({ page })
    // wcag22aa brings target-size (2.5.8): map cluster icons must not hide one another
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "experimental"])
    .options({ rules: { "label-content-name-mismatch": { enabled: true } } });
  // map tiles and Leaflet's own controls are third-party markup
  builder = builder.exclude(".leaflet-tile-container").exclude(".leaflet-control-attribution");
  if (include) builder = builder.include(include);
  const { violations } = await builder.analyze();
  for (const v of violations) console.log(`[axe] ${v.impact} ${v.id}: ${v.help} (${v.nodes.length})`);
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

test("dashboard", async ({ page }) => {
  await openDashboard(page, "feed");
  await audit(page);
});

test("event drawer", async ({ page }) => {
  await openEvent(page, /Palekastro/);
  await audit(page, ".detail-drawer");
});

test("news panel", async ({ page }) => {
  await openDashboard(page, isPhone(page) ? "feed" : "map");
  await page.getByRole("button", { name: "News", exact: true }).click();
  // the panel is its own chunk, loaded on this first click
  await expect(page.getByRole("dialog", { name: "Latest news" })).toBeVisible();
  await audit(page, ".news-panel");
});

for (const path of ["/alerts", "/signin", "/signup", "/privacy", "/no-such-page"]) {
  test(`page ${path}`, async ({ page }) => {
    await open(page, path);
    await audit(page);
  });
}
