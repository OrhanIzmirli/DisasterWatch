/**
 * GET /disasters through the app: the public cache cannot be bypassed from
 * the query string, parameters are clamped, and the partial/stale/503 states
 * reach the wire with the documented shape. NASA/USGS are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({ nasa: vi.fn(), usgs: vi.fn() }));
vi.mock("../src/services/nasa.service.js", () => ({ fetchNasaEvents: mocks.nasa }));
vi.mock("../src/services/usgs.service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUsgsEarthquakes: mocks.usgs };
});

const { createTestApp } = await import("./helpers.js");
const { feedService } = await import("../src/services/feed.service.js");

const app = createTestApp();

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

beforeEach(() => {
  feedService.reset();
  mocks.nasa.mockReset().mockResolvedValue([NASA_EVENT]);
  mocks.usgs.mockReset().mockResolvedValue([USGS_FEATURE]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /disasters: the cache is server-side only", () => {
  it("?force=1&cacheMs=0 is served from the cache without calling the sources", async () => {
    const first = await request(app).get("/disasters");
    expect(first.status).toBe(200);
    expect(first.body.source).toBe("NASA + USGS");
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
    expect(mocks.usgs).toHaveBeenCalledTimes(1);

    for (const qs of ["?force=1&cacheMs=0", "?force=true", "?cacheMs=1", "?force=1&cacheMs=0&minutes=120&limit=5"]) {
      const res = await request(app).get(`/disasters${qs}`);
      expect(res.status).toBe(200);
      expect(res.body.source).toBe("CACHE");
      expect(res.body.params).not.toHaveProperty("cacheMs");
    }
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
    expect(mocks.usgs).toHaveBeenCalledTimes(1);
  });

  it("clamps limit to 1..200 and minutes to 60..43200, ignoring junk", async () => {
    const params = async (qs) => (await request(app).get(`/disasters${qs}`)).body.params;
    expect(await params("")).toEqual({ minutesWindow: 10080, limit: 50, minMag: 4.5 });
    expect(await params("?limit=0&minutes=1")).toEqual({ minutesWindow: 60, limit: 1, minMag: 4.5 });
    expect(await params("?limit=99999&minutes=99999999")).toEqual({ minutesWindow: 43200, limit: 200, minMag: 4.5 });
    expect(await params("?limit=-5&minutes=-5&minMag=-3")).toEqual({ minutesWindow: 60, limit: 1, minMag: 0 });
    expect(await params("?limit=abc&minutes=abc&minMag=abc")).toEqual({ minutesWindow: 10080, limit: 50, minMag: 4.5 });
    expect(await params("?minMag=99")).toEqual({ minutesWindow: 10080, limit: 50, minMag: 10 });
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
  });

  it("the raw NASA proxy is gone", async () => {
    expect((await request(app).get("/disasters/nasa")).status).toBe(401); // falls through to the authenticated routes
  });
});

describe("GET /disasters: partial, stale and unavailable states", () => {
  it("NASA down -> 200 with USGS items, partial: true, sources.nasa = error", async () => {
    mocks.nasa.mockRejectedValue(new Error("EONET 503"));
    const res = await request(app).get("/disasters");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ partial: true, stale: false, source: "USGS", sources: { nasa: "error", usgs: "ok" } });
    expect(res.body.items.map((i) => i.type)).toEqual(["earthquake"]);
  });

  it("USGS down -> 200 with NASA items, partial: true, sources.usgs = error", async () => {
    mocks.usgs.mockRejectedValue(new Error("USGS timeout"));
    const res = await request(app).get("/disasters");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ partial: true, stale: false, source: "NASA", sources: { nasa: "ok", usgs: "error" } });
    expect(res.body.items.map((i) => i.type)).toEqual(["wildfire"]);
  });

  it("both down with nothing cached -> 503 with a plain message and no upstream details", async () => {
    mocks.nasa.mockRejectedValue(new Error("EONET request timed out"));
    mocks.usgs.mockRejectedValue(new Error("USGS request failed: 502"));
    const res = await request(app).get("/disasters");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ message: "Live disaster sources are not responding", retryAfterSeconds: 60 });
    const wire = JSON.stringify(res.body);
    expect(wire).not.toMatch(/EONET|502|timed out|USGS/);
    // the reasons are logged on the server
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("EONET request timed out"));
  });

  it("a source that failed recently keeps serving its data as 'stale' with sourcesUpdatedAt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      const t0 = Date.now();
      await request(app).get("/disasters");
      mocks.usgs.mockRejectedValue(new Error("USGS 502"));
      vi.setSystemTime(t0 + 12 * 60_000);
      const res = await request(app).get("/disasters");
      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ partial: false, stale: false, sources: { nasa: "ok", usgs: "stale" } });
      expect(res.body.sourcesUpdatedAt).toEqual({ nasa: new Date(t0 + 12 * 60_000).toISOString(), usgs: new Date(t0).toISOString() });
      expect(res.body.items.map((i) => i.type)).toEqual(["wildfire", "earthquake"]);
      expect(JSON.stringify(res.body)).not.toMatch(/502/);
    } finally {
      vi.useRealTimers();
    }
  });
});
