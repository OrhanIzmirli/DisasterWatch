import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, prisma } from "./helpers.js";
import { ingestOnce, recordNewEvents, publishOutbox, countPendingOutbox } from "../src/jobs/ingest.js";
import { nasaEventsToContract, usgsFeaturesToContract } from "../src/events/mappers.js";

// ---- fixtures shaped like the real feeds ----
const NASA_RAW = [
  {
    id: "EONET_1001",
    title: "Wildfire in Botswana 1032764",
    categories: [{ title: "Wildfires" }],
    geometry: [{ date: "2026-10-11T19:00:00Z", type: "Point", coordinates: [25.2047, -18.2436] }],
  },
  {
    id: "EONET_1002",
    title: "Flood in Thailand 1104169",
    categories: [{ title: "Floods" }],
    // swapped [lat, lng] as EONET sometimes delivers for polygons
    geometry: [{ date: "2026-10-04T20:00:00Z", type: "Point", coordinates: [17.7858, 97.7421] }],
  },
  {
    id: "EONET_1003",
    title: "Iceberg A23a",
    categories: [{ title: "Sea and Lake Ice" }], // not a type we track
    geometry: [{ date: "2026-10-01T00:00:00Z", type: "Point", coordinates: [-40, -60] }],
  },
];

const USGS_RAW = [
  {
    id: "us6000u25i",
    properties: { mag: 4.8, place: "0 km SW of Aratoca, Colombia", time: 1791754460893 },
    geometry: { coordinates: [-73.0229, 6.691, 150] },
  },
  {
    id: "ak026tiny",
    properties: { mag: 1.2, place: "Alaska", time: 1791754460893 }, // below the 4.5 threshold
    geometry: { coordinates: [-150, 61, 10] },
  },
];

const quiet = { log: vi.fn(), error: vi.fn(), warn: vi.fn() };

function deps(overrides = {}) {
  return {
    fetchNasa: vi.fn(async () => NASA_RAW),
    fetchUsgs: vi.fn(async () => USGS_RAW),
    publish: vi.fn(async () => {}),
    log: quiet,
    ...overrides,
  };
}

/** Insert n synthetic unpublished rows, oldest first. */
async function seedOutbox(n, prefix = "usgs:seed") {
  const events = [];
  for (let i = 0; i < n; i++) {
    events.push({
      eventId: `${prefix}-${String(i).padStart(3, "0")}`,
      source: "usgs",
      type: "earthquake",
      severity: "low",
      title: `Seed ${i}`,
      lat: 1,
      lng: 2,
      occurredAt: "2026-10-13T10:00:00.000Z",
    });
  }
  await recordNewEvents(events, { prisma });
  return events;
}

const publishedIds = async () =>
  (await prisma.ingestedEvent.findMany({ where: { publishedAt: { not: null } }, select: { eventId: true } }))
    .map((r) => r.eventId)
    .sort();

beforeEach(resetDb);

describe("mappers", () => {
  it("maps NASA events to the contract with stable ids and fixes swapped coordinates", () => {
    const { events, dropped } = nasaEventsToContract(NASA_RAW);
    expect(dropped).toBe(0);
    expect(events.map((e) => e.eventId)).toEqual(["nasa:EONET_1001", "nasa:EONET_1002"]);
    expect(events[0]).toMatchObject({ source: "nasa", type: "wildfire", severity: "high", lat: -18.2436, lng: 25.2047 });
    expect(events[1]).toMatchObject({ type: "flood", lat: 17.7858, lng: 97.7421 });
    // notification titles carry no EONET source id, same as the feed and news cards
    expect(events.map((e) => e.title)).toEqual(["Wildfire in Botswana", "Flood in Thailand"]);
  });

  it("maps USGS features above the magnitude threshold", () => {
    const { events } = usgsFeaturesToContract(USGS_RAW, { minMag: 4.5 });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      eventId: "usgs:us6000u25i",
      source: "usgs",
      type: "earthquake",
      severity: "low",
      lat: 6.691,
      lng: -73.0229,
    });
    expect(events[0].title).toMatch(/^M4\.8 earthquake, /);
  });
});

describe("recordNewEvents", () => {
  it("returns only rows that were newly inserted, all unpublished", async () => {
    const { events } = nasaEventsToContract(NASA_RAW);
    const first = await recordNewEvents(events, { prisma });
    expect(first.map((e) => e.eventId)).toEqual(["nasa:EONET_1001", "nasa:EONET_1002"]);

    const again = await recordNewEvents(events, { prisma });
    expect(again).toEqual([]);

    const extra = { ...events[0], eventId: "nasa:EONET_9999" };
    const mixed = await recordNewEvents([...events, extra], { prisma });
    expect(mixed.map((e) => e.eventId)).toEqual(["nasa:EONET_9999"]);

    expect(await prisma.ingestedEvent.count()).toBe(3);
    expect(await countPendingOutbox({ prisma })).toBe(3);
  });
});

describe("publishOutbox", () => {
  it("(a) leaves rows unpublished when Kafka fails and publishes them on the next run", async () => {
    await seedOutbox(3);
    const publish = vi.fn(async () => {
      throw new Error("broker down");
    });

    const failed = await publishOutbox({ prisma, publish, log: quiet });
    expect(failed).toEqual({ published: 0, pending: 3, error: "broker down" });
    expect(await publishedIds()).toEqual([]);

    publish.mockImplementation(async () => {});
    const retried = await publishOutbox({ prisma, publish, log: quiet });
    expect(retried).toEqual({ published: 3, pending: 0, error: null });
    expect(await publishedIds()).toHaveLength(3);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0].map((e) => e.eventId)).toEqual([
      "usgs:seed-000",
      "usgs:seed-001",
      "usgs:seed-002",
    ]);
  });

  it("(b) never publishes an already published event again", async () => {
    await seedOutbox(2);
    const publish = vi.fn(async () => {});

    await publishOutbox({ prisma, publish, log: quiet });
    const second = await publishOutbox({ prisma, publish, log: quiet });
    expect(second).toEqual({ published: 0, pending: 0, error: null });
    expect(publish).toHaveBeenCalledTimes(1);

    // a new row later is published alone
    await seedOutbox(1, "usgs:late");
    const third = await publishOutbox({ prisma, publish, log: quiet });
    expect(third.published).toBe(1);
    expect(publish.mock.calls[1][0].map((e) => e.eventId)).toEqual(["usgs:late-000"]);
  });

  it("(c) on a mid-batch failure the sent chunks are marked and the rest stay pending", async () => {
    await seedOutbox(120);
    let calls = 0;
    const publish = vi.fn(async () => {
      calls += 1;
      if (calls === 3) throw new Error("timeout");
    });

    const result = await publishOutbox({ prisma, publish, chunkSize: 50, log: quiet });
    expect(result).toEqual({ published: 100, pending: 20, error: "timeout" });

    const marked = await publishedIds();
    expect(marked).toHaveLength(100);
    expect(marked[0]).toBe("usgs:seed-000");
    expect(marked[99]).toBe("usgs:seed-099");

    const pending = await prisma.ingestedEvent.findMany({ where: { publishedAt: null }, orderBy: { id: "asc" } });
    expect(pending.map((r) => r.eventId)).toEqual(
      Array.from({ length: 20 }, (_, i) => `usgs:seed-${String(100 + i).padStart(3, "0")}`)
    );

    // next run picks up exactly the 20 that were left
    publish.mockImplementation(async () => {});
    const next = await publishOutbox({ prisma, publish, chunkSize: 50, log: quiet });
    expect(next).toEqual({ published: 20, pending: 0, error: null });
  });

  it("caps a run at `batch` rows, oldest first, and reports the rest as pending", async () => {
    await seedOutbox(7);
    const publish = vi.fn(async () => {});
    const result = await publishOutbox({ prisma, publish, batch: 5, log: quiet });
    expect(result).toEqual({ published: 5, pending: 2, error: null });
    expect(publish.mock.calls[0][0].map((e) => e.eventId)).toEqual([
      "usgs:seed-000",
      "usgs:seed-001",
      "usgs:seed-002",
      "usgs:seed-003",
      "usgs:seed-004",
    ]);
  });

  it("publishes contract-shaped messages built from the stored rows", async () => {
    await seedOutbox(1);
    const publish = vi.fn(async () => {});
    await publishOutbox({ prisma, publish, log: quiet });
    expect(publish.mock.calls[0][0][0]).toEqual({
      v: 1,
      eventId: "usgs:seed-000",
      source: "usgs",
      type: "earthquake",
      severity: "low",
      title: "Seed 0",
      lat: 1,
      lng: 2,
      occurredAt: "2026-10-13T10:00:00.000Z",
    });
  });
});

describe("ingestOnce", () => {
  it("records and publishes each event exactly once across runs (dedupe)", async () => {
    const d = deps();

    const first = await ingestOnce({ prisma, ...d });
    expect(first).toMatchObject({ fetched: 3, inserted: 3, published: 3, pending: 0, errors: [] });
    expect(d.publish).toHaveBeenCalledTimes(1);
    const ids = d.publish.mock.calls[0][0].map((e) => e.eventId).sort();
    expect(ids).toEqual(["nasa:EONET_1001", "nasa:EONET_1002", "usgs:us6000u25i"]);

    const second = await ingestOnce({ prisma, ...d });
    expect(second).toMatchObject({ fetched: 3, inserted: 0, published: 0, pending: 0 });
    expect(d.publish).toHaveBeenCalledTimes(1); // nothing pending -> no publish call

    expect(await prisma.ingestedEvent.count()).toBe(3);
  });

  it("publishes only the new events when a feed grows", async () => {
    const d = deps();
    await ingestOnce({ prisma, ...d });

    const newQuake = {
      id: "us7000new1",
      properties: { mag: 6.2, place: "near Tokyo", time: 1791760000000 },
      geometry: { coordinates: [139.7, 35.7, 30] },
    };
    d.fetchUsgs.mockResolvedValueOnce([...USGS_RAW, newQuake]);

    const stats = await ingestOnce({ prisma, ...d });
    expect(stats).toMatchObject({ inserted: 1, published: 1 });
    expect(d.publish.mock.calls[1][0].map((e) => e.eventId)).toEqual(["usgs:us7000new1"]);
  });

  it("keeps going when one source fails", async () => {
    const d = deps({ fetchNasa: vi.fn(async () => { throw new Error("EONET 503"); }) });
    const stats = await ingestOnce({ prisma, ...d });
    expect(stats.errors).toEqual(["nasa: EONET 503"]);
    expect(stats).toMatchObject({ fetched: 1, inserted: 1, published: 1 });
  });

  it("keeps a failed publish in the outbox and drains it on the next run, even with nothing new fetched", async () => {
    const d = deps({ publish: vi.fn(async () => { throw new Error("broker down"); }) });
    const stats = await ingestOnce({ prisma, ...d });
    expect(stats).toMatchObject({ inserted: 3, published: 0, pending: 3 });
    expect(stats.errors).toEqual(["publish: broker down"]);

    const d2 = deps({ fetchNasa: vi.fn(async () => []), fetchUsgs: vi.fn(async () => []) });
    const next = await ingestOnce({ prisma, ...d2 });
    expect(next).toMatchObject({ fetched: 0, inserted: 0, published: 3, pending: 0, errors: [] });
    expect(d2.publish).toHaveBeenCalledTimes(1);
  });

  it("does nothing when both feeds are empty and the outbox is clear", async () => {
    const d = deps({ fetchNasa: vi.fn(async () => []), fetchUsgs: vi.fn(async () => []) });
    const stats = await ingestOnce({ prisma, ...d });
    expect(stats).toMatchObject({ fetched: 0, inserted: 0, published: 0, pending: 0 });
    expect(d.publish).not.toHaveBeenCalled();
  });
});
