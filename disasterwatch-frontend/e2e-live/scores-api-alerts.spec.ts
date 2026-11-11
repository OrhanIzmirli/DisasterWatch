import { test, expect } from "@playwright/test";
import { liveDashboard, readOnly, isPhone } from "./guard";

/**
 * Read-only checks of the parts read.spec.ts does not cover: the score filters and the
 * drawer's "Why these scores?" panel, the API page's "Try it out", and the alert sign-up
 * path for a visitor without an account (nothing is submitted; non-GET requests are aborted).
 */

test("the priority filter narrows the feed, and the drawer explains the scores", async ({ page }) => {
  await liveDashboard(page);
  const rows = page.locator("button.disaster-row");
  // "Showing 50 per page • Total filtered: 144": the number after "Total filtered"
  const filtered = () => page.getByText(/Total filtered: \d+/).textContent().then((t) => Number(t?.match(/Total filtered: (\d+)/)?.[1]));
  const total = await filtered();
  expect(total).toBeGreaterThan(0);

  // the lowest priority step keeps part of the feed, fewer than "any" (the count re-renders after the change)
  const select = page.getByRole("combobox", { name: "Minimum priority" });
  const steps = await select.locator("option").evaluateAll((o) => o.map((x) => (x as HTMLOptionElement).value).filter((v) => v !== "0"));
  await select.selectOption(steps[0]);
  await expect.poll(filtered).toBeLessThan(total);
  expect(await filtered()).toBeGreaterThan(0);
  await select.selectOption("0");
  await expect.poll(filtered).toBe(total);

  await rows.first().click();
  const drawer = page.getByRole("dialog");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("Why these scores?")).toBeVisible({ timeout: 30_000 });
  // the terms come from the public API (GET /api/v1/disasters/{id}): one table per score
  const tables = drawer.locator("table.edd-score-table");
  await expect(tables.first()).toBeVisible({ timeout: 30_000 });
  await expect(tables.first().locator("caption")).toContainText(/Confidence \d+/);
  expect(await tables.first().locator("tbody tr").count()).toBeGreaterThan(0);
  await expect(drawer.getByText(/breakdown cannot be loaded/)).toHaveCount(0);
});

test("the API page: Try it out runs a real GET and shows a 200 with events", async ({ page }) => {
  test.skip(isPhone(page), "desktop only: Swagger UI is the same at 390, covered by the visual suite");
  const blocked = await readOnly(page);
  await page.goto("/api", { timeout: 120_000 });
  const op = page.locator(".opblock-get").filter({ hasText: "/disasters" }).first();
  await op.locator(".opblock-summary").click();
  await op.getByRole("button", { name: "Try it out" }).click();
  await op.getByRole("button", { name: "Execute" }).click();
  // the live answer (Swagger UI also lists the documented responses, 200/400/429/500, in another table)
  const live = op.locator(".live-responses-table");
  await expect(live.locator("tbody .response-col_status").first()).toHaveText(/200/, { timeout: 120_000 });
  await expect(live.locator(".microlight").first()).toContainText('"data"');
  expect(blocked).toEqual([]);
});

test("alerts: a visitor without an account is led to sign in or create one, and the form is complete", async ({ page }) => {
  const blocked = await readOnly(page);
  await page.goto("/alerts", { timeout: 120_000 });
  await expect(page.getByRole("heading", { name: /Create an account to get alerts/ })).toBeVisible({ timeout: 60_000 });
  await page.getByRole("link", { name: "Create an account" }).click();
  await expect(page).toHaveURL(/\/signup/);
  for (const name of [/e-?mail/i, /password/i]) await expect(page.getByLabel(name).first()).toBeVisible();
  expect(blocked).toEqual([]);
});
