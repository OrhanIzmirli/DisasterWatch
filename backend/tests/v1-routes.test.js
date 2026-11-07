/**
 * Public API v1 over HTTP: read-only methods, open CORS without credentials,
 * Cache-Control + ETag/304, the per-IP rate limit (429 + Retry-After), the
 * error envelope, 503 when nothing is cached, and that the dashboard routes
 * keep their own CORS allow-list. NASA/USGS are mocked; no database access.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express from "express";
import request from "supertest";

const mocks = vi.hoisted(() => ({ nasa: vi.fn(), usgs: vi.fn() }));
vi.mock("../src/services/nasa.service.js", () => ({ fetchNasaEvents: mocks.nasa, fetchNasaEventsRated: mocks.nasa, fetchNasaEventsFast: mocks.nasa }));
vi.mock("../src/services/usgs.service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUsgsEarthquakes: mocks.usgs };
});

const { createTestApp } = await import("./helpers.js");
const { feedService, FeedUnavailableError } = await import("../src/services/feed.service.js");
const { createV1Router, V1_RATE_LIMIT } = await import("../src/routes/v1.routes.js");

const hoursAgo = (h) => Date.now() - h * 3600_000;
const FIRE = {
  id: "EONET_1",
  title: "Wildfire in Botswana 1032764",
  categories: [{ id: "wildfires", title: "Wildfires" }],
  geometry: [{ date: new Date(hoursAgo(1)).toISOString(), type: "Point", coordinates: [25.2, -18.2] }],
  sources: [],
};
const QUAKE = {
  id: "us1",
  properties: { mag: 5.2, place: "53 km S of Kushiro, Japan", time: hoursAgo(0.5), updated: Date.now(), url: "https://example.org/us1", status: "reviewed" },
  geometry: { coordinates: [144.4, 42.5, 50] },
};

// the app as in production (limit off so the many requests below do not trip it)
const app = createTestApp({ v1RateLimit: false });

beforeEach(() => {
  feedService.reset();
  mocks.nasa.mockReset().mockResolvedValue([FIRE]);
  mocks.usgs.mockReset().mockResolvedValue([QUAKE]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("GET /api/v1/disasters", () => {
  it("answers the documented envelope on /api/v1 and /v1 (the site's /api rewrite)", async () => {
    for (const path of ["/api/v1/disasters", "/v1/disasters"]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(200);
      expect(res.body.data.map((e) => e.id)).toEqual(["usgs:us1", "eonet:EONET_1"]);
      expect(res.body.meta).toMatchObject({ count: 2, total: 2, limit: 50, nextCursor: null, stale: false, partial: false, sources: { usgs: "ok", eonet: "ok" } });
      expect(res.body.attribution.sources.map((s) => s.id)).toEqual(["usgs", "eonet", "gdacs", "emsc", "nhc", "firms", "geonames"]);
      expect(res.body.attribution.disclaimer).toMatch(/not an official warning/);
    }
  });

  it("filters and pages", async () => {
    const res = await request(app).get("/api/v1/disasters?type=earthquake&limit=1");
    expect(res.body.data.map((e) => e.id)).toEqual(["usgs:us1"]);
    expect(res.body.meta).toMatchObject({ total: 1, nextCursor: null });
    const first = await request(app).get("/api/v1/disasters?limit=1");
    expect(first.body.meta.nextCursor).toBeTruthy();
    const second = await request(app).get(`/api/v1/disasters?limit=1&cursor=${first.body.meta.nextCursor}`);
    expect(second.body.data.map((e) => e.id)).toEqual(["eonet:EONET_1"]);
    expect(second.body.meta.nextCursor).toBeNull();
  });

  it("400 with the error envelope for a bad parameter, not cached", async () => {
    const res = await request(app).get("/api/v1/disasters?type=volcano");
    expect(res.status).toBe(400);
    expect(res.body.error).toEqual({ code: "bad_request", message: expect.stringMatching(/volcano/) });
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("Cache-Control and ETag; If-None-Match gives 304", async () => {
    const res = await request(app).get("/api/v1/disasters");
    expect(res.headers["cache-control"]).toBe("public, max-age=60, stale-while-revalidate=300");
    expect(res.headers.etag).toBeTruthy();
    const again = await request(app).get("/api/v1/disasters").set("If-None-Match", res.headers.etag);
    expect(again.status).toBe(304);
  });

  it("503 with Retry-After when both sources fail and nothing is cached", async () => {
    mocks.nasa.mockRejectedValue(new Error("upstream-detail-x1"));
    mocks.usgs.mockRejectedValue(new Error("upstream-detail-x1"));
    const res = await request(app).get("/api/v1/disasters");
    expect(res.status).toBe(503);
    expect(res.headers["retry-after"]).toBe("60");
    expect(res.body.error.code).toBe("unavailable");
    expect(JSON.stringify(res.body)).not.toMatch(/upstream-detail-x1/); // upstream details stay in the log
  });

  it("a failed source is reported as partial, the other still served", async () => {
    mocks.usgs.mockRejectedValue(new Error("usgs down"));
    const res = await request(app).get("/api/v1/disasters");
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ partial: true, sources: { usgs: "error", eonet: "ok" } });
    expect(res.body.data.map((e) => e.id)).toEqual(["eonet:EONET_1"]);
  });
});

describe("GET /api/v1/disasters/{id} and /api/v1/types", () => {
  it("one event by id; 404 and 400 otherwise", async () => {
    const ok = await request(app).get("/api/v1/disasters/usgs:us1");
    expect(ok.status).toBe(200);
    expect(ok.body.data).toMatchObject({ id: "usgs:us1", type: "earthquake", severity: "medium" });
    const missing = await request(app).get("/api/v1/disasters/usgs:nope");
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe("not_found");
    const bad = await request(app).get("/api/v1/disasters/../../users");
    expect([400, 404]).toContain(bad.status);
    const malformed = await request(app).get("/api/v1/disasters/12345");
    expect(malformed.status).toBe(400);
  });

  it("types, severities and rules, cached for a day", async () => {
    const res = await request(app).get("/api/v1/types");
    expect(res.status).toBe(200);
    expect(res.body.data.map((t) => t.id)).toEqual(["earthquake", "wildfire", "flood", "storm"]);
    expect(res.body.severities).toEqual(["high", "medium", "low", "unrated"]);
    expect(res.body.severityRules.earthquake.high).toBe(6);
    expect(res.headers["cache-control"]).toBe("public, max-age=86400");
  });

  it("index lists the endpoints and limits", async () => {
    const res = await request(app).get("/api/v1");
    expect(res.body.limits).toEqual({ requestsPerMinute: 60, requestsPerMinuteWithKey: 600, windowDays: 30, maxPageSize: 200 });
  });

  it("unknown v1 path is a JSON 404", async () => {
    const res = await request(app).get("/api/v1/news");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("not_found");
  });
});

describe("read-only, CORS", () => {
  it("POST/PUT/DELETE are 405 with Allow", async () => {
    for (const method of ["post", "put", "patch", "delete"]) {
      const res = await request(app)[method]("/api/v1/disasters");
      expect(res.status, method).toBe(405);
      expect(res.headers.allow).toBe("GET, HEAD, OPTIONS");
      expect(res.body.error.code).toBe("method_not_allowed");
    }
  });

  it("any origin may GET, without credentials; no cookie is ever set", async () => {
    const res = await request(app).get("/api/v1/disasters").set("Origin", "https://someone-else.example");
    expect(res.headers["access-control-allow-origin"]).toBe("*");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["cross-origin-resource-policy"]).toBe("cross-origin");
    expect(res.headers["set-cookie"]).toBeUndefined();
  });

  it("preflight allows only GET/HEAD", async () => {
    const res = await request(app).options("/api/v1/disasters").set("Origin", "https://someone-else.example").set("Access-Control-Request-Method", "POST");
    expect(res.headers["access-control-allow-methods"]).toBe("GET,HEAD,OPTIONS");
  });

  it("the dashboard routes keep their allow-list", async () => {
    const res = await request(app).get("/disasters").set("Origin", "https://someone-else.example");
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("rate limit (per client IP)", () => {
  // own router with a small limit and a fake feed: no other test shares this counter
  const feed = { snapshot: async () => ({ served: { nasa: [], usgs: [] }, sources: { nasa: "ok", usgs: "ok" }, updatedAt: null, stale: false, partial: false }) };
  const limited = express();
  limited.set("trust proxy", 1);
  limited.use("/api/v1", createV1Router({ feed, rateLimit: { limit: 3, windowMs: 60_000 } }));
  const get = (ip) => request(limited).get("/api/v1/disasters").set("X-Forwarded-For", ip);

  it("production default is 60 per minute", () => {
    expect(V1_RATE_LIMIT).toEqual({ windowMs: 60_000, limit: 60 });
  });

  it("allows the limit, then 429 with Retry-After and RateLimit headers", async () => {
    for (let i = 1; i <= 3; i++) {
      const res = await get("198.51.100.1");
      expect(res.status, `request ${i}`).toBe(200);
      expect(res.headers["ratelimit-policy"]).toMatch(/^3;w=60/);
    }
    const res = await get("198.51.100.1");
    expect(res.status).toBe(429);
    expect(Number(res.headers["retry-after"])).toBeGreaterThanOrEqual(1);
    expect(Number(res.headers["retry-after"])).toBeLessThanOrEqual(60);
    expect(res.headers.ratelimit).toMatch(/remaining=0/);
    expect(res.body.error.code).toBe("rate_limited");
    expect(res.headers["cache-control"]).toBe("no-store");
  });

  it("another client is not affected", async () => {
    expect((await get("198.51.100.2")).status).toBe(200);
  });

  it("preflights are not counted", async () => {
    for (let i = 0; i < 5; i++) {
      const res = await request(limited).options("/api/v1/disasters").set("X-Forwarded-For", "198.51.100.3").set("Origin", "https://a.example").set("Access-Control-Request-Method", "GET");
      expect(res.status).toBe(204);
    }
    expect((await get("198.51.100.3")).status).toBe(200);
  });

  it("FeedUnavailableError from the feed is a 503, other errors a 500 envelope", async () => {
    const down = express();
    down.use("/v1", createV1Router({ feed: { snapshot: async () => { throw new FeedUnavailableError(); } }, rateLimit: false }));
    expect((await request(down).get("/v1/disasters")).status).toBe(503);
    const broken = express();
    broken.use("/v1", createV1Router({ feed: { snapshot: async () => { throw new Error("boom"); } }, rateLimit: false }));
    const res = await request(broken).get("/v1/disasters");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("server_error");
  });
});
