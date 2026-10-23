/**
 * Cold start: the public feed answers without waiting for GDACS, the lookups
 * finish in the background and show on the next request, and the answers
 * survive a restart through the durable store (GdacsCache). Also the 7-day
 * USGS window: a full page keeps the strongest quakes. No network.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createGdacsClient, GDACS_CACHE_TTL_MS } from "../src/services/gdacs.js";
import { createMemoryGdacsStore, createPrismaGdacsStore, GDACS_STORE_MAX_AGE_MS } from "../src/services/gdacsStore.js";
import { fetchNasaEventsFast, fetchNasaEventsRated } from "../src/services/nasa.service.js";
import { createFeedService, strongestFirst } from "../src/services/feed.service.js";
import { FEED_PARAM_LIMITS } from "../src/services/feed.service.js";
import { USGS_FEED_URL } from "../src/services/usgs.service.js";
import { prisma, resetDb } from "./helpers.js";

const quiet = { info: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const fire = (eventid) => ({
  id: `EONET_${eventid}`,
  title: `Wildfire in Testland ${eventid}`,
  categories: [{ id: "wildfires", title: "Wildfires" }],
  sources: [{ id: "GDACS", url: `https://www.gdacs.org/report.aspx?eventtype=WF&eventid=${eventid}` }],
  geometry: [{ date: new Date(Date.now() - 3600_000).toISOString(), type: "Point", coordinates: [10, 20], magnitudeValue: 5604, magnitudeUnit: "hectare" }],
});
const answer = (alertlevel, coordinates = [10.2, 20.1]) => ({
  ok: true,
  json: async () => ({
    type: "Feature",
    geometry: { type: "Point", coordinates },
    properties: { eventtype: "WF", alertlevel, alertscore: 2, affectedcountries: [{ iso2: "TL" }] },
  }),
});

/** A fetch whose answers wait until release() is called. */
function heldFetch(level = "red") {
  let release;
  const gate = new Promise((r) => (release = r));
  const fetchImpl = vi.fn(async () => {
    await gate;
    return answer(level);
  });
  return { fetchImpl, release: () => release() };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

describe("GDACS durable store", () => {
  it("writes the answers once they are flushed and a restarted client starts with them, without a request", async () => {
    const store = createMemoryGdacsStore();
    const first = createGdacsClient({ fetchImpl: vi.fn(async () => answer("orange")), store, log: quiet, persistDelayMs: 60_000 });
    await first.enrich([fire("1"), fire("2")]);
    expect(store.rows.size).toBe(0); // batched, not yet written
    await first.flush();
    expect([...store.rows.keys()].sort()).toEqual(["WF:1", "WF:2"]);
    expect(store.rows.get("WF:1")).toMatchObject({ level: "orange", score: 2, countries: "TL", lat: 20.1, lng: 10.2 });

    const fetchImpl = vi.fn();
    const restarted = createGdacsClient({ fetchImpl, store, log: quiet });
    await restarted.ensureLoaded();
    const events = [fire("1"), fire("2")];
    expect(restarted.attach(events)).toBe(0);
    expect(events[0].gdacs).toMatchObject({ level: "orange" });
    expect(events[0].gdacsPlace).toEqual({ countries: ["TL"], lat: 20.1, lng: 10.2 });
    await restarted.enrich(events); // fresh: cache hits only
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(restarted.status().store).toMatchObject({ loaded: 2, lastError: null });
  });

  it("serves a stored answer older than the TTL until its refresh answers, and keeps it when the refresh fails", async () => {
    let t = 10 * GDACS_CACHE_TTL_MS;
    const store = createMemoryGdacsStore();
    await store.save([{ key: "WF:1", value: { level: "red", score: 3, text: null }, place: { countries: [], lat: 1, lng: 2 }, fetchedAt: t - GDACS_CACHE_TTL_MS - 1 }]);

    const down = createGdacsClient({ fetchImpl: vi.fn(async () => { throw new Error("socket hang up"); }), store, now: () => t, log: quiet });
    await down.ensureLoaded();
    const events = [fire("1")];
    expect(down.attach(events)).toBe(0);
    expect(events[0].gdacs.level).toBe("red");
    await down.enrich(events); // expired: asks GDACS, which fails -> previous answer stays
    expect(events[0].gdacs.level).toBe("red");
    expect(events[0].gdacsUnreachable).toBeUndefined();

    const up = createGdacsClient({ fetchImpl: vi.fn(async () => answer("green")), store, now: () => t, log: quiet });
    await up.enrich(events);
    expect(events[0].gdacs.level).toBe("green");
    await up.flush();
    expect(store.rows.get("WF:1").level).toBe("green");
    expect(store.rows.get("WF:1").fetchedAt.getTime()).toBe(t);
  });

  it("works from memory when the store cannot be read or written, and says so in status()", async () => {
    const broken = { load: vi.fn(async () => { throw new Error('relation "GdacsCache" does not exist'); }), save: vi.fn(async () => { throw new Error("write failed"); }) };
    const client = createGdacsClient({ fetchImpl: vi.fn(async () => answer("orange")), store: broken, log: quiet });
    const events = [fire("1")];
    await client.enrich(events);
    expect(events[0].gdacs.level).toBe("orange");
    expect(client.status().store.lastError).toMatch(/does not exist/);
    await client.flush();
    expect(client.status().store.lastError).toBe("write failed");
  });

  it("does not wait longer than the load timeout for a hanging store", async () => {
    const hanging = { load: () => new Promise(() => {}), save: vi.fn() };
    const client = createGdacsClient({ fetchImpl: vi.fn(async () => answer("red")), store: hanging, storeLoadTimeoutMs: 20, log: quiet });
    const started = Date.now();
    await client.ensureLoaded();
    expect(Date.now() - started).toBeLessThan(1000);
    expect(client.status().store.lastError).toMatch(/longer than 20 ms/);
  });

  it("the Prisma store round-trips entries and deletes rows older than 30 days on load", async () => {
    await resetDb();
    const store = createPrismaGdacsStore(prisma);
    const t = Date.now();
    await store.save([
      { key: "WF:1", value: { level: "red", score: 2.5, text: "impact" }, place: { countries: ["TL", "XX"], lat: 1.5, lng: 2.5 }, fetchedAt: t },
      { key: "FL:2", value: null, place: { countries: [], lat: null, lng: null }, fetchedAt: t },
      { key: "WF:old", value: { level: "green", score: 1, text: null }, place: { countries: [], lat: null, lng: null }, fetchedAt: t - GDACS_STORE_MAX_AGE_MS - 1000 },
    ]);
    await store.save([{ key: "WF:1", value: { level: "orange", score: 2, text: null }, place: { countries: ["TL"], lat: 1.5, lng: 2.5 }, fetchedAt: t + 1 }]);
    const rows = (await store.load(t)).sort((a, b) => a.key.localeCompare(b.key));
    expect(rows).toEqual([
      { key: "FL:2", value: null, place: { countries: [], lat: null, lng: null }, fetchedAt: t },
      { key: "WF:1", value: { level: "orange", score: 2, text: null }, place: { countries: ["TL"], lat: 1.5, lng: 2.5 }, fetchedAt: t + 1 },
    ]);
    expect(await prisma.gdacsCache.count()).toBe(2);
  });
});

describe("public feed on a cold start", () => {
  let gdacs;
  let held;
  beforeEach(() => {
    held = heldFetch("red");
    gdacs = createGdacsClient({ fetchImpl: held.fetchImpl, store: createMemoryGdacsStore(), log: quiet });
  });

  it("fetchNasaEventsFast answers before GDACS does and the same events carry the level once it has", async () => {
    const events = await fetchNasaEventsFast({ gdacs, fetchEvents: async () => [fire("1"), fire("2")], log: quiet });
    expect(events.every((e) => e.gdacs === undefined)).toBe(true);
    expect(gdacs.status().pending).toBe(2);

    held.release();
    await vi.waitFor(() => expect(events.every((e) => e.gdacs?.level === "red")).toBe(true));
    expect(events[0].gdacsPlace).toMatchObject({ lat: 20.1, lng: 10.2 });
  });

  it("the ingestion path still waits for every lookup", async () => {
    const pending = fetchNasaEventsRated({ gdacs, fetchEvents: async () => [fire("1")] });
    let done = false;
    pending.then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    held.release();
    expect((await pending)[0].gdacs.level).toBe("red");
  });

  it("the first feed uses the fallback rule, the next request within the cache window shows the GDACS level and point", async () => {
    let t = 1_000_000;
    const svc = createFeedService({
      fetchNasa: () => fetchNasaEventsFast({ gdacs, fetchEvents: async () => [fire("1")], log: quiet }),
      fetchUsgs: async () => [],
      now: () => t,
      log: quiet,
    });
    const first = await svc.getFeed();
    expect(first.items[0]).toMatchObject({ severity: "low", lat: 20, lng: 10 }); // 5,604 ha: area rule, EONET point
    expect(first.items[0].details.gdacsLevel).toBeNull();

    held.release();
    await vi.waitFor(() => expect(gdacs.status().pending).toBe(0));
    t += 1000;
    const second = await svc.getFeed();
    expect(second.source).toBe("CACHE");
    expect(second.items[0]).toMatchObject({ severity: "high", lat: 20.1, lng: 10.2 });
    expect(second.items[0].details.gdacsLevel).toBe("red");
  });
});

describe("USGS: 7 days of M4.5+", () => {
  const quake = (id, mag, minutesAgo) => ({
    id,
    properties: { mag, place: `Somewhere ${id}`, time: Date.now() - minutesAgo * 60_000, updated: Date.now(), url: "https://example.org", status: "reviewed" },
    geometry: { coordinates: [10, 10, 10] },
  });

  it("uses the weekly M4.5+ summary feed and does not accept a lower minimum", () => {
    expect(USGS_FEED_URL).toBe("https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/4.5_week.geojson");
    expect(FEED_PARAM_LIMITS.minMag.min).toBe(4.5);
  });

  it("a full page keeps the strongest quakes of the week, newest first", async () => {
    const svc = createFeedService({
      fetchNasa: async () => [],
      fetchUsgs: async () => [quake("small-new", 4.6, 10), quake("big-old", 7.2, 6 * 24 * 60), quake("mid", 5.5, 600), quake("small-newer", 4.5, 5)],
      log: quiet,
    });
    const feed = await svc.getFeed({ limit: 2 });
    expect(feed.items.map((i) => i.location)).toEqual(["Somewhere mid", "Somewhere big-old"]);
    expect(feed.counts.byType.earthquake.total).toBe(4); // KPIs still count the whole window
  });

  it("strongestFirst breaks magnitude ties by age and keeps the input order", () => {
    const q = (id, magnitude, timeMinutesAgo) => ({ id, timeMinutesAgo, details: { magnitude } });
    const list = [q("a", 5, 1), q("b", 6, 2), q("c", 5, 3), q("d", null, 0)];
    expect(strongestFirst(list, 2).map((x) => x.id)).toEqual(["a", "b"]);
    expect(strongestFirst(list, 3).map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});
