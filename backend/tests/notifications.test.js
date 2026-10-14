import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, registerAgent, prisma } from "./helpers.js";

const app = createTestApp();

let alice;
let bob;
let aliceId;
let bobId;
let aliceSubId;

async function seedNotification(userId, overrides = {}) {
  return prisma.notification.create({
    data: {
      userId,
      eventId: `usgs:ev-${userId}-${Math.random().toString(36).slice(2, 8)}`,
      title: "M5.5 earthquake, near Warsaw",
      type: "earthquake",
      severity: "medium",
      lat: 52.3,
      lng: 21.1,
      distanceKm: 12.4,
      occurredAt: new Date("2026-10-13T10:00:00.000Z"),
      ...overrides,
    },
  });
}

beforeEach(async () => {
  await resetDb();
  alice = (await registerAgent(app, "alice@example.com")).agent;
  bob = (await registerAgent(app, "bob@example.com")).agent;
  aliceId = (await prisma.user.findUnique({ where: { email: "alice@example.com" } })).id;
  bobId = (await prisma.user.findUnique({ where: { email: "bob@example.com" } })).id;
  aliceSubId = (
    await prisma.alertSubscription.create({
      data: { userId: aliceId, label: "Warsaw", centerLat: 52.2297, centerLng: 21.0122, radiusKm: 300 },
    })
  ).id;
});

describe("auth guard", () => {
  it("rejects every /notifications route without a session", async () => {
    expect((await request(app).get("/notifications")).status).toBe(401);
    expect((await request(app).post("/notifications/1/read")).status).toBe(401);
    expect((await request(app).post("/notifications/read-all")).status).toBe(401);
  });
});

describe("GET /notifications", () => {
  it("lists only the caller's notifications, newest first, with unreadCount and the subscription label", async () => {
    const older = await seedNotification(aliceId, { subscriptionId: aliceSubId, createdAt: new Date("2026-10-13T09:00:00Z") });
    const newer = await seedNotification(aliceId, { createdAt: new Date("2026-10-13T11:00:00Z"), readAt: new Date() });
    await seedNotification(bobId);

    const res = await alice.get("/notifications");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.unreadCount).toBe(1);
    expect(res.body.items.map((n) => n.id)).toEqual([newer.id, older.id]);
    expect(res.body.items[1].subscriptionLabel).toBe("Warsaw");
    expect(res.body.items[0].subscriptionLabel).toBeNull();
    expect(res.body.items[1]).toMatchObject({
      eventId: older.eventId,
      title: "M5.5 earthquake, near Warsaw",
      type: "earthquake",
      severity: "medium",
      distanceKm: 12.4,
      readAt: null,
    });

    const bobRes = await bob.get("/notifications");
    expect(bobRes.body.count).toBe(1);
    expect(bobRes.body.unreadCount).toBe(1);
  });

  it("caps the list at 50 but counts every unread one", async () => {
    for (let i = 0; i < 55; i++) await seedNotification(aliceId);
    const res = await alice.get("/notifications");
    expect(res.body.count).toBe(50);
    expect(res.body.unreadCount).toBe(55);
  });
});

describe("POST /notifications/:id/read", () => {
  it("marks own notification as read and returns the new unread count", async () => {
    const n1 = await seedNotification(aliceId);
    await seedNotification(aliceId);

    const res = await alice.post(`/notifications/${n1.id}/read`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, id: n1.id, unreadCount: 1 });

    const row = await prisma.notification.findUnique({ where: { id: n1.id } });
    expect(row.readAt).not.toBeNull();
  });

  it("is idempotent for an already-read notification", async () => {
    const n = await seedNotification(aliceId, { readAt: new Date("2026-10-13T10:30:00Z") });
    const res = await alice.post(`/notifications/${n.id}/read`);
    expect(res.status).toBe(200);
    const row = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(row.readAt.toISOString()).toBe("2026-10-13T10:30:00.000Z"); // unchanged
  });

  it("returns 404 for another user's notification and leaves it unread", async () => {
    const n = await seedNotification(bobId);
    const res = await alice.post(`/notifications/${n.id}/read`);
    expect(res.status).toBe(404);
    const row = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(row.readAt).toBeNull();
  });

  it("returns 404 for unknown or non-numeric ids", async () => {
    expect((await alice.post("/notifications/999999/read")).status).toBe(404);
    expect((await alice.post("/notifications/abc/read")).status).toBe(404);
  });
});

describe("POST /notifications/read-all", () => {
  it("marks only the caller's unread notifications", async () => {
    await seedNotification(aliceId);
    await seedNotification(aliceId);
    await seedNotification(aliceId, { readAt: new Date() });
    const bobs = await seedNotification(bobId);

    const res = await alice.post("/notifications/read-all");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, marked: 2, unreadCount: 0 });

    expect(await prisma.notification.count({ where: { userId: aliceId, readAt: null } })).toBe(0);
    expect((await prisma.notification.findUnique({ where: { id: bobs.id } })).readAt).toBeNull();
  });
});

describe("cascade and SetNull", () => {
  it("deleting a subscription keeps the notification but clears subscriptionId", async () => {
    const n = await seedNotification(aliceId, { subscriptionId: aliceSubId });
    await prisma.alertSubscription.delete({ where: { id: aliceSubId } });
    const row = await prisma.notification.findUnique({ where: { id: n.id } });
    expect(row).not.toBeNull();
    expect(row.subscriptionId).toBeNull();
  });

  it("deleting the user removes their notifications", async () => {
    await seedNotification(aliceId);
    await prisma.user.delete({ where: { id: aliceId } });
    expect(await prisma.notification.count({ where: { userId: aliceId } })).toBe(0);
  });

  it("the same event cannot be stored twice for one user", async () => {
    await seedNotification(aliceId, { eventId: "usgs:dup" });
    await expect(seedNotification(aliceId, { eventId: "usgs:dup" })).rejects.toThrow();
    await expect(seedNotification(bobId, { eventId: "usgs:dup" })).resolves.toBeTruthy();
  });
});
