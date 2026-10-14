import { describe, it, expect, vi } from "vitest";
import { createFeedService, FeedUnavailableError, FEED_CACHE_MS, SOURCE_RETRY_MS } from "../src/services/feed.service.js";
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
    await expect(svc.getFeed()).rejects.toThrow(/Disaster feed unavailable: NASA: EONET down; USGS: USGS 500/);
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
    expect(res.sources).toEqual({ nasa: "error", usgs: "error" });
    expect(res.items).toHaveLength(2);
    expect(res.updatedAt).toBe(new Date(1_000_000).toISOString());
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
    expect(quiet.warn).toHaveBeenCalledWith(expect.stringContaining("NASA unavailable (EONET 503)"));
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
    t += 10_000;
    expect((await svc.getFeed()).partial).toBe(true); // inside the retry delay: no new USGS call
    expect(fetchUsgs).toHaveBeenCalledTimes(1);

    t += SOURCE_RETRY_MS;
    usgsDown = false;
    const res = await svc.getFeed();
    expect(fetchUsgs).toHaveBeenCalledTimes(2);
    expect(fetchNasa).toHaveBeenCalledTimes(1); // NASA is still fresh
    expect(res.partial).toBe(false);
    expect(res.sources).toEqual({ nasa: "ok", usgs: "ok" });
    expect(res.source).toBe("NASA + USGS");
  });

  it("a partial feed gives the whole limit to the source that answered", async () => {
    const quakes = Array.from({ length: 10 }, (_, i) => ({ ...USGS_FEATURE, id: `q${i}`, properties: { ...USGS_FEATURE.properties, time: USGS_FEATURE.properties.time - i * 1000 } }));
    const svc = createFeedService({ fetchNasa: async () => { throw new Error("down"); }, fetchUsgs: async () => quakes, log: quiet });
    expect((await svc.getFeed({ limit: 10 })).items).toHaveLength(10);
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
