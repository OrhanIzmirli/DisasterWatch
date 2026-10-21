/**
 * E-mail digests: rendering, the Resend client, and the dispatcher against a
 * real Postgres (TEST_DATABASE_URL only, schema from backend/prisma; never
 * the app database). The provider is a fake: no e-mail leaves the test.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import pg from "pg";
import { readEmailConfig, DEFAULT_DAILY_LIMIT } from "../src/email/config.js";
import { maskEmail, scrubText } from "../src/email/mask.js";
import { renderDigest, feedId, escapeHtml, MAX_ITEMS } from "../src/email/render.js";
import { createResendSender, EmailSendError, RESEND_URL } from "../src/email/resend.js";
import { createEmailDispatcher, MAX_ATTEMPTS, CONFIRM_RESEND_MS, confirmLimit, NOTIFICATION_MAX_AGE_MS } from "../src/email/dispatcher.js";
import { renderConfirmation } from "../src/email/render.js";

const APP = "https://dw.example.com";
const TOKEN = "T".repeat(43);

const alert = (extra = {}) => ({
  eventId: "nasa:EONET_25292",
  title: "Flood in Türkiye",
  type: "flood",
  severity: "medium",
  lat: 41.1157,
  lng: 28.9986,
  distanceKm: 12.3,
  occurredAt: new Date("2026-10-18T09:05:00Z"),
  subscriptionId: 7,
  subscriptionLabel: "Istanbul",
  subscriptionType: "any",
  subscriptionMinSeverity: "medium",
  subscriptionRadiusKm: 300,
  locationPrecision: "exact",
  ...extra,
});

describe("configuration", () => {
  it("is configured only with key, sender and site URL; reports missing names, never values", () => {
    expect(readEmailConfig({})).toMatchObject({ configured: false, missing: ["RESEND_API_KEY", "RESEND_FROM", "APP_URL"], dailyLimit: DEFAULT_DAILY_LIMIT });
    const c = readEmailConfig({ RESEND_API_KEY: " re_test_value ", RESEND_FROM: "DisasterWatch <onboarding@resend.dev>", APP_URL: "https://dw.example.com/", EMAIL_DAILY_LIMIT: "5" });
    expect(c).toMatchObject({ configured: true, missing: [], apiKey: "re_test_value", appUrl: APP, dailyLimit: 5 });
    expect(readEmailConfig({ RESEND_API_KEY: "k", RESEND_FROM: "f", APP_URL: "javascript:alert(1)" })).toMatchObject({ configured: false, missing: ["APP_URL"] });
    expect(readEmailConfig({ EMAIL_DAILY_LIMIT: "-3" }).dailyLimit).toBe(DEFAULT_DAILY_LIMIT);
  });
});

describe("masking", () => {
  it("masks addresses alone and inside provider messages", () => {
    expect(maskEmail("someone@example.com")).toBe("som***@example.com");
    expect(scrubText("You can only send testing emails to your own email address (owner.name@example.com).")).toBe(
      "You can only send testing emails to your own email address (own***@example.com)."
    );
  });
});

describe("digest content", () => {
  it("one alert: title, type, severity, source, time, location, map link, why, settings and unsubscribe; text + HTML", () => {
    const { subject, text, html } = renderDigest({ notifications: [alert()], appUrl: APP, unsubscribeUrl: `${APP}/unsubscribe?token=${TOKEN}` });
    expect(subject).toBe("DisasterWatch alert: Flood in Türkiye");
    for (const part of [text, html]) {
      expect(part).toContain("Flood in Türkiye");
      expect(part).toContain("Flood · Severity: Medium · Source: NASA EONET");
      expect(part).toContain("18 Oct 2026, 09:05 UTC");
      expect(part).toContain("41.12° N, 29.00° E");
      expect(part).toContain(`${APP}/?event=${feedId("nasa:EONET_25292")}`);
      expect(part).toContain(`${APP}/alerts`);
      expect(part).toContain(`${APP}/unsubscribe?token=${TOKEN}`);
      expect(part).not.toContain("Approximate location");
    }
    expect(text).toContain('12 km from your alert "Istanbul"');
    expect(text).toContain('"Istanbul": any disaster, medium and above, within 300 km');
  });

  it("says when the location is approximate", () => {
    const { text, html } = renderDigest({ notifications: [alert({ locationPrecision: "approximate" })], appUrl: APP, unsubscribeUrl: "u" });
    expect(text).toContain("Approximate location: the sources disagree on the exact area.");
    expect(html).toContain("Approximate location: the sources disagree on the exact area.");
  });

  it("no images, no tracking pixel, no scripts; every value is escaped", () => {
    const { html } = renderDigest({ notifications: [alert({ title: '<img src="https://tracker.example.com/p.gif"><script>x()</script>', subscriptionLabel: "<b>Home</b>" })], appUrl: APP, unsubscribeUrl: "u" });
    expect(html).not.toMatch(/<img|<script|<iframe|<link|background=|url\(/i);
    expect(html).toContain("&lt;img src=&quot;https://tracker.example.com/p.gif&quot;&gt;");
    expect(html).toContain("&lt;b&gt;Home&lt;/b&gt;");
    expect(escapeHtml(`"'&<>`)).toBe("&quot;&#39;&amp;&lt;&gt;");
  });

  it("many alerts: one digest, the first MAX_ITEMS listed and the rest counted; a removed alert is named as such", () => {
    const many = Array.from({ length: MAX_ITEMS + 3 }, (_, i) => alert({ eventId: `usgs:us${i}`, title: `M 5.${i} quake`, type: "earthquake", subscriptionId: null, subscriptionLabel: null }));
    const { subject, text } = renderDigest({ notifications: many, appUrl: APP, unsubscribeUrl: "u" });
    expect(subject).toBe(`DisasterWatch: ${MAX_ITEMS + 3} new alerts`);
    expect(text).toContain("…and 3 more");
    expect(text).toContain("an alert you have since removed");
    expect(text).toContain("Source: USGS");
  });

  it("the event link uses the same numeric id as the public feed", async () => {
    // backend/src/utils/normalizeDisasters.js: id = toId(EONET id / USGS id)
    const { normalizeNasaEvents } = await import("../../backend/src/utils/normalizeDisasters.js").catch(() => ({}));
    if (!normalizeNasaEvents) return; // backend sources not present (service built on its own)
    const [item] = normalizeNasaEvents([{ id: "EONET_25292", title: "Flood", categories: [{ id: "floods", title: "Floods" }], geometry: [{ date: "2026-10-11T20:00:00Z", type: "Point", coordinates: [33, 37.8] }] }]);
    expect(item.id).toBe(feedId("nasa:EONET_25292"));
  });
});

describe("Resend client", () => {
  const ok = (id = "msg_1") => ({ ok: true, status: 200, json: async () => ({ id }) });

  it("POSTs JSON with the bearer key, the idempotency key and the unsubscribe headers", async () => {
    const fetchImpl = vi.fn(async () => ok());
    const sender = createResendSender({ apiKey: "re_secret_value", fetchImpl });
    const out = await sender.send({ from: "f", to: "a@example.com", subject: "s", text: "t", html: "h", headers: { "List-Unsubscribe": "<u>" }, idempotencyKey: "dw-email-delivery-1" });
    expect(out).toEqual({ id: "msg_1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(RESEND_URL);
    expect(init.headers).toMatchObject({ Authorization: "Bearer re_secret_value", "Idempotency-Key": "dw-email-delivery-1" });
    expect(JSON.parse(init.body)).toMatchObject({ to: ["a@example.com"], headers: { "List-Unsubscribe": "<u>" } });
  });

  it("429/5xx/network errors are transient, other 4xx permanent; messages carry no address and no key", async () => {
    const answer = (status, body) => vi.fn(async () => ({ ok: false, status, json: async () => body }));
    const attempt = async (fetchImpl) => createResendSender({ apiKey: "re_secret_value", fetchImpl }).send({ to: "x@example.com" }).catch((e) => e);
    const e403 = await attempt(answer(403, { name: "validation_error", message: "You can only send testing emails to your own email address (owner@example.com)" }));
    expect(e403).toBeInstanceOf(EmailSendError);
    expect(e403).toMatchObject({ transient: false, status: 403 });
    expect(e403.message).toContain("own***@example.com");
    expect(e403.message).not.toContain("owner@example.com");
    expect(await attempt(answer(429, { message: "rate limited" }))).toMatchObject({ transient: true });
    expect(await attempt(answer(503, null))).toMatchObject({ transient: true });
    expect(await attempt(answer(409, { name: "concurrent_idempotent_requests", message: "in progress" }))).toMatchObject({ transient: true });
    expect(await attempt(answer(409, { name: "invalid_idempotent_request", message: "payload differs" }))).toMatchObject({ transient: false });
    const net = await attempt(vi.fn(async () => { throw new Error("ECONNRESET"); }));
    expect(net).toMatchObject({ transient: true });
    for (const e of [e403, net]) expect(e.message).not.toContain("re_secret_value");
  });
});

// ---------------------------------------------------------------- dispatcher, real Postgres
const DB_URL = process.env.TEST_DATABASE_URL;

describe.skipIf(!DB_URL)("dispatcher (Postgres)", () => {
  let pool;
  const quietLog = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });
  const config = (extra = {}) => ({ configured: true, missing: [], apiKey: "k", from: "DisasterWatch <onboarding@resend.dev>", appUrl: APP, dailyLimit: 90, ...extra });

  /** Fake provider with Resend's idempotency: a repeated key returns the first answer and sends nothing. */
  function fakeProvider() {
    const delivered = []; // what actually "left"
    const byKey = new Map();
    const failures = []; // queue of errors to throw
    const send = vi.fn(async (msg) => {
      if (failures.length) throw failures.shift();
      if (byKey.has(msg.idempotencyKey)) return byKey.get(msg.idempotencyKey);
      const answer = { id: `msg_${delivered.length + 1}` };
      byKey.set(msg.idempotencyKey, answer);
      delivered.push(msg);
      return answer;
    });
    return { send, delivered, failures };
  }

  const q = (sql, params) => pool.query(sql, params);
  async function user(email, { enabled = true, consentAt = new Date(Date.now() - 3600_000), token = null, disabledAt = null, verified = true, confirmToken = null } = {}) {
    const { rows } = await q(
      `INSERT INTO "User" ("email", "password", "emailAlertsEnabled", "emailAlertsConsentAt", "emailUnsubscribeToken", "disabledAt", "emailVerifiedAt", "emailConfirmToken")
       VALUES ($1, 'x', $2, $3, $4, $5, $6, $7) RETURNING "id"`,
      [email, enabled, enabled ? consentAt : null, token ?? `${email.split("@")[0].replace(/[^A-Za-z0-9]/g, "").padEnd(43, "x").slice(0, 43)}`, disabledAt, verified ? new Date(Date.now() - 7200_000) : null, confirmToken]
    );
    return rows[0].id;
  }
  let seq = 0;
  async function notification(userId, { createdAt = new Date(), eventId = `usgs:test${++seq}`, title = `M 5.${seq} - Testland` } = {}) {
    const { rows } = await q(
      `INSERT INTO "Notification" ("userId", "eventId", "title", "type", "severity", "lat", "lng", "distanceKm", "occurredAt", "createdAt")
       VALUES ($1, $2, $3, 'earthquake', 'medium', 10, 20, 5, $4, $4) RETURNING "id"`,
      [userId, eventId, title, createdAt]
    );
    return rows[0].id;
  }
  const notifRows = async () => (await q(`SELECT "id", "userId", "emailSentAt", "emailDeliveryId", "emailSkipReason" FROM "Notification" ORDER BY "id"`)).rows;
  const deliveries = async () => (await q(`SELECT * FROM "EmailDelivery" ORDER BY "id"`)).rows;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DB_URL, max: 4 });
    // same guard as the backend tests: refuse a database with real accounts
    const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "User" WHERE "email" NOT LIKE '%@example.com'`);
    if (rows[0].n > 0) throw new Error("TEST_DATABASE_URL has non-test accounts; refusing to run");
  });
  beforeEach(async () => {
    await q(`TRUNCATE TABLE "EmailChannelStatus", "EmailDelivery", "Notification", "AlertSubscription", "IngestedEvent", "User" RESTART IDENTITY CASCADE`);
  });
  afterAll(async () => {
    await pool?.end();
  });

  it("one digest per user with all of that user's new notifications; marked sent only after the provider accepted it", async () => {
    const a = await user("alice@example.com");
    const b = await user("bob@example.com");
    await notification(a);
    await notification(a);
    await notification(b);
    const provider = fakeProvider();
    const log = quietLog();
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log });
    const out = await d.runOnce();
    expect(out).toMatchObject({ claimed: 2, sent: 2, failed: 0 });
    expect(provider.delivered.map((m) => m.to).sort()).toEqual(["alice@example.com", "bob@example.com"]);
    const alice = provider.delivered.find((m) => m.to === "alice@example.com");
    expect(alice.subject).toBe("DisasterWatch: 2 new alerts");
    expect(alice.headers).toEqual({
      "List-Unsubscribe": `<${APP}/api/email/unsubscribe?token=alicexxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
    expect(alice.idempotencyKey).toMatch(/^dw-email-delivery-\d+$/);
    expect((await notifRows()).every((n) => n.emailSentAt && n.emailDeliveryId)).toBe(true);
    expect((await deliveries()).map((x) => [x.status, x.notificationCount, x.providerMessageId !== null])).toEqual([["sent", 2, true], ["sent", 1, true]]);
    // a second run sends nothing
    expect(await d.runOnce()).toMatchObject({ claimed: 0, sent: 0 });
    expect(provider.send).toHaveBeenCalledTimes(2);
    // logs carry masked addresses only
    const logged = JSON.stringify([log.log.mock.calls, log.warn.mock.calls, log.error.mock.calls]);
    expect(logged).toContain("ali***@example.com");
    expect(logged).not.toContain("alice@example.com");
  });

  it("only opted-in users, only notifications created after the consent and within 24 h, never suspended accounts", async () => {
    const off = await user("off@example.com", { enabled: false });
    const late = await user("late@example.com", { consentAt: new Date() });
    const gone = await user("gone@example.com", { disabledAt: new Date() });
    const ok = await user("ok@example.com");
    await notification(off);
    await notification(late, { createdAt: new Date(Date.now() - 60_000) }); // before the consent
    await notification(gone);
    await notification(ok, { createdAt: new Date(Date.now() - 25 * 3600_000) }); // too old
    const provider = fakeProvider();
    expect(await createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() }).runOnce()).toMatchObject({ claimed: 0, sent: 0 });
    expect(provider.send).not.toHaveBeenCalled();
    expect((await notifRows()).every((n) => !n.emailSentAt && !n.emailDeliveryId)).toBe(true);
  });

  it("daily limit, counted from the database: over it the e-mail is skipped with a reason, the notification stays; a restarted service still knows", async () => {
    const ids = [];
    for (const name of ["u1", "u2", "u3"]) ids.push(await user(`${name}@example.com`));
    for (const id of ids) await notification(id);
    const provider = fakeProvider();
    const out = await createEmailDispatcher({ pool, config: config({ dailyLimit: 2 }), sender: provider, log: quietLog() }).runOnce();
    expect(out).toMatchObject({ claimed: 2, sent: 2, skippedDailyLimit: 1 });
    const rows = await notifRows();
    expect(rows.filter((n) => n.emailSentAt)).toHaveLength(2);
    expect(rows.filter((n) => n.emailSkipReason === "daily-limit")).toHaveLength(1);
    expect(rows).toHaveLength(3); // every in-app notification is still there

    // "restart": a new dispatcher (empty memory) with a new notification
    await notification(ids[0]);
    const restarted = createEmailDispatcher({ pool, config: config({ dailyLimit: 2 }), sender: provider, log: quietLog() });
    expect(await restarted.runOnce()).toMatchObject({ claimed: 0, sent: 0, skippedDailyLimit: 1 });
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(restarted.status()).toMatchObject({ sentLast24h: 2, limitReached: true });
  });

  it("a transient failure is retried on the next run with the same idempotency key; nothing is sent twice", async () => {
    const a = await user("retry@example.com");
    await notification(a);
    const provider = fakeProvider();
    provider.failures.push(new EmailSendError("Resend 503", { transient: true, status: 503 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    expect(await d.runOnce()).toMatchObject({ claimed: 1, sent: 0, retrying: 1 });
    expect((await notifRows())[0].emailSentAt).toBeNull();
    expect(await deliveries()).toMatchObject([{ status: "pending", attempts: 1, lastError: "Resend 503" }]);
    expect(d.status()).toMatchObject({ pending: 1, lastError: "Resend 503" });

    // a new notification meanwhile waits: the failed digest is retried as it was, the new one follows in its own
    await notification(a);
    expect(await d.runOnce()).toMatchObject({ claimed: 0, sent: 1 });
    expect(await d.runOnce()).toMatchObject({ claimed: 1, sent: 1 });
    const keys = provider.send.mock.calls.map(([m]) => m.idempotencyKey);
    expect(keys).toEqual(["dw-email-delivery-1", "dw-email-delivery-1", "dw-email-delivery-2"]);
    expect(provider.delivered).toHaveLength(2);
    expect((await notifRows()).map((n) => n.emailDeliveryId)).toEqual([1, 2]);
    expect(d.status().lastError).toBeNull();
  });

  it("a send that went out but was not marked (crash) is repeated with the same key: the provider does not deliver it again", async () => {
    const a = await user("crash@example.com");
    await notification(a);
    const provider = fakeProvider();
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    await d.runOnce();
    // simulate the crash between the provider's answer and our UPDATE
    await q(`UPDATE "EmailDelivery" SET "status" = 'pending', "sentAt" = NULL`);
    await q(`UPDATE "Notification" SET "emailSentAt" = NULL`);
    await createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() }).runOnce();
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.delivered).toHaveLength(1);
    expect((await notifRows())[0].emailSentAt).not.toBeNull();
  });

  it("a permanent failure (e.g. Resend test mode, recipient not allowed) is not retried; the reason is stored masked", async () => {
    const a = await user("notowner@example.com");
    await notification(a);
    const provider = fakeProvider();
    provider.failures.push(new EmailSendError("Resend 403: You can only send testing emails to your own email address (owner@example.com)", { transient: false, status: 403 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    expect(await d.runOnce()).toMatchObject({ failed: 1 });
    expect(await d.runOnce()).toMatchObject({ claimed: 0, sent: 0, failed: 0 });
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(await notifRows()).toMatchObject([{ emailSentAt: null, emailSkipReason: "send-failed" }]);
    const [row] = await deliveries();
    expect(row).toMatchObject({ status: "failed" });
    expect(row.lastError).toContain("own***@example.com");
    expect(row.lastError).not.toContain("owner@example.com");
  });

  it(`gives up after ${MAX_ATTEMPTS} transient failures`, async () => {
    const a = await user("flaky@example.com");
    await notification(a);
    const provider = fakeProvider();
    for (let i = 0; i < MAX_ATTEMPTS; i++) provider.failures.push(new EmailSendError("Resend 500", { transient: true, status: 500 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    for (let i = 0; i < MAX_ATTEMPTS; i++) await d.runOnce();
    expect(await deliveries()).toMatchObject([{ status: "failed", attempts: MAX_ATTEMPTS }]);
    expect(await d.runOnce()).toMatchObject({ sent: 0 });
    expect(provider.delivered).toHaveLength(0);
  });

  it("unsubscribed between the claim and the send: cancelled, nothing sent", async () => {
    const a = await user("quit@example.com");
    await notification(a);
    const provider = fakeProvider();
    provider.failures.push(new EmailSendError("Resend 503", { transient: true, status: 503 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    await d.runOnce();
    await q(`UPDATE "User" SET "emailAlertsEnabled" = false, "emailAlertsConsentAt" = NULL`);
    expect(await d.runOnce()).toMatchObject({ cancelled: 1, sent: 0 });
    expect(provider.delivered).toHaveLength(0);
    expect(await notifRows()).toMatchObject([{ emailSkipReason: "disabled" }]);
  });

  it("two instances at once (deploy overlap): the lease lets one send each delivery, the other skips it", async () => {
    const a = await user("twice@example.com");
    await notification(a);
    const provider = fakeProvider();
    let release;
    const gate = new Promise((r) => (release = r));
    const slow = { send: vi.fn(async (m) => { await gate; return provider.send(m); }) };
    const one = createEmailDispatcher({ pool, config: config(), sender: slow, log: quietLog() });
    const two = createEmailDispatcher({ pool, config: config(), sender: slow, log: quietLog() });
    const first = one.runOnce();
    await new Promise((r) => setTimeout(r, 150));
    const second = await two.runOnce();
    release();
    expect(await first).toMatchObject({ sent: 1 });
    expect(second).toMatchObject({ claimed: 0, sent: 0, busy: 1 });
    expect(provider.delivered).toHaveLength(1);
  });

  it("a user whose digest is still pending (retrying) gets no second digest in the same run", async () => {
    const a = await user("onlyone@example.com");
    await notification(a);
    const provider = fakeProvider();
    provider.failures.push(new EmailSendError("Resend 503", { transient: true, status: 503 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    await d.runOnce();
    await notification(a);
    expect(await d.runOnce()).toMatchObject({ claimed: 0, sent: 1 });
    expect(provider.delivered).toHaveLength(1);
    expect(await d.runOnce()).toMatchObject({ claimed: 1, sent: 1 }); // the newer one follows in its own digest
  });

  it("a retry sends exactly the stored payload, even if the data changed meanwhile (same key, same body)", async () => {
    const a = await user("same@example.com");
    const { rows } = await q(`INSERT INTO "AlertSubscription" ("userId", "label", "centerLat", "centerLng", "radiusKm") VALUES ($1, 'Home', 10, 20, 300) RETURNING "id"`, [a]);
    const n = await notification(a);
    await q(`UPDATE "Notification" SET "subscriptionId" = $1 WHERE "id" = $2`, [rows[0].id, n]);
    const provider = fakeProvider();
    provider.failures.push(new EmailSendError("Resend 503", { transient: true, status: 503 }));
    const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
    await d.runOnce();
    await q(`UPDATE "AlertSubscription" SET "label" = 'Renamed'`);
    await d.runOnce();
    const [first, second] = provider.send.mock.calls.map(([m]) => m);
    expect(second).toEqual(first);
    expect(second.text).toContain('"Home"');
  });

  it("a database error on one delivery does not stop the others, and the status row is still written", async () => {
    const a = await user("first@example.com");
    const b = await user("second@example.com");
    await notification(a);
    await notification(b);
    const provider = fakeProvider();
    let calls = 0;
    const flaky = {
      connect: () => pool.connect(),
      query: (sql, params) => {
        // the first delivery's payload cannot be stored (connection lost)
        if (String(sql).includes('SET "payload"') && calls++ === 0) return Promise.reject(new Error("connection reset"));
        return pool.query(sql, params);
      },
    };
    const d = createEmailDispatcher({ pool: flaky, config: config(), sender: provider, log: quietLog() });
    expect(await d.runOnce()).toMatchObject({ claimed: 2, sent: 1, retrying: 1 });
    expect((await q(`SELECT "updatedAt" FROM "EmailChannelStatus"`)).rows).toHaveLength(1);
    expect(d.status().lastError).toBe("connection reset");
    expect(await d.runOnce()).toMatchObject({ sent: 0, busy: 1 }); // its lease still runs: nobody sends it meanwhile
    expect(provider.delivered).toHaveLength(1);
  });

  it("cancelled deliveries that were attempted count too (a timed-out send may have gone out)", async () => {
    const a = await user("cancelledcount@example.com");
    await q(`INSERT INTO "EmailDelivery" ("userId", "status", "notificationCount", "attempts", "lastAttemptAt") VALUES ($1, 'cancelled', 1, 1, now())`, [a]);
    await notification(a);
    const out = await createEmailDispatcher({ pool, config: config({ dailyLimit: 1 }), sender: fakeProvider(), log: quietLog() }).runOnce();
    expect(out).toMatchObject({ claimed: 0, skippedDailyLimit: 1 });
  });

  it("a notification that waited past the 24 h cutoff gets the reason too-old instead of silently staying unsent", async () => {
    const a = await user("waited@example.com", { consentAt: new Date(Date.now() - 3 * NOTIFICATION_MAX_AGE_MS) });
    await notification(a, { createdAt: new Date(Date.now() - NOTIFICATION_MAX_AGE_MS - 60_000) });
    await createEmailDispatcher({ pool, config: config(), sender: fakeProvider(), log: quietLog() }).runOnce();
    expect(await notifRows()).toMatchObject([{ emailSentAt: null, emailSkipReason: "too-old" }]);
  });

  it("failed deliveries that reached the provider count against the daily limit", async () => {
    const a = await user("limited@example.com");
    await q(`INSERT INTO "EmailDelivery" ("userId", "status", "notificationCount", "attempts", "lastAttemptAt") VALUES ($1, 'failed', 1, 5, now())`, [a]);
    await notification(a);
    const out = await createEmailDispatcher({ pool, config: config({ dailyLimit: 1 }), sender: fakeProvider(), log: quietLog() }).runOnce();
    expect(out).toMatchObject({ claimed: 0, skippedDailyLimit: 1 });
  });

  it("writes the channel status row: configured, limit, last send; without provider settings nothing is claimed", async () => {
    const a = await user("status@example.com");
    await notification(a);
    const off = createEmailDispatcher({ pool, config: config({ configured: false, missing: ["RESEND_API_KEY"] }), sender: fakeProvider(), log: quietLog() });
    await off.runOnce();
    expect((await q(`SELECT * FROM "EmailChannelStatus"`)).rows).toMatchObject([{ id: 1, configured: false, dailyLimit: 90 }]);
    expect(await deliveries()).toHaveLength(0);
    expect(off.status()).toMatchObject({ configured: false, missing: ["RESEND_API_KEY"] });

    const on = createEmailDispatcher({ pool, config: config(), sender: fakeProvider(), log: quietLog() });
    await on.runOnce();
    const [row] = (await q(`SELECT * FROM "EmailChannelStatus"`)).rows;
    expect(row).toMatchObject({ configured: true, lastError: null });
    expect(row.lastSentAt).toBeInstanceOf(Date);
    expect(JSON.stringify(on.status())).not.toContain("@");
  });

  it("schedule() waits for the burst to end (debounced) and then runs once", async () => {
    let connects = 0; // runs, counted by their status-row write
    const counting = {
      connect: () => pool.connect(),
      query: (sql, params) => {
        if (String(sql).includes('INSERT INTO "EmailChannelStatus"')) connects++;
        return pool.query(sql, params);
      },
    };
    const d = createEmailDispatcher({ pool: counting, config: config(), sender: fakeProvider(), log: quietLog(), debounceMs: 80, maxWaitMs: 1000 });
    for (let i = 0; i < 4; i++) {
      d.schedule();
      await new Promise((r) => setTimeout(r, 30));
    }
    expect(connects).toBe(0); // still inside the burst
    await new Promise((r) => setTimeout(r, 300));
    expect(connects).toBe(1);
    expect(d.status().lastRunAt).not.toBeNull();
    d.stop();
  });

  describe("double opt-in", () => {
    const CONFIRM = "C".repeat(43);

    it("an unconfirmed address gets only the confirmation e-mail (fixed text, no user-written text), no alerts", async () => {
      const a = await user("unconfirmed@example.com", { verified: false, confirmToken: CONFIRM });
      const { rows } = await q(`INSERT INTO "AlertSubscription" ("userId", "label", "centerLat", "centerLng", "radiusKm") VALUES ($1, 'Visit evil.example now', 10, 20, 300) RETURNING "id"`, [a]);
      const n = await notification(a);
      await q(`UPDATE "Notification" SET "subscriptionId" = $1 WHERE "id" = $2`, [rows[0].id, n]);
      const provider = fakeProvider();
      const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
      expect(await d.runOnce()).toMatchObject({ confirmations: 1, claimed: 0, sent: 1 });
      expect(provider.delivered).toHaveLength(1);
      const [mail] = provider.delivered;
      expect(mail.subject).toBe("Confirm DisasterWatch alert e-mails");
      expect(mail.text).toContain(`${APP}/confirm-email?token=${CONFIRM}`);
      expect(JSON.stringify(mail)).not.toMatch(/evil\.example|Testland/);
      expect(await d.runOnce()).toMatchObject({ confirmations: 0, sent: 0 }); // not sent again
      expect((await notifRows())[0].emailSentAt).toBeNull();
    });

    it("after the confirmation the alerts follow (those created after the consent)", async () => {
      const a = await user("later@example.com", { verified: false, confirmToken: CONFIRM });
      await notification(a, { title: "M 6.1 - Confirmland" });
      const provider = fakeProvider();
      const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
      await d.runOnce();
      await q(`UPDATE "User" SET "emailVerifiedAt" = now(), "emailConfirmToken" = NULL`);
      expect(await d.runOnce()).toMatchObject({ claimed: 1, sent: 1 });
      expect(provider.delivered.map((m) => m.subject)).toEqual(["Confirm DisasterWatch alert e-mails", "DisasterWatch alert: M 6.1 - Confirmland"]);
    });

    it("a new opt-in re-sends the confirmation, at most once an hour", async () => {
      await user("again@example.com", { verified: false, confirmToken: CONFIRM });
      const provider = fakeProvider();
      let t = new Date();
      const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog(), now: () => t });
      await d.runOnce();
      await q(`UPDATE "User" SET "emailAlertsConsentAt" = $1`, [new Date(t.getTime() + 1000)]); // off and on again
      t = new Date(t.getTime() + 2000);
      expect(await d.runOnce()).toMatchObject({ confirmations: 0 });
      t = new Date(t.getTime() + CONFIRM_RESEND_MS);
      expect(await d.runOnce()).toMatchObject({ confirmations: 1, sent: 1 });
    });

    it("confirmations have their own small share of the daily limit: they cannot use up what digests need", async () => {
      expect(confirmLimit(90)).toBe(10);
      expect(confirmLimit(3)).toBe(1);
      for (let i = 0; i < 4; i++) await user(`fake${i}@example.com`, { verified: false, confirmToken: String(i).repeat(43) });
      const real = await user("real@example.com");
      await notification(real);
      const provider = fakeProvider();
      const out = await createEmailDispatcher({ pool, config: config({ dailyLimit: 5 }), sender: provider, log: quietLog() }).runOnce();
      expect(out).toMatchObject({ confirmations: 1, claimed: 1, skippedDailyLimit: 0 });
      expect(provider.delivered.map((m) => m.to)).toContain("real@example.com");
    });

    it("a stored confirmation is not sent once the address was confirmed meanwhile", async () => {
      await user("confirmedmeanwhile@example.com", { verified: false, confirmToken: CONFIRM });
      const provider = fakeProvider();
      provider.failures.push(new EmailSendError("Resend 503", { transient: true, status: 503 }));
      const d = createEmailDispatcher({ pool, config: config(), sender: provider, log: quietLog() });
      await d.runOnce();
      await q(`UPDATE "User" SET "emailVerifiedAt" = now(), "emailConfirmToken" = NULL`);
      expect(await d.runOnce()).toMatchObject({ cancelled: 1, sent: 0 });
      expect(provider.delivered).toHaveLength(0);
    });

    it("the confirmation template carries nothing but the link and fixed text", () => {
      const { text, html } = renderConfirmation({ appUrl: APP, confirmUrl: `${APP}/confirm-email?token=${CONFIRM}` });
      expect(text).toContain(`${APP}/confirm-email?token=${CONFIRM}`);
      expect(html).toContain(`href="${APP}/confirm-email?token=${CONFIRM}"`);
      expect(html).not.toMatch(/<img|<script/i);
    });
  });
});
