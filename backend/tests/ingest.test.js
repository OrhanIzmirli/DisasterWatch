import { describe, it, expect, beforeEach, vi } from "vitest";
import { resetDb, prisma } from "./helpers.js";
import { ingestOnce, recordNewEvents } from "../src/jobs/ingest.js";
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

beforeEach(resetDb);

describe("mappers", () => {
  it("maps NASA events to the contract with stable ids and fixes swapped coordinates", () => {
    const { events, dropped } = nasaEventsToContract(NASA_RAW);
    expect(dropped).toBe(0);
    expect(events.map((e) => e.eventId)).toEqual(["nasa:EONET_1001", "nasa:EONET_1002"]);
    expect(events[0]).toMatchObject({ source: "nasa", type: "wildfire", severity: "high", lat: -18.2436, lng: 25.2047 });
    expect(events[1]).toMatchObject({ type: "flood", lat: 17.7858, lng: 97.7421 });
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
  it("returns only rows that were newly inserted", async () => {
    const { events } = nasaEventsToContract(NASA_RAW);
    const first = await recordNewEvents(events, { prisma });
    expect(first.map((e) => e.eventId)).toEqual(["nasa:EONET_1001", "nasa:EONET_1002"]);

    const again = await recordNewEvents(events, { prisma });
    expect(again).toEqual([]);

    const extra = { ...events[0], eventId: "nasa:EONET_9999" };
    const mixed = await recordNewEvents([...events, extra], { prisma });
    expect(mixed.map((e) => e.eventId)).toEqual(["nasa:EONET_9999"]);

    expect(await prisma.ingestedEvent.count()).toBe(3);
  });
});

describe("ingestOnce", () => {
  it("publishes each event exactly once across runs (dedupe)", async () => {
    const d = deps();

    const first = await ingestOnce({ prisma, ...d });
    expect(first).toMatchObject({ fetched: 3, inserted: 3, published: 3, errors: [] });
    expect(d.publish).toHaveBeenCalledTimes(1);
    const publishedIds = d.publish.mock.calls[0][0].map((e) => e.eventId).sort();
    expect(publishedIds).toEqual(["nasa:EONET_1001", "nasa:EONET_1002", "usgs:us6000u25i"]);

    const second = await ingestOnce({ prisma, ...d });
    expect(second).toMatchObject({ fetched: 3, inserted: 0, published: 0 });
    expect(d.publish).toHaveBeenCalledTimes(1); // nothing new -> no publish call

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

  it("records a publish failure without throwing", async () => {
    const d = deps({ publish: vi.fn(async () => { throw new Error("broker down"); }) });
    const stats = await ingestOnce({ prisma, ...d });
    expect(stats.inserted).toBe(3);
    expect(stats.published).toBe(0);
    expect(stats.errors).toEqual(["publish: broker down"]);
  });

  it("does nothing when both feeds are empty", async () => {
    const d = deps({ fetchNasa: vi.fn(async () => []), fetchUsgs: vi.fn(async () => []) });
    const stats = await ingestOnce({ prisma, ...d });
    expect(stats).toMatchObject({ fetched: 0, inserted: 0, published: 0 });
    expect(d.publish).not.toHaveBeenCalled();
  });
});
