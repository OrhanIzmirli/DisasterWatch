/**
 * Confirming sources of the fusion (src/services/sources): the shared cache
 * (TTL, one request at a time, stale serving, backoff, "off"), the EMSC adapter
 * (URL, normalisation, incremental merge) and the NHC adapter. Fixtures are
 * invented and shaped like the real answers; nothing is fetched.
 */
import { describe, it, expect, vi } from "vitest";
import { createSourceCache } from "../src/services/sources/sourceCache.js";
import { buildEmscUrl, createEmscFetcher, EMSC_FULL_REFRESH_MS, EMSC_WINDOW_MS, normalizeEmsc, normalizeEmscFeature } from "../src/services/sources/emsc.js";
import { basinOf, createNhcFetcher, NHC_USER_AGENT, normalizeNhc } from "../src/services/sources/nhc.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const silent = { warn: () => {}, error: () => {} };
const quiet = { now: () => NOW, log: silent };

const emscFeature = (unid, { hoursAgo = 1, mag = 5.1, auth = "EMSC", evtype = "ke", lat = 10, lon = 20 } = {}) => ({
  type: "Feature",
  id: unid,
  geometry: { type: "Point", coordinates: [lon, lat, -10] },
  properties: {
    unid,
    source_id: "1",
    time: new Date(NOW - hoursAgo * 3600_000).toISOString(),
    lastupdate: new Date(NOW - hoursAgo * 3600_000 + 60_000).toISOString(),
    flynn_region: "EXAMPLE REGION",
    lat,
    lon,
    depth: 10,
    evtype,
    auth,
    mag,
    magtype: "mb",
  },
});

const response = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("createSourceCache", () => {
  it("serves cached data inside the TTL and refreshes after it", async () => {
    let t = NOW;
    const fetch = vi.fn(async () => [t]);
    const cache = createSourceCache({ name: "x", fetch, ttlMs: 1000, now: () => t, log: silent });
    expect(await cache.get()).toMatchObject({ status: "ok", data: [NOW] });
    t += 500;
    await cache.get();
    expect(fetch).toHaveBeenCalledTimes(1);
    t += 600;
    expect((await cache.get()).data).toEqual([NOW + 1100]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("concurrent callers share one request", async () => {
    let release;
    const fetch = vi.fn(() => new Promise((r) => (release = r)));
    const cache = createSourceCache({ name: "x", fetch, ttlMs: 1000, ...quiet });
    const both = Promise.all([cache.get(), cache.get()]);
    release(["a"]);
    const [a, b] = await both;
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(a.data).toEqual(["a"]);
    expect(b.data).toEqual(["a"]);
  });

  it("passes the previous data to the fetcher (incremental sources)", async () => {
    let t = NOW;
    const fetch = vi.fn(async (prev) => (prev ? [...prev.data, "b"] : ["a"]));
    const cache = createSourceCache({ name: "x", fetch, ttlMs: 1000, now: () => t, log: silent });
    await cache.get();
    t += 2000;
    expect((await cache.get()).data).toEqual(["a", "b"]);
    expect(fetch.mock.calls[1][0]).toEqual({ data: ["a"], fetchedAt: NOW });
  });

  it("after a failure serves the last data as stale, backs off, then gives up after staleMaxMs", async () => {
    let t = NOW;
    let fail = false;
    const fetch = vi.fn(async () => {
      if (fail) throw new Error("down");
      return ["a"];
    });
    const cache = createSourceCache({ name: "x", fetch, ttlMs: 1000, staleMaxMs: 10_000, now: () => t, log: silent });
    await cache.get();
    fail = true;
    t += 1500;
    expect(await cache.get()).toMatchObject({ status: "stale", data: ["a"] });
    expect(cache.status()).toMatchObject({ failing: true, items: 1 });
    t += 100;
    await cache.get(); // gate closed: no request
    expect(fetch).toHaveBeenCalledTimes(2);
    t += 20_000;
    expect(await cache.get()).toMatchObject({ status: "error", data: null });
  });

  it("a source that never answered is an error; a disabled one is off and never asked", async () => {
    const failing = createSourceCache({ name: "x", fetch: async () => { throw new Error("no"); }, ttlMs: 1000, ...quiet });
    expect(await failing.get()).toEqual({ status: "error", data: null, fetchedAt: null });
    const fetch = vi.fn();
    const off = createSourceCache({ name: "x", fetch, ttlMs: 1000, enabled: false, ...quiet });
    expect(await off.get()).toEqual({ status: "off", data: null, fetchedAt: null });
    expect(fetch).not.toHaveBeenCalled();
    expect(off.status()).toMatchObject({ enabled: false, fetchedAt: null });
  });

  it("status() carries no upstream error text", async () => {
    const cache = createSourceCache({ name: "x", fetch: async () => { throw new Error("https://example.org/?key=secret"); }, ttlMs: 1000, ...quiet });
    await cache.get();
    expect(JSON.stringify(cache.status())).not.toMatch(/secret|example\.org/);
  });
});

describe("EMSC", () => {
  it("builds the window and incremental URLs", () => {
    expect(buildEmscUrl({ start: NOW - EMSC_WINDOW_MS })).toBe(
      "https://www.seismicportal.eu/fdsnws/event/1/query?format=json&minmag=4&limit=5000&orderby=time&starttime=2026-10-08T12%3A00%3A00"
    );
    expect(buildEmscUrl({ updatedAfter: NOW })).toMatch(/updatedafter=2026-11-07T12%3A00%3A00$/);
  });

  it("normalises a feature; keeps the agency and whether it relays the USGS", () => {
    const o = normalizeEmscFeature(emscFeature("20261107_0000001", { auth: "neic" }));
    expect(o).toMatchObject({ source: "emsc", sourceId: "20261107_0000001", type: "earthquake", lat: 10, lng: 20, magnitude: 5.1, magnitudeType: "mb", depthKm: 10, agency: "NEIC", relaysUsgs: true, region: "EXAMPLE REGION" });
    expect(o.url).toBe("https://www.seismicportal.eu/eventdetails.html?unid=20261107_0000001");
    expect(normalizeEmscFeature(emscFeature("b", { auth: "GFZ" })).relaysUsgs).toBe(false);
  });

  it("drops blasts, rockbursts and broken rows", () => {
    const payload = {
      features: [emscFeature("ok"), emscFeature("blast", { evtype: "qb" }), emscFeature("burst", { evtype: "kr" }), { properties: { unid: "x", time: "nope" } }, null],
    };
    expect(normalizeEmsc(payload).map((o) => o.sourceId)).toEqual(["ok"]);
    expect(normalizeEmsc({})).toEqual([]);
  });

  it("fetches the window once, then only updates, merged by id and pruned to 30 days", async () => {
    let t = NOW;
    const urls = [];
    const answers = [
      { features: [emscFeature("a", { hoursAgo: 2 }), emscFeature("old", { hoursAgo: 30 * 24 - 0.5 })] },
      { features: [emscFeature("a", { hoursAgo: 2, mag: 5.3 }), emscFeature("b", { hoursAgo: 0.1 })] },
    ];
    const fetchImpl = vi.fn(async (url) => {
      urls.push(url);
      return response(answers.shift() ?? { features: [] });
    });
    const fetchEmsc = createEmscFetcher({ fetchImpl, now: () => t });
    const first = await fetchEmsc(null);
    expect(first.map((o) => o.sourceId)).toEqual(["a", "old"]);
    expect(urls[0]).toMatch(/starttime=/);
    t += 3600_000; // "old" is now 30 days + 30 min old
    const second = await fetchEmsc({ data: first, fetchedAt: NOW });
    expect(urls[1]).toMatch(/updatedafter=2026-11-07T11%3A58%3A00/); // two minutes of overlap
    expect(second.map((o) => o.sourceId)).toEqual(["b", "a"]);
    expect(second.find((o) => o.sourceId === "a").magnitude).toBe(5.3);
    t += EMSC_FULL_REFRESH_MS;
    await fetchEmsc({ data: second, fetchedAt: t - 1000 });
    expect(urls[2]).toMatch(/starttime=/);
  });

  it("an HTTP error is thrown (the cache keeps the last data)", async () => {
    const fetchEmsc = createEmscFetcher({ fetchImpl: async () => response({}, 503), now: () => NOW });
    await expect(fetchEmsc(null)).rejects.toThrow("EMSC HTTP 503");
  });
});

describe("NHC", () => {
  const storm = {
    id: "AL992026",
    binNumber: "AT9",
    name: "Examplestorm",
    classification: "HU",
    intensity: "85",
    pressure: "975",
    latitudeNumeric: 25.1,
    longitudeNumeric: -75.2,
    lastUpdate: "2026-11-07T09:00:00.000Z",
    publicAdvisory: { url: "https://www.nhc.noaa.gov/text/EXAMPLE.shtml" },
  };

  it("normalises active storms with basin, classification and wind", () => {
    const [o] = normalizeNhc({ activeStorms: [storm, { id: "cp01", latitudeNumeric: "x" }] });
    expect(o).toMatchObject({
      source: "nhc",
      sourceId: "al992026",
      type: "storm",
      name: "Examplestorm",
      classification: "HU",
      classificationLabel: "Hurricane",
      basin: "atlantic",
      lat: 25.1,
      lng: -75.2,
      windKts: 85,
      pressureMb: 975,
      time: Date.parse("2026-11-07T09:00:00Z"),
      url: "https://www.nhc.noaa.gov/text/EXAMPLE.shtml",
    });
    expect(normalizeNhc({ activeStorms: [] })).toEqual([]);
    expect(normalizeNhc(null)).toEqual([]);
  });

  it("only links to nhc.noaa.gov; basins from the ATCF prefix", () => {
    const [o] = normalizeNhc({ activeStorms: [{ ...storm, publicAdvisory: { url: "https://elsewhere.example/x" } }] });
    expect(o.url).toBe("https://www.nhc.noaa.gov/");
    expect([basinOf("ep012026"), basinOf("CP042026"), basinOf("wp012026")]).toEqual(["eastern-pacific", "central-pacific", null]);
  });

  it("identifies itself with a User-Agent", async () => {
    const fetchImpl = vi.fn(async () => response({ activeStorms: [storm] }));
    const out = await createNhcFetcher({ fetchImpl })();
    expect(out).toHaveLength(1);
    expect(fetchImpl.mock.calls[0][1].headers["User-Agent"]).toBe(NHC_USER_AGENT);
  });
});
