import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, registerAgent, sessionCookie, prisma, PASSWORD } from "./helpers.js";

const app = createTestApp();

const SUBSCRIPTION = { type: "flood", minSeverity: "low", label: "Warsaw", centerLat: 52.2297, centerLng: 21.0122, radiusKm: 100 };

/** A notification with an e-mail delivery, as the notification service writes them. */
async function seedMail(email) {
  const user = await prisma.user.findUnique({ where: { email }, include: { subscriptions: true } });
  const delivery = await prisma.emailDelivery.create({
    data: { userId: user.id, kind: "digest", status: "sent", notificationCount: 1, sentAt: new Date(), payload: { to: email, subject: "s", text: "t", html: "<p>t</p>" } },
  });
  await prisma.notification.create({
    data: {
      userId: user.id,
      subscriptionId: user.subscriptions[0]?.id ?? null,
      eventId: `usgs:${email}`,
      title: "M5.0 earthquake",
      type: "earthquake",
      severity: "medium",
      lat: 52,
      lng: 21,
      distanceKm: 20,
      occurredAt: new Date(),
      emailDeliveryId: delivery.id,
      emailSentAt: new Date(),
    },
  });
  return user.id;
}

describe("DELETE /users/me (the user deletes their own account)", () => {
  let alice;
  let aliceId;
  let bobId;

  beforeEach(async () => {
    await resetDb();
    alice = (await registerAgent(app, "alice@example.com")).agent;
    const bob = (await registerAgent(app, "bob@example.com")).agent;
    await alice.post("/alerts").send(SUBSCRIPTION);
    await bob.post("/alerts").send(SUBSCRIPTION);
    aliceId = await seedMail("alice@example.com");
    bobId = await seedMail("bob@example.com");
  });

  it("needs a session", async () => {
    const res = await request(app).delete("/users/me").send({ password: PASSWORD });
    expect(res.status).toBe(401);
    expect(await prisma.user.count()).toBe(2);
  });

  it("needs the password: missing is 400, wrong is 403, and nothing is deleted", async () => {
    expect((await alice.delete("/users/me").send({})).status).toBe(400);
    expect((await alice.delete("/users/me").send({ password: ["x"] })).status).toBe(400);
    const wrong = await alice.delete("/users/me").send({ password: "not-the-password" });
    expect(wrong.status).toBe(403);
    expect(wrong.body.message).toBe("The password is not correct.");
    // still signed in, still there
    expect((await alice.get("/users/me")).status).toBe(200);
    expect(await prisma.user.count({ where: { id: aliceId } })).toBe(1);
  });

  it("deletes the user with their subscriptions, notifications and e-mail records, and ends the session", async () => {
    const res = await alice.delete("/users/me").send({ password: PASSWORD });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, deleted: { subscriptions: 1, notifications: 1, emailDeliveries: 1 } });
    // the session cookie is cleared
    expect(sessionCookie(res)).toMatch(/^dw_session=;/);

    expect(await prisma.user.count({ where: { id: aliceId } })).toBe(0);
    expect(await prisma.alertSubscription.count({ where: { userId: aliceId } })).toBe(0);
    expect(await prisma.notification.count({ where: { userId: aliceId } })).toBe(0);
    expect(await prisma.emailDelivery.count({ where: { userId: aliceId } })).toBe(0);

    // the old cookie is dead, and the address can be registered again
    expect((await alice.get("/users/me")).status).toBe(401);
    expect((await request(app).post("/users/login").send({ email: "alice@example.com", password: PASSWORD })).status).toBe(401);
    expect((await request(app).post("/users/register").send({ email: "alice@example.com", password: PASSWORD })).status).toBe(201);
  });

  it("leaves every other account untouched", async () => {
    await alice.delete("/users/me").send({ password: PASSWORD });
    expect(await prisma.user.count({ where: { id: bobId } })).toBe(1);
    expect(await prisma.alertSubscription.count({ where: { userId: bobId } })).toBe(1);
    expect(await prisma.notification.count({ where: { userId: bobId } })).toBe(1);
    expect(await prisma.emailDelivery.count({ where: { userId: bobId } })).toBe(1);
  });

  it("answers 401 when the account was deleted meanwhile (second tab, admin)", async () => {
    await prisma.user.delete({ where: { id: aliceId } });
    expect((await alice.delete("/users/me").send({ password: PASSWORD })).status).toBe(401);
  });

  it("is rate limited like sign-in (10 attempts per 15 minutes)", async () => {
    const limited = createTestApp({ authRateLimit: { windowMs: 60_000, limit: 2 } });
    const agent = request.agent(limited);
    await agent.post("/users/login").send({ email: "alice@example.com", password: PASSWORD });
    expect((await agent.delete("/users/me").send({ password: "wrong-1" })).status).toBe(403);
    expect((await agent.delete("/users/me").send({ password: "wrong-2" })).status).toBe(429);
  });
});

describe("deleting an account leaves only masked addresses in the admin log", () => {
  it("masks the address in earlier disable/enable rows, for self-deletion and admin deletion", async () => {
    await resetDb();
    const { confirmAddress } = await import("./helpers.js");
    const admin = (await registerAgent(app, "admin@example.com")).agent;
    await confirmAddress("admin@example.com");
    const carol = (await registerAgent(app, "carol@example.com")).agent;
    await registerAgent(app, "dave@example.com");
    const ids = Object.fromEntries((await prisma.user.findMany()).map((u) => [u.email, u.id]));

    for (const who of ["carol@example.com", "dave@example.com"]) {
      await admin.post(`/admin/users/${ids[who]}/disable`);
      await admin.post(`/admin/users/${ids[who]}/enable`);
    }
    expect(await prisma.adminAuditLog.count({ where: { targetLabel: "carol@example.com" } })).toBe(2);

    // carol's old cookie died with the disable; she signs in again and deletes herself
    await carol.post("/users/login").send({ email: "carol@example.com", password: PASSWORD });
    expect((await carol.delete("/users/me").send({ password: PASSWORD })).status).toBe(200);
    expect((await admin.delete(`/admin/users/${ids["dave@example.com"]}`).send({ confirmEmail: "dave@example.com" })).status).toBe(200);

    const labels = (await prisma.adminAuditLog.findMany({ orderBy: { id: "asc" } })).map((r) => r.targetLabel);
    expect(labels).toEqual(["car***@example.com", "car***@example.com", "dav***@example.com", "dav***@example.com", "dav***@example.com"]);
    expect(await prisma.adminAuditLog.count({ where: { OR: [{ targetLabel: { contains: "carol@" } }, { targetLabel: { contains: "dave@" } }] } })).toBe(0);
  });
});
