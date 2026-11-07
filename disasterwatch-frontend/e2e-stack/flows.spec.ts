/**
 * Write flows on a local stack (see playwright.stack.config.ts). One serial
 * story: a user signs up and manages alerts and the e-mail switch, an admin
 * confirms their address, manages the user and publishes a test event, the
 * user's bell shows the matching notification, and the user deletes the account.
 * Addresses are @example.com and unique per run.
 */
import { execFileSync } from "node:child_process";
import AxeBuilder from "@axe-core/playwright";
import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const RUN = Date.now().toString(36);
const USER = { email: `flow-user-${RUN}@example.com`, password: "flow-pass-123" };
const ADMIN = { email: "admin@example.com", password: "admin-pass-123" };

/** Reads one value from the local stack's database (docker compose service "db"). */
function sql(query: string): string {
  return execFileSync("docker", ["exec", "disasterwatch_db", "psql", "-U", "postgres", "-d", "disasterwatch", "-tAc", query], { encoding: "utf8" }).trim();
}

/** axe-core WCAG 2.1 A/AA on the page's main content; serious and critical findings fail. */
async function auditA11y(page: Page) {
  const { violations } = await new AxeBuilder({ page }).include("main").withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
  const blocking = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(blocking.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).slice(0, 3).join(", ")}`)).toEqual([]);
}

async function signUp(page: Page, who: { email: string; password: string }) {
  await page.goto("/signup");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Create account" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function signIn(page: Page, who: { email: string; password: string }) {
  await page.goto("/signin");
  await page.getByLabel("Email").fill(who.email);
  await page.getByLabel("Password").fill(who.password);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}

async function signOut(page: Page) {
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
}

test.describe.configure({ mode: "serial" });

// One browser session per person for the whole story: sign-in is rate limited
// (10 attempts per 15 minutes per client), so the tests do not sign in again each time.
let userCtx: BrowserContext;
let adminCtx: BrowserContext;
let user: Page;
let admin: Page;
test.beforeAll(async ({ browser }) => {
  // the admin address is fixed (ADMIN_EMAILS); a previous run's account is removed from the local database
  sql(`DELETE FROM "User" WHERE email = '${ADMIN.email}'`);
  userCtx = await browser.newContext();
  adminCtx = await browser.newContext();
  user = await userCtx.newPage();
  admin = await adminCtx.newPage();
});
test.afterAll(async () => {
  await userCtx?.close();
  await adminCtx?.close();
});

test("sign up, sign out and sign in again; a wrong password is refused", async () => {
  const page = user;
  await signUp(page, USER);
  await signOut(page);
  await page.goto("/signin");
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("alert").or(page.getByText(/invalid|incorrect|wrong/i)).first()).toBeVisible();
  await signIn(page, USER);
});

test("create two alerts and delete one", async () => {
  const page = user;
  await page.goto("/alerts");
  for (const label of ["Warsaw test area", "Second test area"]) {
    await page.getByRole("button", { name: "+ Add alert" }).click();
    await page.getByLabel(/^Label/).fill(label);
    await page.getByLabel(/^Latitude/).fill("52.2297");
    await page.getByLabel(/^Longitude/).fill("21.0122");
    await page.getByLabel(/^Radius/).fill("300");
    await page.getByRole("button", { name: "Save alert" }).click();
    await expect(page.getByText(label)).toBeVisible();
  }
  // the signed-in Alert center with its form open: every field has a label
  await page.getByRole("button", { name: "+ Add alert" }).click();
  for (const name of ["Disaster type", "Minimum severity", /^Label/, /^Radius/, /^Latitude/, /^Longitude/]) {
    await expect(page.getByLabel(name)).toBeVisible();
  }
  await auditA11y(page);
  await page.getByRole("button", { name: "Cancel" }).click();
  page.once("dialog", (d) => d.accept());
  await page.locator("li, tr, article").filter({ hasText: "Second test area" }).getByRole("button", { name: "Delete" }).click();
  await expect(page.getByText("Second test area")).toHaveCount(0);
  await expect(page.getByText("Warsaw test area")).toBeVisible();
  expect(Number(sql(`SELECT count(*) FROM "AlertSubscription" s JOIN "User" u ON u.id = s."userId" WHERE u.email = '${USER.email}'`))).toBe(1);
});

test("the e-mail switch turns on with consent (confirmation pending) and off again", async () => {
  const page = user;
  await page.goto("/alerts");
  const toggle = page.getByRole("switch");
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect(page.getByText(/Almost done/)).toBeVisible();
  expect(sql(`SELECT "emailAlertsEnabled" FROM "User" WHERE email = '${USER.email}'`)).toBe("t");
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  expect(sql(`SELECT "emailAlertsEnabled" FROM "User" WHERE email = '${USER.email}'`)).toBe("f");
});

test("an ADMIN_EMAILS address becomes admin only after confirming while signed in", async () => {
  const page = admin;
  await signUp(page, ADMIN);
  await expect(page.getByText("Admin", { exact: true })).toHaveCount(0);
  await page.goto("/alerts");
  await page.getByRole("switch").click();
  await expect(page.getByRole("switch")).toBeChecked();
  const token = sql(`SELECT "emailConfirmToken" FROM "User" WHERE email = '${ADMIN.email}'`);
  expect(token).toMatch(/^[A-Za-z0-9_-]{20,}$/);
  await page.goto(`/confirm-email?token=${token}`);
  await page.getByRole("button", { name: "Yes, send alert e-mails to this address" }).click();
  await expect(page.getByText(/Confirmed\./)).toBeVisible();
  await page.goto("/admin");
  await expect(page.getByText("Admin", { exact: true }).first()).toBeVisible();
  await auditA11y(page);
  await page.goto("/account");
  await expect(page.getByRole("heading", { level: 1, name: "My account" })).toBeVisible();
  await auditA11y(page);
});

test("the admin finds, disables and re-enables the user; the audit log records it", async () => {
  const page = admin;
  await page.goto("/admin");
  await page.getByRole("tab", { name: /users/i }).click();
  await page.getByLabel(/Search users by e-mail/).fill(USER.email);
  // a row opens the user's detail panel, where the account actions are
  await page.getByRole("row").filter({ hasText: USER.email }).first().click();
  await page.getByRole("button", { name: "Disable account" }).click();
  await expect(page.getByRole("button", { name: "Enable account" })).toBeVisible();
  expect(sql(`SELECT "disabledAt" IS NOT NULL FROM "User" WHERE email = '${USER.email}'`)).toBe("t");
  await page.getByRole("button", { name: "Enable account" }).click();
  await expect(page.getByRole("button", { name: "Disable account" })).toBeVisible();
  expect(sql(`SELECT "disabledAt" IS NULL FROM "User" WHERE email = '${USER.email}'`)).toBe("t");
  await page.getByRole("tab", { name: /audit/i }).click();
  // the audit log names the actions in words ("Disabled user") and shows the target
  await expect(page.getByRole("row").filter({ hasText: "Disabled user" }).filter({ hasText: USER.email }).first()).toBeVisible();
  await expect(page.getByRole("row").filter({ hasText: "Enabled user" }).filter({ hasText: USER.email }).first()).toBeVisible();
});

test("an event published to Kafka reaches the user's bell", async () => {
  const page = admin;
  const eventId = `manual:flow-${RUN}`;
  const res = await page.request.post("/api/events", {
    data: { v: 1, eventId, source: "manual", type: "earthquake", severity: "high", title: `Flow test earthquake ${RUN}`, lat: 52.3, lng: 21.1, occurredAt: new Date().toISOString() },
  });
  expect(res.status(), await res.text()).toBeLessThan(300);
  await expect
    .poll(() => Number(sql(`SELECT count(*) FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE u.email = '${USER.email}'`)), { timeout: 30_000 })
    .toBe(1);

  // disabling the account ended the user's sessions, so the user signs in again
  await user.goto("/");
  await expect(user.getByRole("button", { name: "Sign out" })).toHaveCount(0);
  await signIn(user, USER);
  const bell = user.getByRole("button", { name: "1 unread notification" });
  await expect(bell).toContainText("1");
  await bell.click();
  await expect(user.getByText(`Flow test earthquake ${RUN}`)).toBeVisible();
});

test("the user deletes the account and can no longer sign in", async () => {
  const page = user;
  await page.goto("/account");
  await page.getByRole("button", { name: "Delete my account…" }).click();
  await page.getByLabel("Your password").fill(USER.password);
  await page.getByRole("button", { name: "Delete account permanently" }).click();
  await expect(page.getByRole("link", { name: "Sign in" }).first()).toBeVisible();
  expect(sql(`SELECT count(*) FROM "User" WHERE email = '${USER.email}'`)).toBe("0");
  await page.goto("/signin");
  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill(USER.password);
  await page.getByRole("button", { name: "Sign in" }).last().click();
  await expect(page.getByRole("button", { name: "Sign out" })).toHaveCount(0);
});
