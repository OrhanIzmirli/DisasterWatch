import { describe, it, expect, vi } from "vitest";
import { createFeedService, countEvents, FeedUnavailableError, FEED_CACHE_MS, SOURCE_RETRY_MS, COLD_START_RETRY_MS, SOURCE_STALE_MAX_MS, FEED_UNAVAILABLE_MESSAGE } from "../src/services/feed.service.js";
import { countryFromPlace, countryFromToken } from "../src/utils/country.js";
import { pickBestLatLngFromGeometryArray, normalizeNasaEvents } from "../src/utils/normalizeDisasters.js";
import { normalizeUsgsEarthquakes } from "../src/services/usgs.service.js";

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

const NASA_EVENT = {
  id: "EONET_1",
  title: "Wildfire in Botswana 1032764",
  categories: [{ id: "wildfires", title: "Wildfires" }],
  geometry: [{ date: new Date(Date.now() - 3600_000).toISOString(), type: "Point", coordinates: [25.2, -18.2] }],
  sources: [],
};
const USGS_FEATURE = {
  id: "us1",
  properties: { mag: 5.2, place: "53 km S of Kushiro, Japan", time: Date.now() - 1800_000, updated: Date.now(), url: "https://example.org", status: "reviewed" },
  geometry: { coordinates: [144.4, 42.5, 50] },
};

describe("public feed service: no invented items, honest stale/unavailable states", () => {
  it("serves live data and caches it for the fixed cache lifetime", async () => {
    let t = 1_000_000;
    const fetchNasa = vi.fn(async () => [NASA_EVENT]);
    const fetchUsgs = vi.fn(async () => [USGS_FEATURE]);
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });

    const first = await svc.getFeed();
    expect(first.source).toBe("NASA + USGS");
    expect(first.stale).toBe(false);
    expect(first.partial).toBe(false);
    expect(first.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(first.sourcesUpdatedAt).toEqual({ nasa: new Date(t).toISOString(), usgs: new Date(t).toISOString() });
    expect(first.items.map((i) => i.type)).toEqual(["wildfire", "earthquake"]);
    expect(first.items[0].country).toBe("Botswana");
    expect(first.items[1].country).toBe("Japan");
    expect(first.updatedAt).toBe(new Date(t).toISOString());
    expect(first.params).toEqual({ minutesWindow: 7 * 24 * 60, limit: 50, minMag: 4.5 });

    t += 60_000;
    const second = await svc.getFeed();
    expect(second.source).toBe("CACHE");
    expect(second.stale).toBe(false);
    expect(fetchNasa).toHaveBeenCalledTimes(1);
    expect(fetchUsgs).toHaveBeenCalledTimes(1);

    t += FEED_CACHE_MS;
    await svc.getFeed();
    expect(fetchNasa).toHaveBeenCalledTimes(2);
    expect(fetchUsgs).toHaveBeenCalledTimes(2);
  });

  it("applies the window, limit and magnitude per request without re-fetching", async () => {
    const fetchNasa = vi.fn(async () => [NASA_EVENT]);
    const fetchUsgs = vi.fn(async () => [USGS_FEATURE, { ...USGS_FEATURE, id: "us-small", properties: { ...USGS_FEATURE.properties, mag: 4.6 } }]);
    const svc = createFeedService({ fetchNasa, fetchUsgs, log: quiet });

    expect((await svc.getFeed()).items).toHaveLength(3);
    expect((await svc.getFeed({ minMag: 5 })).items.map((i) => i.type)).toEqual(["wildfire", "earthquake"]);
    expect((await svc.getFeed({ limit: 1 })).items).toHaveLength(1);
    expect((await svc.getFeed({ minutesWindow: 10 })).items).toHaveLength(0); // everything is older than 10 min
    expect(fetchNasa).toHaveBeenCalledTimes(1);
    expect(fetchUsgs).toHaveBeenCalledTimes(1);
  });

  it("is unavailable (503 material) when both sources fail and nothing is cached — never a seeded item", async () => {
    const svc = createFeedService({
      fetchNasa: async () => { throw new Error("EONET down"); },
      fetchUsgs: async () => { throw new Error("USGS 500"); },
      log: quiet,
    });
    await expect(svc.getFeed()).rejects.toBeInstanceOf(FeedUnavailableError);
    await expect(svc.getFeed()).rejects.toThrow(FEED_UNAVAILABLE_MESSAGE);
    // upstream details go to the log and status() only, never into the error that reaches the route
    await expect(svc.getFeed()).rejects.not.toThrow(/EONET|500/);
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining("EONET down"));
    expect(svc.status().nasa).toMatchObject({ cached: false, updatedAt: null, lastError: "EONET down" });
    expect(svc.status().usgs).toMatchObject({ cached: false, updatedAt: null, lastError: "USGS 500" });
  });

  it("serves the previous feed as stale when both sources fail later", async () => {
    let fail = false;
    let t = 1_000_000;
    const svc = createFeedService({
      fetchNasa: async () => { if (fail) throw new Error("timeout"); return [NASA_EVENT]; },
      fetchUsgs: async () => { if (fail) throw new Error("timeout"); return [USGS_FEATURE]; },
      now: () => t,
      log: quiet,
    });
    await svc.getFeed();
    fail = true;
    t += 10 * 60_000;
    const res = await svc.getFeed();
    expect(res.stale).toBe(true);
    expect(res.partial).toBe(false);
    expect(res.source).toBe("CACHE-FALLBACK");
    expect(res.sources).toEqual({ nasa: "stale", usgs: "stale" });
    expect(res.items).toHaveLength(2);
    expect(res.updatedAt).toBe(new Date(1_000_000).toISOString());
    expect(res.sourcesUpdatedAt).toEqual({ nasa: new Date(1_000_000).toISOString(), usgs: new Date(1_000_000).toISOString() });
  });

  it("an empty live result is an empty feed (no padding with fallback items)", async () => {
    const svc = createFeedService({ fetchNasa: async () => [], fetchUsgs: async () => [], log: quiet });
    const res = await svc.getFeed();
    expect(res.items).toEqual([]);
    expect(res.count).toBe(0);
    expect(res.stale).toBe(false);
    expect(res.partial).toBe(false);
  });
});

describe("sources fail independently", () => {
  it("NASA down: USGS items are served with partial: true and sources.nasa = error", async () => {
    const svc = createFeedService({
      fetchNasa: async () => { throw new Error("EONET 503"); },
      fetchUsgs: async () => [USGS_FEATURE],
      log: quiet,
    });
    const res = await svc.getFeed();
    expect(res.partial).toBe(true);
    expect(res.stale).toBe(false);
    expect(res.sources).toEqual({ nasa: "error", usgs: "ok" });
    expect(res.source).toBe("USGS");
    expect(res.items.map((i) => i.type)).toEqual(["earthquake"]);
    expect(res.sourcesUpdatedAt).toEqual({ nasa: null, usgs: expect.any(String) });
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining("nasa unavailable (EONET 503)"));
  });

  it("USGS down: NASA items are served with partial: true and sources.usgs = error", async () => {
    const svc = createFeedService({
      fetchNasa: async () => [NASA_EVENT],
      fetchUsgs: async () => { throw new Error("USGS timeout"); },
      log: quiet,
    });
    const res = await svc.getFeed();
    expect(res.partial).toBe(true);
    expect(res.sources).toEqual({ nasa: "ok", usgs: "error" });
    expect(res.source).toBe("NASA");
    expect(res.items.map((i) => i.type)).toEqual(["wildfire"]);
  });

  it("a failed source is retried after the retry delay while the other stays cached", async () => {
    let t = 1_000_000;
    let usgsDown = true;
    const fetchNasa = vi.fn(async () => [NASA_EVENT]);
    const fetchUsgs = vi.fn(async () => { if (usgsDown) throw new Error("USGS down"); return [USGS_FEATURE]; });
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });

    expect((await svc.getFeed()).partial).toBe(true);
    t += 5_000;
    expect((await svc.getFeed()).partial).toBe(true); // inside the (cold-start) retry delay: no new USGS call
    expect(fetchUsgs).toHaveBeenCalledTimes(1);

    t += COLD_START_RETRY_MS; // USGS has never returned data: the short delay applies
    usgsDown = false;
    const res = await svc.getFeed();
    expect(fetchUsgs).toHaveBeenCalledTimes(2);
    expect(fetchNasa).toHaveBeenCalledTimes(1); // NASA is still fresh
    expect(res.partial).toBe(false);
    expect(res.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(res.source).toBe("NASA + USGS");
  });

  it("a short failure keeps the source: data at most 60 min old is served as 'stale', partial stays false", async () => {
    let t = 1_000_000;
    let usgsDown = false;
    const svc = createFeedService({
      fetchNasa: async () => [NASA_EVENT],
      fetchUsgs: async () => { if (usgsDown) throw new Error("USGS 502"); return [USGS_FEATURE]; },
      now: () => t,
      log: quiet,
    });
    await svc.getFeed();
    usgsDown = true;
    t += 12 * 60_000; // USGS data is 12 minutes old when the refresh fails
    const res = await svc.getFeed();
    expect(res.sources).toEqual({ nasa: "ok", usgs: "stale" });
    expect(res.partial).toBe(false);
    expect(res.stale).toBe(false);
    expect(res.items.map((i) => i.type)).toEqual(["wildfire", "earthquake"]);
    expect(res.sourcesUpdatedAt).toEqual({ nasa: new Date(t).toISOString(), usgs: new Date(1_000_000).toISOString() });
    expect(res.updatedAt).toBe(new Date(t).toISOString());
    expect(res.source).toBe("NASA + USGS");
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining("usgs unreachable (USGS 502)"));
  });

  it("a long failure drops the source: data older than 60 min is not served ('error', partial: true)", async () => {
    let t = 1_000_000;
    let usgsDown = false;
    const svc = createFeedService({
      fetchNasa: async () => [NASA_EVENT],
      fetchUsgs: async () => { if (usgsDown) throw new Error("USGS 502"); return [USGS_FEATURE]; },
      now: () => t,
      log: quiet,
    });
    await svc.getFeed();
    usgsDown = true;
    t += SOURCE_STALE_MAX_MS + 1; // just past the limit
    const res = await svc.getFeed();
    expect(res.sources).toEqual({ nasa: "ok", usgs: "error" });
    expect(res.partial).toBe(true);
    expect(res.items.map((i) => i.type)).toEqual(["wildfire"]);
    expect(res.sourcesUpdatedAt).toEqual({ nasa: new Date(t).toISOString(), usgs: null });
  });

  it("stale data stays served through the retry back-off, and recovers on the next successful fetch", async () => {
    let t = 1_000_000;
    let usgsDown = false;
    const fetchUsgs = vi.fn(async () => { if (usgsDown) throw new Error("USGS 502"); return [USGS_FEATURE]; });
    const svc = createFeedService({ fetchNasa: async () => [NASA_EVENT], fetchUsgs, now: () => t, log: quiet });
    await svc.getFeed();
    usgsDown = true;
    t += FEED_CACHE_MS;
    expect((await svc.getFeed()).sources.usgs).toBe("stale");
    t += 10_000;
    expect((await svc.getFeed()).sources.usgs).toBe("stale"); // back-off: no new call, data still served
    expect(fetchUsgs).toHaveBeenCalledTimes(2);
    usgsDown = false;
    t += SOURCE_RETRY_MS;
    const res = await svc.getFeed();
    expect(fetchUsgs).toHaveBeenCalledTimes(3);
    expect(res.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(res.sourcesUpdatedAt.usgs).toBe(new Date(t).toISOString());
  });

  it("a partial feed gives the whole limit to the source that answered", async () => {
    const quakes = Array.from({ length: 10 }, (_, i) => ({ ...USGS_FEATURE, id: `q${i}`, properties: { ...USGS_FEATURE.properties, time: USGS_FEATURE.properties.time - i * 1000 } }));
    const svc = createFeedService({ fetchNasa: async () => { throw new Error("down"); }, fetchUsgs: async () => quakes, log: quiet });
    expect((await svc.getFeed({ limit: 10 })).items).toHaveLength(10);
  });
});

describe("retry delay: cold start vs a source that already has data", () => {
  it("a source that has never returned data retries after COLD_START_RETRY_MS (10 s), not 60 s", async () => {
    let t = 1_000_000;
    let nasaDown = true;
    const fetchNasa = vi.fn(async () => { if (nasaDown) throw new Error("fetch failed"); return [NASA_EVENT]; });
    const fetchUsgs = vi.fn(async () => { if (nasaDown) throw new Error("fetch failed"); return [USGS_FEATURE]; });
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });

    await expect(svc.getFeed()).rejects.toBeInstanceOf(FeedUnavailableError); // cold start during a blip
    t += COLD_START_RETRY_MS - 1;
    await expect(svc.getFeed()).rejects.toBeInstanceOf(FeedUnavailableError); // still inside the short delay: no call
    expect(fetchNasa).toHaveBeenCalledTimes(1);
    expect(fetchUsgs).toHaveBeenCalledTimes(1);

    t += 1; // 10 s after the failure
    nasaDown = false;
    const res = await svc.getFeed();
    expect(fetchNasa).toHaveBeenCalledTimes(2);
    expect(fetchUsgs).toHaveBeenCalledTimes(2);
    expect(res.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(res.items).toHaveLength(2);
  });

  it("a source that already has data keeps the 60 s back-off after a failure", async () => {
    let t = 1_000_000;
    let usgsDown = false;
    const fetchUsgs = vi.fn(async () => { if (usgsDown) throw new Error("USGS 502"); return [USGS_FEATURE]; });
    const svc = createFeedService({ fetchNasa: async () => [NASA_EVENT], fetchUsgs, now: () => t, log: quiet });
    await svc.getFeed();
    usgsDown = true;
    t += FEED_CACHE_MS; // cache expired: the refresh fails
    expect((await svc.getFeed()).sources.usgs).toBe("stale");
    expect(fetchUsgs).toHaveBeenCalledTimes(2);

    t += COLD_START_RETRY_MS; // 10 s later: NOT retried, the source has data
    usgsDown = false;
    expect((await svc.getFeed()).sources.usgs).toBe("stale");
    expect(fetchUsgs).toHaveBeenCalledTimes(2);

    t += SOURCE_RETRY_MS - COLD_START_RETRY_MS; // 60 s after the failure: retried
    expect((await svc.getFeed()).sources.usgs).toBe("ok");
    expect(fetchUsgs).toHaveBeenCalledTimes(3);
  });

  it("only the cold source gets the short delay when the other already has data", async () => {
    let t = 1_000_000;
    let nasaDown = true;
    const fetchNasa = vi.fn(async () => { if (nasaDown) throw new Error("EONET 503"); return [NASA_EVENT]; });
    const fetchUsgs = vi.fn(async () => [USGS_FEATURE]);
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });
    expect((await svc.getFeed()).sources).toEqual({ nasa: "error", usgs: "ok" });
    t += COLD_START_RETRY_MS;
    nasaDown = false;
    const res = await svc.getFeed();
    expect(fetchNasa).toHaveBeenCalledTimes(2);
    expect(fetchUsgs).toHaveBeenCalledTimes(1); // still fresh, not touched
    expect(res.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(res.partial).toBe(false);
  });
});

describe("in-flight dedup: one upstream fetch per source at a time", () => {
  it("20 parallel getFeed calls on a cold cache make exactly 1 NASA and 1 USGS call", async () => {
    let releaseNasa;
    let releaseUsgs;
    const fetchNasa = vi.fn(() => new Promise((resolve) => { releaseNasa = () => resolve([NASA_EVENT]); }));
    const fetchUsgs = vi.fn(() => new Promise((resolve) => { releaseUsgs = () => resolve([USGS_FEATURE]); }));
    const svc = createFeedService({ fetchNasa, fetchUsgs, log: quiet });

    const calls = Array.from({ length: 20 }, () => svc.getFeed());
    await new Promise((r) => setTimeout(r, 10)); // everyone is waiting on the same fetch
    expect(fetchNasa).toHaveBeenCalledTimes(1);
    expect(fetchUsgs).toHaveBeenCalledTimes(1);
    releaseNasa();
    releaseUsgs();
    const results = await Promise.all(calls);
    expect(results).toHaveLength(20);
    for (const r of results) {
      expect(r.items).toHaveLength(2);
      expect(r.sources).toEqual({ nasa: "ok", usgs: "ok" });
    }
    expect(fetchNasa).toHaveBeenCalledTimes(1);
    expect(fetchUsgs).toHaveBeenCalledTimes(1);
  });

  it("concurrent callers share a failing fetch too, and the slot is cleared in finally", async () => {
    let t = 1_000_000;
    let calls = 0;
    const fetchNasa = vi.fn(async () => { calls += 1; throw new Error("down"); });
    const fetchUsgs = vi.fn(async () => [USGS_FEATURE]);
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });
    const results = await Promise.all([svc.getFeed(), svc.getFeed(), svc.getFeed()]);
    expect(calls).toBe(1);
    for (const r of results) expect(r.sources).toEqual({ nasa: "error", usgs: "ok" });
    t += SOURCE_RETRY_MS;
    await svc.getFeed();
    expect(calls).toBe(2); // slot cleared: the retry after the back-off reaches NASA again
  });
});

describe("country derived from the source place name only", () => {
  it.each([
    ["126 km S of Kokopo, Papua New Guinea", "Papua New Guinea"],
    ["Fiji region", "Fiji"],
    ["Mongolia, China", "China"],
    ["Buckhorn 2, Cassia, Idaho", "United States"],
    ["12 Miles S from Murtaugh, ID", "United States"],
    ["Izmir, Turkey", "Türkiye"],
    ["Wildfire in Botswana", "Botswana"],
    ["Kuril Islands, Russia", "Russia"],
    ["North Atlantic Ocean", null],
    ["Reykjanes Ridge", null],
    ["Simon", null], // "Hurricane Simon": a storm name is not a country
    ["central Poland", null], // not derivable without guessing
    ["", null],
    [null, null],
  ])("%j -> %j", (place, expected) => {
    expect(countryFromPlace(place)).toBe(expected);
  });

  it("rejects tokens with digits or absurd length", () => {
    expect(countryFromToken("Japan 2026")).toBeNull();
    expect(countryFromToken("a".repeat(41))).toBeNull();
  });

  it("is attached by both normalizers and never 'Unknown'", () => {
    const nasa = normalizeNasaEvents([NASA_EVENT]);
    expect(nasa[0].country).toBe("Botswana");
    const quakes = normalizeUsgsEarthquakes([USGS_FEATURE, { ...USGS_FEATURE, id: "us2", properties: { ...USGS_FEATURE.properties, place: "North Atlantic Ocean" } }], { minMag: 4.5, limit: 10 });
    expect(quakes.map((q) => q.country)).toEqual(["Japan", null]);
  });
});

describe("polygon events are placed at the centroid", () => {
  it("uses the outer ring centroid for Polygon and MultiPolygon, the point itself for Point", () => {
    const square = [[[10, 10], [12, 10], [12, 12], [10, 12], [10, 10]]];
    const poly = pickBestLatLngFromGeometryArray([{ date: "2026-10-10T20:00:00Z", type: "Polygon", coordinates: square }]);
    expect(poly.coords).toEqual([10.8, 10.8]); // average of the 5 ring vertices (closing vertex repeated)
    const multi = pickBestLatLngFromGeometryArray([{ date: "2026-10-10T20:00:00Z", type: "MultiPolygon", coordinates: [square] }]);
    expect(multi.coords).toEqual([10.8, 10.8]);
    const point = pickBestLatLngFromGeometryArray([{ date: "2026-10-10T20:00:00Z", type: "Point", coordinates: [25.2, -18.2] }]);
    expect(point.coords).toEqual([25.2, -18.2]);
  });

  it("prefers the most recent geometry", () => {
    const res = pickBestLatLngFromGeometryArray([
      { date: "2026-10-01T00:00:00Z", type: "Point", coordinates: [1, 1] },
      { date: "2026-10-10T00:00:00Z", type: "Point", coordinates: [2, 2] },
    ]);
    expect(res.coords).toEqual([2, 2]);
  });
});

describe("counts over the whole window (dashboard KPIs must not depend on the page size)", () => {
  it("counts every event in the window per severity and type, while items are limited", async () => {
    const t = Date.parse("2026-10-13T12:00:00Z");
    const quake = (id, mag, minutesAgo) => ({
      ...USGS_FEATURE,
      id,
      properties: { ...USGS_FEATURE.properties, mag, time: t - minutesAgo * 60000 },
    });
    const fetchNasa = vi.fn(async () => [NASA_EVENT, { ...NASA_EVENT, id: "EONET_2" }, { ...NASA_EVENT, id: "EONET_3" }]);
    const fetchUsgs = vi.fn(async () => [quake("q1", 6.2, 10), quake("q2", 5.4, 20), quake("q3", 4.6, 30), quake("q4", 4.6, 40)]);
    const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => t, log: quiet });

    const feed = await svc.getFeed({ limit: 2 });
    expect(feed.items).toHaveLength(2);
    expect(feed.counts.total).toBe(7);
    // the fixture fires carry no area and no GDACS level, so they are unrated
    expect(feed.counts.bySeverity).toEqual({ high: 1, medium: 1, low: 2, unrated: 3 });
    expect(feed.counts.byType.earthquake).toEqual({ total: 4, high: 1, medium: 1, low: 2, unrated: 0 });
    expect(feed.counts.byType.wildfire).toEqual({ total: 3, high: 0, medium: 0, low: 0, unrated: 3 });
    expect(feed.counts.byType.flood).toEqual({ total: 0, high: 0, medium: 0, low: 0, unrated: 0 });
    // the same counts whatever the limit
    expect((await svc.getFeed({ limit: 200 })).counts).toEqual(feed.counts);
    expect(fetchNasa).toHaveBeenCalledTimes(1);
  });

  it("countEvents treats an unknown severity as unrated", () => {
    const c = countEvents([{ type: "flood", severity: "weird" }, { type: "storm", severity: "high" }]);
    expect(c).toMatchObject({ total: 2, bySeverity: { high: 1, medium: 0, low: 0, unrated: 1 } });
    expect(c.byType.flood.unrated).toBe(1);
  });
});
