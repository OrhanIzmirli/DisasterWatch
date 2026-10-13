import { describe, it, expect, vi } from "vitest";
import { createMessageHandler } from "../src/handler.js";

const NOW = new Date("2026-10-13T12:00:00.000Z");
const hoursAgo = (h) => new Date(NOW.getTime() - h * 3600 * 1000).toISOString();

const WARSAW = {
  id: 1,
  userId: 10,
  type: "any",
  minSeverity: "medium",
  label: "Warsaw",
  centerLat: 52.2297,
  centerLng: 21.0122,
  radiusKm: 300,
  active: true,
  createdAt: hoursAgo(24 * 7),
};

const EVENT = {
  v: 1,
  eventId: "usgs:abc123",
  source: "usgs",
  type: "earthquake",
  severity: "high",
  title: "M6.1 earthquake, near Warsaw",
  lat: 52.3,
  lng: 21.1,
  occurredAt: hoursAgo(1),
};

const quietLog = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function makeHandler(overrides = {}) {
  const deps = {
    loadSubscriptions: vi.fn(async () => [WARSAW]),
    insertNotifications: vi.fn(async (rows) => rows.length),
    log: quietLog,
    now: () => NOW,
    ...overrides,
  };
  return { handle: createMessageHandler(deps), deps };
}

describe("message handler", () => {
  it("creates notifications for a valid matching event", async () => {
    const { handle, deps } = makeHandler();
    const result = await handle(JSON.stringify(EVENT));

    expect(result).toEqual({ status: "processed", eventId: "usgs:abc123", matches: 1, inserted: 1 });
    expect(deps.insertNotifications).toHaveBeenCalledTimes(1);
    const rows = deps.insertNotifications.mock.calls[0][0];
    expect(rows[0]).toMatchObject({ userId: 10, subscriptionId: 1, eventId: "usgs:abc123", severity: "high" });
  });

  it("skips non-JSON without touching the database", async () => {
    const { handle, deps } = makeHandler();
    expect(await handle("not json")).toEqual({ status: "invalid", reason: "not-json" });
    expect(deps.loadSubscriptions).not.toHaveBeenCalled();
    expect(deps.insertNotifications).not.toHaveBeenCalled();
  });

  it("skips a message that violates the contract", async () => {
    const { handle, deps } = makeHandler();
    const bad = { ...EVENT, severity: "catastrophic" };
    expect(await handle(JSON.stringify(bad))).toEqual({ status: "invalid", reason: "contract" });
    expect(deps.loadSubscriptions).not.toHaveBeenCalled();

    const wrongVersion = { ...EVENT, v: 2 };
    expect((await handle(JSON.stringify(wrongVersion))).status).toBe("invalid");
  });

  it("does not insert when nothing matches", async () => {
    const { handle, deps } = makeHandler({
      loadSubscriptions: vi.fn(async () => [{ ...WARSAW, active: false }]),
    });
    const result = await handle(JSON.stringify(EVENT));
    expect(result).toMatchObject({ status: "processed", matches: 0, inserted: 0 });
    expect(deps.insertNotifications).not.toHaveBeenCalled();
  });

  it("propagates database errors so the message is retried", async () => {
    const { handle } = makeHandler({
      loadSubscriptions: vi.fn(async () => {
        throw new Error("connection refused");
      }),
    });
    await expect(handle(JSON.stringify(EVENT))).rejects.toThrow("connection refused");
  });

  it("reports the number actually inserted (duplicates ignored by the DB)", async () => {
    const { handle } = makeHandler({ insertNotifications: vi.fn(async () => 0) });
    const result = await handle(JSON.stringify(EVENT));
    expect(result).toMatchObject({ matches: 1, inserted: 0 });
  });

  it("(d) at-least-once: the same event delivered twice yields one notification", async () => {
    // Simulates the DB's ON CONFLICT (userId, eventId) DO NOTHING: the second
    // insert of the same (user, event) pair inserts nothing.
    const stored = new Set();
    const insertNotifications = vi.fn(async (rows) => {
      let inserted = 0;
      for (const r of rows) {
        const key = `${r.userId}:${r.eventId}`;
        if (!stored.has(key)) {
          stored.add(key);
          inserted += 1;
        }
      }
      return inserted;
    });
    const { handle } = makeHandler({ insertNotifications });

    const first = await handle(JSON.stringify(EVENT));
    const second = await handle(JSON.stringify(EVENT));
    expect(first).toMatchObject({ status: "processed", matches: 1, inserted: 1 });
    expect(second).toMatchObject({ status: "processed", matches: 1, inserted: 0 });
    expect(stored.size).toBe(1);
  });
});
