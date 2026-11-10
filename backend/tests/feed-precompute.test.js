/**
 * The dashboard feed is computed when data arrives, not per request:
 * getFeed reuses its result while the data, parameters and minute are the same,
 * the scores and the JSON body are built once per result, prefetch() refreshes
 * the sources before their cache expires, and the warmer does both once a
 * minute. NASA, USGS and the confirming sources are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import request from "supertest";

const mocks = vi.hoisted(() => ({ nasa: vi.fn(), usgs: vi.fn() }));
vi.mock("../src/services/nasa.service.js", () => ({ fetchNasaEvents: mocks.nasa, fetchNasaEventsRated: mocks.nasa, fetchNasaEventsFast: mocks.nasa }));
vi.mock("../src/services/usgs.service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUsgsEarthquakes: mocks.usgs };
});
// confirming sources that answer at once with nothing, so two requests see the same scores
vi.mock("../src/services/sources/index.js", () => {
  const empty = async () => ({ status: "ok", data: [], fetchedAt: null });
  const confirmingSources = { emsc: { get: empty }, nhc: { get: empty }, firms: { enabled: false } };
  return { confirmingSources, createConfirmingSources: () => confirmingSources, confirmingSourcesStatus: () => ({}) };
});

const { createTestApp } = await import("./helpers.js");
const { createFeedService, feedService, FEED_CACHE_MS, PREFETCH_AHEAD_MS, SOURCE_RETRY_MS, FeedUnavailableError } = await import("../src/services/feed.service.js");
const { createFeedAnnotator } = await import("../src/services/fusion/feed.js");
const { createFeedView, startFeedWarmer, DASHBOARD_PARAMS } = await import("../src/services/feedView.js");

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

function service(t0 = 1_000_000) {
  const clock = { t: t0 };
  const fetchNasa = vi.fn(async () => [NASA_EVENT]);
  const fetchUsgs = vi.fn(async () => [USGS_FEATURE]);
  const svc = createFeedService({ fetchNasa, fetchUsgs, now: () => clock.t, log: quiet });
  return { svc, fetchNasa, fetchUsgs, clock };
}

describe("getFeed reuses its result while nothing changed", () => {
  it("same data, parameters and minute -> the same object; a new minute or new data -> rebuilt", async () => {
    const { svc, clock } = service();
    await svc.getFeed(); // first answer is labelled live; the cached ones that follow are "CACHE"
    const a = await svc.getFeed();
    expect(await svc.getFeed()).toBe(a);

    clock.t += 60_000; // the window edge and "minutes ago" move with the clock
    const b = await svc.getFeed();
    expect(b).not.toBe(a);
    expect(b).toEqual(a);

    clock.t += FEED_CACHE_MS; // expired: fetched again, new payload
    await svc.getFeed();
    const c = await svc.getFeed();
    expect(c).not.toBe(b);
  });

  it("keeps one result per parameter set, and a bounded number of them", async () => {
    const { svc } = service();
    await svc.getFeed();
    const small = await svc.getFeed({ limit: 1 });
    const big = await svc.getFeed({ limit: 200 });
    expect(small.items).toHaveLength(1);
    expect(big.items).toHaveLength(2);
    expect(await svc.getFeed({ limit: 1 })).toBe(small);

    for (let limit = 2; limit <= 40; limit++) await svc.getFeed({ limit });
    expect(await svc.getFeed({ limit: 1 })).not.toBe(small); // evicted long ago, built again
  });
});

describe("prefetch refreshes the sources before a request has to wait for them", () => {
  it("fetches missing sources, leaves fresh ones alone, refreshes those close to expiry", async () => {
    const { svc, fetchNasa, fetchUsgs, clock } = service();
    expect(await svc.prefetch()).toEqual(["nasa", "usgs"]);
    expect(fetchNasa).toHaveBeenCalledTimes(1);

    clock.t += 60_000;
    expect(await svc.prefetch()).toEqual([]);

    clock.t = 1_000_000 + FEED_CACHE_MS - PREFETCH_AHEAD_MS;
    expect(await svc.prefetch()).toEqual(["nasa", "usgs"]);
    expect(fetchNasa).toHaveBeenCalledTimes(2);
    expect(fetchUsgs).toHaveBeenCalledTimes(2);

    // a request inside the cache window is answered from what prefetch brought
    clock.t += FEED_CACHE_MS - 1000;
    const feed = await svc.getFeed();
    expect(feed.source).toBe("CACHE");
    expect(fetchNasa).toHaveBeenCalledTimes(2);
    expect(feed.updatedAt).toBe(new Date(1_000_000 + FEED_CACHE_MS - PREFETCH_AHEAD_MS).toISOString());
  });

  it("respects the failure back-off and never starts a second fetch of the same source", async () => {
    let release;
    const clock = { t: 5_000_000 };
    const fetchNasa = vi.fn().mockRejectedValueOnce(new Error("down")).mockImplementation(() => new Promise((r) => (release = () => r([NASA_EVENT]))));
    const svc = createFeedService({ fetchNasa, fetchUsgs: async () => [USGS_FEATURE], now: () => clock.t, log: quiet });
    await svc.prefetch(); // nasa fails
    clock.t += 30_000; // NASA has data from nowhere yet: the cold-start retry delay applies (10 s), so it is due
    const running = svc.prefetch();
    expect(await Promise.race([svc.prefetch(), new Promise((r) => setTimeout(() => r("second"), 20))])).toEqual([]); // in flight: not fetched twice
    release();
    await running;
    expect(fetchNasa).toHaveBeenCalledTimes(2);

    // with data held, a failure waits the normal back-off before prefetch tries again
    fetchNasa.mockRejectedValueOnce(new Error("down again"));
    clock.t += FEED_CACHE_MS;
    await svc.prefetch();
    clock.t += SOURCE_RETRY_MS / 2;
    expect(await svc.prefetch()).toEqual([]);
    clock.t += SOURCE_RETRY_MS;
    fetchNasa.mockResolvedValue([NASA_EVENT]);
    expect(await svc.prefetch()).toContain("nasa");
  });
});

describe("scores and the JSON body are built once per result", () => {
  const fusionWith = () => {
    const fused = { matches: new Map(), scores: new Map([["usgs:us1", { confidence: { score: 70 }, priority: { score: 40 } }]]), status: { emsc: "ok", nhc: "ok", firms: "off" } };
    return { fused, fusion: { fuse: vi.fn(async () => fused) } };
  };

  it("the annotator returns the same scored feed until the feed or the fusion result changes", async () => {
    const { svc } = service();
    const { fused, fusion } = fusionWith();
    const annotate = createFeedAnnotator({ feedService: svc, fusion, eventsFor: () => [], log: quiet });
    const feed = await svc.getFeed();
    const one = await annotate(feed);
    expect(await annotate(feed)).toBe(one);
    expect(one.items.find((i) => i.type === "earthquake").scores).toEqual({ confidence: 70, priority: 40, confirmations: 0 });

    fused.status = { emsc: "pending", nhc: "ok", firms: "off" }; // a source joined or left
    expect(await annotate(feed)).not.toBe(one);
  });

  it("a failed fusion is not remembered", async () => {
    const { svc } = service();
    const fuse = vi.fn().mockRejectedValueOnce(new Error("x")).mockResolvedValue({ matches: new Map(), scores: new Map(), status: { emsc: "ok", nhc: "ok", firms: "off" } });
    const annotate = createFeedAnnotator({ feedService: svc, fusion: { fuse }, eventsFor: () => [], log: quiet });
    const feed = await svc.getFeed();
    expect((await annotate(feed)).scoring.status.emsc).toBe("error");
    expect((await annotate(feed)).scoring.status.emsc).toBe("ok");
  });

  it("the view serialises once and gives a stable ETag; new data gives a new one", async () => {
    const { svc, clock } = service();
    const { fusion } = fusionWith();
    const view = createFeedView({ feedService: svc, annotate: createFeedAnnotator({ feedService: svc, fusion, eventsFor: () => [], log: quiet }) });
    await view.get(DASHBOARD_PARAMS);
    const a = await view.get(DASHBOARD_PARAMS);
    const b = await view.get(DASHBOARD_PARAMS);
    expect(b.body).toBe(a.body); // the same string, not an equal one
    expect(b.etag).toBe(a.etag);
    expect(JSON.parse(a.body)).toEqual(a.feed);
    expect(a.feed.params).toEqual({ minutesWindow: 7 * 24 * 60, limit: 200, minMag: 4.5 });

    clock.t += FEED_CACHE_MS;
    await view.get(DASHBOARD_PARAMS);
    expect((await view.get(DASHBOARD_PARAMS)).etag).not.toBe(a.etag);
  });
});

describe("the warmer", () => {
  it("prefetches and builds the dashboard response at start and on every tick, without stacking ticks", async () => {
    let release;
    const prefetch = vi.fn(() => new Promise((r) => (release = r)));
    const get = vi.fn(async () => ({}));
    const warmer = startFeedWarmer({ feedService: { prefetch }, view: { get }, intervalMs: 60_000, log: quiet });
    expect(prefetch).toHaveBeenCalledTimes(1);
    warmer.tick(); // still running: joined, not started again
    expect(prefetch).toHaveBeenCalledTimes(1);
    release();
    await warmer.tick();
    expect(get).toHaveBeenCalledWith(DASHBOARD_PARAMS);
    warmer.stop();
  });

  it("stays quiet when nothing can be served yet and logs other failures", async () => {
    const error = vi.fn();
    const w1 = startFeedWarmer({ feedService: { prefetch: async () => [] }, view: { get: async () => { throw new FeedUnavailableError(); } }, log: { error } });
    await w1.tick();
    w1.stop();
    expect(error).not.toHaveBeenCalled();
    const w2 = startFeedWarmer({ feedService: { prefetch: async () => [] }, view: { get: async () => { throw new Error("boom"); } }, log: { error } });
    await w2.tick();
    w2.stop();
    expect(error).toHaveBeenCalledWith("[feed] warm-up failed:", "boom");
  });
});

describe("GET /disasters sends the prepared body", () => {
  const app = createTestApp();
  beforeEach(() => {
    // a fixed clock: a minute boundary between two requests would rebuild the body (new "minutes ago")
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date());
    feedService.reset();
    mocks.nasa.mockReset().mockResolvedValue([NASA_EVENT]);
    mocks.usgs.mockReset().mockResolvedValue([USGS_FEATURE]);
    return () => vi.useRealTimers();
  });

  it("carries an ETag and answers 304 to a matching If-None-Match, without calling the sources again", async () => {
    await request(app).get("/disasters?limit=200");
    const first = await request(app).get("/disasters?limit=200");
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toMatch(/application\/json/);
    expect(first.body.items).toHaveLength(2);
    expect(first.body.items.every((i) => "scores" in i)).toBe(true);
    const etag = first.headers.etag;
    expect(etag).toMatch(/^"[\w-]+"$/);

    const again = await request(app).get("/disasters?limit=200").set("If-None-Match", etag);
    expect(again.status).toBe(304);
    expect(again.text).toBe("");
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
  });

  it("serves what the warmer prepared: the first request after a warm-up does not fetch", async () => {
    const warmer = startFeedWarmer({ log: quiet });
    await warmer.tick();
    warmer.stop();
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
    const res = await request(app).get("/disasters?limit=200");
    expect(res.status).toBe(200);
    expect(res.body.source).toBe("CACHE");
    expect(mocks.nasa).toHaveBeenCalledTimes(1);
  });
});
