import { describe, it, expect, beforeEach, vi } from "vitest";
import request from "supertest";

// Never touch a real broker from tests: replace the Kafka module before app.js loads it.
vi.mock("../src/services/kafkaProducer.js", () => ({
  producer: { connect: vi.fn(), disconnect: vi.fn() },
  initProducer: vi.fn(async () => {}),
  publishDisasterEvent: vi.fn(async () => {}),
}));

const { publishDisasterEvent } = await import("../src/services/kafkaProducer.js");
const { createTestApp, resetDb, registerAgent, prisma } = await import("./helpers.js");

const app = createTestApp();

const DISASTER = {
  type: "flood",
  title: "Test flood",
  lat: 52.1,
  lng: 21.0,
  date: "2026-10-13T10:00:00.000Z",
  severity: "high",
  description: "Created by the admin test",
};

let admin;
let user;

beforeEach(async () => {
  await resetDb();
  vi.clearAllMocks();
  admin = (await registerAgent(app, "admin@example.com")).agent; // listed in ADMIN_EMAILS
  user = (await registerAgent(app, "user@example.com")).agent;
});

describe("POST /disasters (manual entry)", () => {
  it("returns 401 without a session", async () => {
    const res = await request(app).post("/disasters").send(DISASTER);
    expect(res.status).toBe(401);
  });

  it("returns 403 for a regular user", async () => {
    const res = await user.post("/disasters").send(DISASTER);
    expect(res.status).toBe(403);
    expect(res.body.message).toBe("Admin access required");
    expect(await prisma.disaster.count()).toBe(0);
  });

  it("returns 201 for an admin, stores the row with createdBy and does not publish to Kafka", async () => {
    const res = await admin.post("/disasters").send(DISASTER);
    expect(res.status).toBe(201);
    expect(publishDisasterEvent).not.toHaveBeenCalled(); // manual entries get a verification step first
    expect(res.body.disaster).toMatchObject({
      type: "flood",
      title: "Test flood",
      severity: "high",
      description: "Created by the admin test",
      createdBy: "admin@example.com",
    });

    const row = await prisma.disaster.findUnique({ where: { id: res.body.disaster.id } });
    expect(row.date.toISOString()).toBe(DISASTER.date);
  });

  it("returns 400 for an invalid body or an unparseable date", async () => {
    const missing = await admin.post("/disasters").send({ type: "flood" });
    expect(missing.status).toBe(400);

    const badLat = await admin.post("/disasters").send({ ...DISASTER, lat: 123 });
    expect(badLat.status).toBe(400);

    const badDate = await admin.post("/disasters").send({ ...DISASTER, date: "yesterday" });
    expect(badDate.status).toBe(400);

    expect(await prisma.disaster.count()).toBe(0);
  });
});

describe("GET /disasters/manual", () => {
  it("requires a session", async () => {
    expect((await request(app).get("/disasters/manual")).status).toBe(401);
  });

  it("lists DB rows newest first for any signed-in user", async () => {
    await admin.post("/disasters").send({ ...DISASTER, title: "First" });
    await admin.post("/disasters").send({ ...DISASTER, title: "Second" });

    const res = await user.get("/disasters/manual");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("DB");
    expect(res.body.count).toBe(2);
    expect(res.body.items.map((d) => d.title)).toEqual(["Second", "First"]);
  });
});

describe("POST /events (Kafka publish)", () => {
  const EVENT = {
    v: 1,
    eventId: "manual:test-1",
    source: "manual",
    type: "earthquake",
    severity: "high",
    title: "Test quake",
    lat: 1,
    lng: 2,
    occurredAt: "2026-10-13T10:00:00.000Z",
  };

  it("returns 401 without a session and does not publish", async () => {
    const res = await request(app).post("/events").send(EVENT);
    expect(res.status).toBe(401);
    expect(publishDisasterEvent).not.toHaveBeenCalled();
  });

  it("returns 403 for a regular user and does not publish", async () => {
    const res = await user.post("/events").send(EVENT);
    expect(res.status).toBe(403);
    expect(res.body.error).toBe("Admin access required");
    expect(publishDisasterEvent).not.toHaveBeenCalled();
  });

  it("publishes the body for an admin", async () => {
    const res = await admin.post("/events").send(EVENT);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, published: true, event: EVENT });
    expect(publishDisasterEvent).toHaveBeenCalledTimes(1);
    expect(publishDisasterEvent).toHaveBeenCalledWith(EVENT);
  });

  it("returns 400 for an empty body", async () => {
    const res = await admin.post("/events").send({});
    expect(res.status).toBe(400);
    expect(publishDisasterEvent).not.toHaveBeenCalled();
  });

  it.each([
    ["missing version", { ...EVENT, v: undefined }, /v/],
    ["wrong version", { ...EVENT, v: 2 }, /v/],
    ["eventId without source prefix", { ...EVENT, eventId: "test-1" }, /eventId/],
    ["unknown source", { ...EVENT, source: "twitter" }, /source/],
    ["unknown severity", { ...EVENT, severity: "catastrophic" }, /severity/],
    ["latitude out of range", { ...EVENT, lat: 91 }, /lat/],
    ["occurredAt not ISO", { ...EVENT, occurredAt: "yesterday" }, /occurredAt/],
    ["empty title", { ...EVENT, title: "  " }, /title/],
  ])("returns 400 for %s and does not publish", async (_name, body, field) => {
    const res = await admin.post("/events").send(body);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(field);
    expect(publishDisasterEvent).not.toHaveBeenCalled();
  });

  it("normalises the type to lower case before publishing", async () => {
    const res = await admin.post("/events").send({ ...EVENT, type: "Earthquake" });
    expect(res.status).toBe(200);
    expect(publishDisasterEvent).toHaveBeenCalledWith({ ...EVENT, type: "earthquake" });
  });

  it("returns 500 when publishing fails", async () => {
    publishDisasterEvent.mockRejectedValueOnce(new Error("broker down"));
    const res = await admin.post("/events").send(EVENT);
    expect(res.status).toBe(500);
    expect(res.body.ok).toBe(false);
  });
});
