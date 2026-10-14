import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import request from "supertest";

// Never touch a real broker from tests
vi.mock("../src/services/kafkaProducer.js", () => ({
  producer: { connect: vi.fn(), disconnect: vi.fn() },
  initProducer: vi.fn(async () => {}),
  publishDisasterEvent: vi.fn(async () => {}),
  producerStatus: vi.fn(() => "disconnected"),
}));

const { createTestApp, resetDb, registerAgent, sessionCookie, prisma, PASSWORD, COOKIE_NAME } = await import("./helpers.js");
const { maskEmail } = await import("../src/utils/audit.js");

const app = createTestApp();

const ADMIN = "admin@example.com"; // listed in ADMIN_EMAILS by tests/setup.js
const ALICE = "alice@example.com";
const BOB = "bob@example.com";

let admin; // cookie-carrying agent
let alice;
let aliceId;
let bobId;

async function idOf(email) {
  return (await prisma.user.findUnique({ where: { email }, select: { id: true } })).id;
}

const SUBSCRIPTION = { label: "Home", type: "any", minSeverity: "low", centerLat: 41, centerLng: 29, radiusKm: 100 };

beforeEach(async () => {
  await resetDb();
  admin = (await registerAgent(app, ADMIN)).agent;
  alice = (await registerAgent(app, ALICE)).agent;
  await registerAgent(app, BOB);
  aliceId = await idOf(ALICE);
  bobId = await idOf(BOB);
});

afterEach(() => {
  process.env.ADMIN_EMAILS = ADMIN;
});

describe("access control", () => {
  it("rejects anonymous requests with 401", async () => {
    for (const [method, path] of [
      ["get", "/admin/users"],
      ["get", `/admin/users/${aliceId}`],
      ["post", `/admin/users/${aliceId}/disable`],
      ["post", `/admin/users/${aliceId}/enable`],
      ["delete", `/admin/users/${aliceId}`],
      ["get", "/admin/audit"],
    ]) {
      const res = await request(app)[method](path);
      expect(res.status, `${method} ${path}`).toBe(401);
    }
  });

  it("rejects regular users with 403", async () => {
    for (const [method, path] of [
      ["get", "/admin/users"],
      ["get", `/admin/users/${bobId}`],
      ["post", `/admin/users/${bobId}/disable`],
      ["post", `/admin/users/${bobId}/enable`],
      ["delete", `/admin/users/${bobId}`],
      ["get", "/admin/audit"],
    ]) {
      const res = await alice[method](path).send({ confirmEmail: BOB });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.message).toBe("Admin access required");
    }
    expect(await prisma.user.count()).toBe(3);
    expect(await prisma.adminAuditLog.count()).toBe(0);
  });
});

describe("GET /admin/users and /admin/users/:id", () => {
  it("lists users newest first with counts and never the password hash", async () => {
    await alice.post("/alerts").send(SUBSCRIPTION);

    const res = await admin.get("/admin/users");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 3, totalPages: 1 });
    expect(res.body.items.map((u) => u.email)).toEqual([BOB, ALICE, ADMIN]);

    const aliceRow = res.body.items.find((u) => u.email === ALICE);
    expect(aliceRow).toMatchObject({ id: aliceId, role: "user", disabledAt: null, subscriptionCount: 1 });
    expect(aliceRow.lastLoginAt).toBeNull(); // registered, never signed in
    for (const u of res.body.items) {
      expect(u).not.toHaveProperty("password");
      expect(JSON.stringify(u)).not.toMatch(/\$2[aby]\$/); // no bcrypt hash anywhere in the row
    }
  });

  it("filters by e-mail and paginates", async () => {
    const found = await admin.get("/admin/users?q=ali");
    expect(found.body.items.map((u) => u.email)).toEqual([ALICE]);

    const none = await admin.get("/admin/users?q=zzz");
    expect(none.body.items).toEqual([]);

    const page2 = await admin.get("/admin/users?page=2");
    expect(page2.body).toMatchObject({ page: 2, items: [], total: 3 });
  });

  it("returns the detail with subscriptions and the notification count, without the password", async () => {
    await alice.post("/alerts").send(SUBSCRIPTION);
    await prisma.notification.create({
      data: {
        userId: aliceId,
        eventId: "usgs:test1",
        title: "M6.1 earthquake",
        type: "earthquake",
        severity: "high",
        lat: 41,
        lng: 29,
        distanceKm: 3,
        occurredAt: new Date(),
      },
    });

    const res = await admin.get(`/admin/users/${aliceId}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toMatchObject({ id: aliceId, email: ALICE, subscriptionCount: 1, notificationCount: 1 });
    expect(res.body.user.subscriptions).toHaveLength(1);
    expect(res.body.user.subscriptions[0]).toMatchObject({ label: "Home", type: "any", minSeverity: "low", radiusKm: 100, active: true });
    expect(res.body.user).not.toHaveProperty("password");
    expect(JSON.stringify(res.body)).not.toMatch(/\$2[aby]\$/);

    expect((await admin.get("/admin/users/999")).status).toBe(404);
    expect((await admin.get("/admin/users/abc")).status).toBe(400);
  });
});

describe("disable / enable", () => {
  it("ends the user's existing session immediately, blocks sign-in, and enable lets them back in", async () => {
    // alice is signed in with the cookie from registration
    expect((await alice.get("/users/me")).status).toBe(200);

    const res = await admin.post(`/admin/users/${aliceId}/disable`);
    expect(res.status).toBe(200);
    expect(res.body.user.disabledAt).toBeTruthy();

    // same cookie, next request: 401 and the cookie is cleared
    const me = await alice.get("/users/me");
    expect(me.status).toBe(401);
    expect(sessionCookie(me)).toMatch(/^dw_session=;/);

    // correct password, still refused
    const login = await request(app).post("/users/login").send({ email: ALICE, password: PASSWORD });
    expect(login.status).toBe(403);
    expect(login.body.message).toBe("Account disabled");
    expect(sessionCookie(login)).toBeUndefined();

    const enable = await admin.post(`/admin/users/${aliceId}/enable`);
    expect(enable.status).toBe(200);
    expect(enable.body.user.disabledAt).toBeNull();

    const again = await request(app).post("/users/login").send({ email: ALICE, password: PASSWORD });
    expect(again.status).toBe(200);
    expect(sessionCookie(again)).toMatch(new RegExp(`^${COOKIE_NAME}=[^;]+`));
    const row = await prisma.user.findUnique({ where: { id: aliceId } });
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(row.tokenVersion).toBe(1); // bumped once by the disable
  });

  it("refuses to disable yourself or another ADMIN_EMAILS account", async () => {
    const adminId = await idOf(ADMIN);
    const self = await admin.post(`/admin/users/${adminId}/disable`);
    expect(self.status).toBe(403);

    process.env.ADMIN_EMAILS = `${ADMIN}, ${BOB}`; // bob is now an admin by e-mail
    const other = await admin.post(`/admin/users/${bobId}/disable`);
    expect(other.status).toBe(403);

    expect((await prisma.user.findMany({ where: { disabledAt: { not: null } } })).length).toBe(0);
    expect(await prisma.adminAuditLog.count()).toBe(0);
  });

  it("rejects tokens from before a tokenVersion bump even when the account is enabled again", async () => {
    await admin.post(`/admin/users/${aliceId}/disable`);
    await admin.post(`/admin/users/${aliceId}/enable`);
    expect((await alice.get("/users/me")).status).toBe(401); // old cookie stays dead
  });
});

describe("DELETE /admin/users/:id", () => {
  it("needs the matching confirmEmail and removes subscriptions and notifications with the user", async () => {
    await alice.post("/alerts").send(SUBSCRIPTION);
    await prisma.notification.create({
      data: { userId: aliceId, eventId: "usgs:test2", title: "t", type: "flood", severity: "medium", lat: 1, lng: 2, distanceKm: 1, occurredAt: new Date() },
    });

    const wrong = await admin.delete(`/admin/users/${aliceId}`).send({ confirmEmail: "someone-else@example.com" });
    expect(wrong.status).toBe(400);
    const missing = await admin.delete(`/admin/users/${aliceId}`).send({});
    expect(missing.status).toBe(400);
    expect(await prisma.user.count()).toBe(3);

    const ok = await admin.delete(`/admin/users/${aliceId}`).send({ confirmEmail: "Alice@Example.com" });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ ok: true, deletedUserId: aliceId });

    expect(await prisma.user.findUnique({ where: { id: aliceId } })).toBeNull();
    expect(await prisma.alertSubscription.count({ where: { userId: aliceId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: aliceId } })).toBe(0);
    expect((await alice.get("/users/me")).status).toBe(401); // session gone with the account
  });

  it("refuses to delete yourself or another ADMIN_EMAILS account", async () => {
    const adminId = await idOf(ADMIN);
    expect((await admin.delete(`/admin/users/${adminId}`).send({ confirmEmail: ADMIN })).status).toBe(403);

    process.env.ADMIN_EMAILS = `${ADMIN}, ${BOB}`;
    expect((await admin.delete(`/admin/users/${bobId}`).send({ confirmEmail: BOB })).status).toBe(403);
    expect(await prisma.user.count()).toBe(3);
  });
});

describe("audit log", () => {
  it("records every action with actor, action and target; deleted users are masked", async () => {
    await admin.post(`/admin/users/${aliceId}/disable`);
    await admin.post(`/admin/users/${aliceId}/enable`);
    await admin.post("/disasters").send({ type: "flood", title: "Test flood", lat: 1, lng: 2, date: "2026-10-13T10:00:00.000Z", severity: "high" });
    await admin.delete(`/admin/users/${bobId}`).send({ confirmEmail: BOB });

    const adminId = await idOf(ADMIN);
    const res = await admin.get("/admin/audit");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ page: 1, pageSize: 20, total: 4, totalPages: 1 });
    expect(res.body.items.map((r) => r.action)).toEqual(["user.delete", "disaster.create", "user.enable", "user.disable"]);
    for (const r of res.body.items) expect(r).toMatchObject({ actorId: adminId, actorEmail: ADMIN });

    const [del, create, enable, disable] = res.body.items;
    expect(disable).toMatchObject({ targetUserId: aliceId, targetLabel: ALICE, metadata: { previouslyDisabled: false } });
    expect(enable).toMatchObject({ targetUserId: aliceId, targetLabel: ALICE });
    expect(create).toMatchObject({ targetUserId: null, targetLabel: "flood: Test flood", metadata: { type: "flood", severity: "high" } });
    expect(del).toMatchObject({ targetUserId: bobId, targetLabel: "bob***@example.com", metadata: { subscriptionsDeleted: 0, notificationsDeleted: 0 } });
    expect(JSON.stringify(del)).not.toContain(BOB);
  });

  it("exposes at most the last 100 rows, 20 per page", async () => {
    const adminId = await idOf(ADMIN);
    await prisma.adminAuditLog.createMany({
      data: Array.from({ length: 130 }, (_, i) => ({
        actorId: adminId,
        actorEmail: ADMIN,
        action: "user.enable",
        targetUserId: aliceId,
        targetLabel: `row ${i}`,
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, i)), // one minute apart, ascending
      })),
    });

    const p1 = await admin.get("/admin/audit");
    expect(p1.body).toMatchObject({ total: 100, totalPages: 5, pageSize: 20 });
    expect(p1.body.items).toHaveLength(20);
    expect(p1.body.items[0].targetLabel).toBe("row 129"); // newest first

    const p5 = await admin.get("/admin/audit?page=5");
    expect(p5.body.items).toHaveLength(20);
    expect(p5.body.items[19].targetLabel).toBe("row 30"); // the 100th newest row

    const p6 = await admin.get("/admin/audit?page=6");
    expect(p6.body.items).toEqual([]);
  });

  it("does not record a refused action (log and action share a transaction)", async () => {
    await admin.delete(`/admin/users/${aliceId}`).send({ confirmEmail: "wrong@example.com" });
    expect(await prisma.adminAuditLog.count()).toBe(0);
  });
});

describe("maskEmail", () => {
  it.each([
    ["sesame@example.com", "ses***@example.com"],
    ["bob@example.com", "bob***@example.com"],
    ["ab@example.com", "ab***@example.com"],
    ["", ""],
  ])("%s -> %s", (input, expected) => {
    expect(maskEmail(input)).toBe(expected);
  });
});
