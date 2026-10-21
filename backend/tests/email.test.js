import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, registerAgent, prisma } from "./helpers.js";
import { emailChannelStatus, STALE_MS, EMAIL_TOKEN } from "../src/services/emailChannel.js";
import { ingestOnce } from "../src/jobs/ingest.js";

beforeEach(resetDb);

const app = createTestApp({ email: { limit: false } });
const signUp = async (email = "mail-user@example.com") => (await registerAgent(app, email)).agent;
const userRow = (email = "mail-user@example.com") => prisma.user.findUnique({ where: { email } });
const reportStatus = (data = {}) =>
  prisma.emailChannelStatus.upsert({
    where: { id: 1 },
    create: { id: 1, configured: true, dailyLimit: 90, updatedAt: new Date(), ...data },
    update: { configured: true, dailyLimit: 90, updatedAt: new Date(), ...data },
  });

describe("e-mail alerts are opt-in", () => {
  it("are off for a new account and need a session", async () => {
    expect((await request(app).get("/alerts/email")).status).toBe(401);
    const agent = await signUp();
    const res = await agent.get("/alerts/email");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ enabled: false, consentAt: null, channel: { state: "not-configured" } });
    expect(await userRow()).toMatchObject({ emailAlertsEnabled: false, emailAlertsConsentAt: null, emailUnsubscribeToken: null });
  });

  it("turning them on requires the explicit consent flag", async () => {
    const agent = await signUp();
    for (const body of [{ enabled: true }, { enabled: true, consent: false }, { enabled: "yes", consent: true }, {}]) {
      expect((await agent.put("/alerts/email").send(body)).status).toBe(400);
    }
    expect((await userRow()).emailAlertsEnabled).toBe(false);
  });

  it("on: consent time and an unsubscribe token are stored; off clears the consent; the token survives a new opt-in", async () => {
    const agent = await signUp();
    const on = await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect(on.status).toBe(200);
    expect(on.body.enabled).toBe(true);
    const first = await userRow();
    expect(first.emailAlertsConsentAt).toBeInstanceOf(Date);
    expect(first.emailUnsubscribeToken).toMatch(EMAIL_TOKEN);
    expect(JSON.stringify(on.body)).not.toContain(first.emailUnsubscribeToken); // never sent to the browser

    const off = await agent.put("/alerts/email").send({ enabled: false });
    expect(off.body).toMatchObject({ enabled: false, consentAt: null });
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await userRow()).emailUnsubscribeToken).toBe(first.emailUnsubscribeToken);
  });

  it("a second 'on' keeps the original consent time", async () => {
    const agent = await signUp();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    const { emailAlertsConsentAt } = await userRow();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await userRow()).emailAlertsConsentAt).toEqual(emailAlertsConsentAt);
  });
});

describe("e-mail channel state (what the Alerts page shows)", () => {
  const user = async () => (await prisma.user.create({ data: { email: "counted@example.com", password: "x" } })).id;

  it("not-configured without a report or when the sender has no provider settings", async () => {
    expect((await emailChannelStatus({ prisma })).state).toBe("not-configured");
    await reportStatus({ configured: false });
    expect((await emailChannelStatus({ prisma })).state).toBe("not-configured");
  });

  it("active when configured and reported recently; unknown when the report is stale", async () => {
    await reportStatus();
    expect(await emailChannelStatus({ prisma })).toMatchObject({ state: "active", dailyLimit: 90, sentLast24h: 0 });
    const later = new Date(Date.now() + STALE_MS + 60_000);
    expect((await emailChannelStatus({ prisma, now: later })).state).toBe("unknown");
  });

  it("limit-reached when the digests of the last 24 h (sent + pending) reach the limit; older or failed ones do not count", async () => {
    await reportStatus({ dailyLimit: 3 });
    const userId = await user();
    const old = new Date(Date.now() - 25 * 3600_000);
    await prisma.emailDelivery.createMany({
      data: [
        { userId, status: "sent", notificationCount: 1, sentAt: new Date() },
        { userId, status: "pending", notificationCount: 1 },
        { userId, status: "failed", notificationCount: 1 },
        { userId, status: "sent", notificationCount: 1, createdAt: old, sentAt: old },
      ],
    });
    expect(await emailChannelStatus({ prisma })).toMatchObject({ state: "active", sentLast24h: 2 });
    await prisma.emailDelivery.create({ data: { userId, status: "sent", notificationCount: 2, sentAt: new Date() } });
    expect(await emailChannelStatus({ prisma })).toMatchObject({ state: "limit-reached", sentLast24h: 3 });
  });

  it("the Alerts page gets no provider error; /health gets it masked and no address at all", async () => {
    await reportStatus({ lastError: "Resend 403: You can only send testing emails to your own email address (own***@example.com)", lastErrorAt: new Date() });
    const agent = await signUp();
    const page = await agent.get("/alerts/email");
    expect(page.body.channel).not.toHaveProperty("lastError");
    const health = await request(app).get("/health");
    expect(health.body.email).toMatchObject({ state: "active", sentLast24h: 0, dailyLimit: 90 });
    expect(JSON.stringify(health.body.email)).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
  });
});

describe("one-click unsubscribe (no sign-in)", () => {
  async function optedIn() {
    const agent = await signUp();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    return (await userRow()).emailUnsubscribeToken;
  }

  it("RFC 8058: a form POST 'List-Unsubscribe=One-Click' to the List-Unsubscribe URL switches e-mail off", async () => {
    const token = await optedIn();
    const res = await request(app).post(`/email/unsubscribe?token=${token}`).type("form").send("List-Unsubscribe=One-Click");
    expect(res.status).toBe(200);
    expect(await userRow()).toMatchObject({ emailAlertsEnabled: false, emailAlertsConsentAt: null });
  });

  it("the site's page posts the token as JSON; repeating it is fine (idempotent)", async () => {
    const token = await optedIn();
    expect((await request(app).post("/email/unsubscribe").send({ token })).body).toMatchObject({ ok: true });
    expect((await request(app).post("/email/unsubscribe").send({ token })).status).toBe(200);
    expect((await userRow()).emailAlertsEnabled).toBe(false);
  });

  it("an unknown or malformed token changes nothing; a GET (link scanner) changes nothing", async () => {
    const token = await optedIn();
    const other = "A".repeat(43);
    expect((await request(app).post("/email/unsubscribe").send({ token: other })).status).toBe(404);
    expect((await request(app).post("/email/unsubscribe").send({ token: "short" })).status).toBe(404);
    expect((await request(app).post("/email/unsubscribe").send({ token: { $ne: null } })).status).toBe(404);
    expect((await request(app).get(`/email/unsubscribe?token=${token}`)).status).toBe(404);
    expect((await userRow()).emailAlertsEnabled).toBe(true);
  });

  it("is rate limited per client", async () => {
    const limited = createTestApp({ email: { limit: { windowMs: 60_000, limit: 2 } } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await request(limited).post("/email/unsubscribe").send({ token: "x" })).status);
    expect(codes).toEqual([404, 404, 429]);
  });
});

describe("ingestion records the map's location note for the e-mails", () => {
  it("an event whose GDACS point and EONET geometry disagree is stored as approximate, others as exact", async () => {
    const flood = (n, extra) => ({
      id: `EONET_${n}`,
      title: `Flood in Testland ${n}`,
      categories: [{ id: "floods", title: "Floods" }],
      sources: [{ id: "GDACS", url: `https://www.gdacs.org/report.aspx?eventtype=FL&eventid=${n}` }],
      geometry: [{ date: "2026-10-11T20:00:00Z", type: "Point", coordinates: [33, 37.8] }],
      ...extra,
    });
    const events = [flood(1, { gdacsPlace: { countries: ["TR"], lat: 41.1, lng: 29 } }), flood(2, { gdacsPlace: { countries: ["TR"], lat: 37.81, lng: 33.01 } })];
    await ingestOnce({ prisma, fetchNasa: async () => events, fetchUsgs: async () => [], publish: vi.fn(async () => {}), log: { log() {}, warn() {}, error() {} } });
    const rows = await prisma.ingestedEvent.findMany({ orderBy: { eventId: "asc" }, select: { eventId: true, locationPrecision: true } });
    expect(rows).toEqual([
      { eventId: "nasa:EONET_1", locationPrecision: "approximate" },
      { eventId: "nasa:EONET_2", locationPrecision: "exact" },
    ]);
  });
});

describe("double opt-in: the address must be confirmed (registration does not verify it)", () => {
  it("turning e-mail on creates a confirmation token; the settings say it is not confirmed yet", async () => {
    const agent = await signUp();
    const on = await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect(on.body).toMatchObject({ enabled: true, verified: false });
    const u = await userRow();
    expect(u.emailConfirmToken).toMatch(EMAIL_TOKEN);
    expect(u.emailConfirmToken).not.toBe(u.emailUnsubscribeToken);
    expect(JSON.stringify(on.body)).not.toContain(u.emailConfirmToken);
  });

  it("the confirmation link confirms once; the token cannot be reused; a confirmed address needs no new link", async () => {
    const agent = await signUp();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    const { emailConfirmToken: token } = await userRow();
    expect((await request(app).post("/email/confirm").send({ token })).status).toBe(200);
    expect(await userRow()).toMatchObject({ emailConfirmToken: null });
    expect((await userRow()).emailVerifiedAt).toBeInstanceOf(Date);
    expect((await request(app).post("/email/confirm").send({ token })).status).toBe(404);
    expect((await agent.get("/alerts/email")).body).toMatchObject({ verified: true });
    await agent.put("/alerts/email").send({ enabled: false });
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await userRow()).emailConfirmToken).toBeNull();
  });

  it("unknown, malformed or query-string tokens confirm nothing", async () => {
    const agent = await signUp();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    const { emailConfirmToken: token } = await userRow();
    expect((await request(app).post("/email/confirm").send({ token: "B".repeat(43) })).status).toBe(404);
    expect((await request(app).post("/email/confirm").send({ token: [token] })).status).toBe(404);
    expect((await request(app).post(`/email/confirm?token=${token}`)).status).toBe(404);
    expect((await request(app).get(`/email/confirm?token=${token}`)).status).toBe(404);
    expect((await userRow()).emailVerifiedAt).toBeNull();
  });

  it("an ADMIN_EMAILS address confirms only with that account's own session (someone who registered the owner's address first cannot become admin)", async () => {
    // "admin@example.com" is on ADMIN_EMAILS (tests/setup.js); the squatter registered it before the owner
    const squatter = await signUp("admin@example.com");
    await squatter.put("/alerts/email").send({ enabled: true, consent: true });
    const { emailConfirmToken: token } = await userRow("admin@example.com");

    // the owner clicks the link in their inbox: no session, or their own other account's session
    const noSession = await request(app).post("/email/confirm").send({ token });
    expect(noSession.status).toBe(403);
    expect(noSession.body.message).toMatch(/sign in to the account that asked for these e-mails/);
    const other = await signUp("other@example.com");
    expect((await other.post("/email/confirm").send({ token })).status).toBe(403);
    expect(await userRow("admin@example.com")).toMatchObject({ emailVerifiedAt: null, emailConfirmToken: token });
    expect((await squatter.get("/users/me")).body.user.role).toBe("user");

    // with the account's own session (whoever knows its password) the same token works
    expect((await squatter.post("/email/confirm").send({ token })).status).toBe(200);
    expect((await squatter.get("/users/me")).body.user.role).toBe("admin");
  });

  it("an address that is not on ADMIN_EMAILS still confirms from the e-mail alone", async () => {
    const agent = await signUp("plain@example.com");
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    const { emailConfirmToken: token } = await userRow("plain@example.com");
    expect((await request(app).post("/email/confirm").send({ token })).status).toBe(200);
    expect((await agent.get("/users/me")).body.user.role).toBe("user");
  });
});

describe("daily limit counting", () => {
  it("counts failed deliveries that reached the provider (a timed-out send may have been accepted), not untried ones", async () => {
    await reportStatus({ dailyLimit: 2 });
    const { id: userId } = await prisma.user.create({ data: { email: "count2@example.com", password: "x" } });
    await prisma.emailDelivery.createMany({
      data: [
        { userId, status: "failed", notificationCount: 1, attempts: 5, lastAttemptAt: new Date() },
        { userId, status: "failed", notificationCount: 1, attempts: 0 },
        { userId, status: "cancelled", notificationCount: 1 },
      ],
    });
    expect(await emailChannelStatus({ prisma })).toMatchObject({ sentLast24h: 1, state: "active" });
  });
});

describe("confirmation status on the Alerts page", () => {
  it("queued until the notification-service picks it up, then the status of the current opt-in's e-mail", async () => {
    const agent = await signUp();
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await agent.get("/alerts/email")).body.confirmation).toEqual({ status: "queued", at: null });
    const u = await userRow();
    await prisma.emailDelivery.create({ data: { userId: u.id, kind: "confirm", status: "failed", notificationCount: 0, attempts: 1 } });
    expect((await agent.get("/alerts/email")).body.confirmation).toMatchObject({ status: "failed" });
    // a new opt-in: the older e-mail does not count for it
    await agent.put("/alerts/email").send({ enabled: false });
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await agent.get("/alerts/email")).body.confirmation).toEqual({ status: "queued", at: null });
  });

  it("an account that is on but unconfirmed without a link gets one on the next 'on'", async () => {
    const agent = await signUp();
    await prisma.user.update({ where: { email: "mail-user@example.com" }, data: { emailAlertsEnabled: true, emailAlertsConsentAt: new Date(), emailUnsubscribeToken: "U".repeat(43) } });
    await agent.put("/alerts/email").send({ enabled: true, consent: true });
    expect((await userRow()).emailConfirmToken).toMatch(EMAIL_TOKEN);
  });
});

