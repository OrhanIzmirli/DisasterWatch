import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, registerAgent, prisma } from "./helpers.js";

const app = createTestApp();

const VALID = {
  type: "earthquake",
  minSeverity: "medium",
  label: "Warsaw",
  centerLat: 52.2297,
  centerLng: 21.0122,
  radiusKm: 300,
};

let alice;
let bob;

beforeEach(async () => {
  await resetDb();
  alice = (await registerAgent(app, "alice@example.com")).agent;
  bob = (await registerAgent(app, "bob@example.com")).agent;
});

describe("auth guard", () => {
  it("rejects every /alerts route without a session", async () => {
    expect((await request(app).get("/alerts")).status).toBe(401);
    expect((await request(app).post("/alerts").send(VALID)).status).toBe(401);
    expect((await request(app).patch("/alerts/1").send({ active: false })).status).toBe(401);
    expect((await request(app).delete("/alerts/1")).status).toBe(401);
  });
});

describe("create and list", () => {
  it("creates a subscription for the signed-in user and lists it", async () => {
    const created = await alice.post("/alerts").send(VALID);
    expect(created.status).toBe(201);
    expect(created.body.subscription).toMatchObject({ ...VALID, active: true });

    const list = await alice.get("/alerts");
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);
    expect(list.body.items[0].id).toBe(created.body.subscription.id);

    const row = await prisma.alertSubscription.findUnique({
      where: { id: created.body.subscription.id },
      include: { user: true },
    });
    expect(row.user.email).toBe("alice@example.com");
  });

  it("applies defaults: type=any, minSeverity=low, active=true", async () => {
    const res = await alice.post("/alerts").send({
      label: "Anywhere",
      centerLat: 0,
      centerLng: 0,
      radiusKm: 100,
    });
    expect(res.status).toBe(201);
    expect(res.body.subscription).toMatchObject({
      type: "any",
      minSeverity: "low",
      active: true,
    });
  });

  it("only lists the caller's own subscriptions", async () => {
    await alice.post("/alerts").send(VALID);
    await alice.post("/alerts").send({ ...VALID, label: "Second" });
    await bob.post("/alerts").send({ ...VALID, label: "Bob's" });

    expect((await alice.get("/alerts")).body.count).toBe(2);
    const bobList = await bob.get("/alerts");
    expect(bobList.body.count).toBe(1);
    expect(bobList.body.items[0].label).toBe("Bob's");
  });

  it("is reflected in /users/me subscriptionCount", async () => {
    await alice.post("/alerts").send(VALID);
    await alice.post("/alerts").send(VALID);
    expect((await alice.get("/users/me")).body.user.subscriptionCount).toBe(2);
    expect((await bob.get("/users/me")).body.user.subscriptionCount).toBe(0);
  });

  it("rejects the 21st subscription with 400", async () => {
    for (let i = 1; i <= 20; i++) {
      const res = await alice.post("/alerts").send({ ...VALID, label: `Sub ${i}` });
      expect(res.status, `subscription ${i}`).toBe(201);
    }

    const extra = await alice.post("/alerts").send({ ...VALID, label: "Sub 21" });
    expect(extra.status).toBe(400);
    expect(extra.body.message).toMatch(/at most 20/i);
    expect(await prisma.alertSubscription.count()).toBe(20);

    // The limit is per user, not global
    expect((await bob.post("/alerts").send(VALID)).status).toBe(201);
  });
});

describe("validation", () => {
  const cases = [
    ["unknown type", { ...VALID, type: "volcano" }, /type/],
    ["unknown minSeverity", { ...VALID, minSeverity: "extreme" }, /minSeverity/],
    ["empty label", { ...VALID, label: "   " }, /label/],
    ["label over 60 chars", { ...VALID, label: "x".repeat(61) }, /label/],
    ["lat below -90", { ...VALID, centerLat: -90.5 }, /centerLat/],
    ["lat above 90", { ...VALID, centerLat: 91 }, /centerLat/],
    ["lng above 180", { ...VALID, centerLng: 180.1 }, /centerLng/],
    ["radius below 10", { ...VALID, radiusKm: 9 }, /radiusKm/],
    ["radius above 5000", { ...VALID, radiusKm: 5001 }, /radiusKm/],
    ["non-integer radius", { ...VALID, radiusKm: 12.5 }, /radiusKm/],
    ["lat as string", { ...VALID, centerLat: "52.2" }, /centerLat/],
    ["missing label", { ...VALID, label: undefined }, /label/],
  ];

  it.each(cases)("returns 400 for %s", async (_name, body, pattern) => {
    const res = await alice.post("/alerts").send(body);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(pattern);
    expect(await prisma.alertSubscription.count()).toBe(0);
  });

  it("returns 400 for a PATCH with no fields", async () => {
    const { body } = await alice.post("/alerts").send(VALID);
    const res = await alice.patch(`/alerts/${body.subscription.id}`).send({});
    expect(res.status).toBe(400);
  });

  it("returns 400 for a PATCH with an invalid field", async () => {
    const { body } = await alice.post("/alerts").send(VALID);
    const res = await alice.patch(`/alerts/${body.subscription.id}`).send({ radiusKm: 1 });
    expect(res.status).toBe(400);
  });
});

describe("update and delete", () => {
  let id;

  beforeEach(async () => {
    const { body } = await alice.post("/alerts").send(VALID);
    id = body.subscription.id;
  });

  it("updates own subscription fields", async () => {
    const res = await alice
      .patch(`/alerts/${id}`)
      .send({ active: false, radiusKm: 500, label: "Warsaw wide", type: "any" });
    expect(res.status).toBe(200);
    expect(res.body.subscription).toMatchObject({
      id,
      active: false,
      radiusKm: 500,
      label: "Warsaw wide",
      type: "any",
    });

    const row = await prisma.alertSubscription.findUnique({ where: { id } });
    expect(row.active).toBe(false);
    expect(row.radiusKm).toBe(500);
  });

  it("deletes own subscription", async () => {
    const res = await alice.delete(`/alerts/${id}`);
    expect(res.status).toBe(200);
    expect(await prisma.alertSubscription.findUnique({ where: { id } })).toBeNull();

    const again = await alice.delete(`/alerts/${id}`);
    expect(again.status).toBe(404);
  });

  it("returns 404 (not 403) when another user tries to update or delete it", async () => {
    const patch = await bob.patch(`/alerts/${id}`).send({ active: false });
    expect(patch.status).toBe(404);

    const del = await bob.delete(`/alerts/${id}`);
    expect(del.status).toBe(404);

    // Untouched
    const row = await prisma.alertSubscription.findUnique({ where: { id } });
    expect(row).not.toBeNull();
    expect(row.active).toBe(true);
  });

  it("returns 404 for ids that do not exist or are not numeric", async () => {
    expect((await alice.patch("/alerts/999999").send({ active: false })).status).toBe(404);
    expect((await alice.delete("/alerts/999999")).status).toBe(404);
    expect((await alice.delete("/alerts/abc")).status).toBe(404);
  });
});

describe("cascade", () => {
  it("removes subscriptions when the user is deleted", async () => {
    await alice.post("/alerts").send(VALID);
    await alice.post("/alerts").send(VALID);
    expect(await prisma.alertSubscription.count()).toBe(2);

    await prisma.user.delete({ where: { email: "alice@example.com" } });
    expect(await prisma.alertSubscription.count()).toBe(0);
  });
});
