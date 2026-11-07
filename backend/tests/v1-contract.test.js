/**
 * Contract tests: the OpenAPI document of API v1 is a valid OpenAPI 3.1
 * document, and every response the routes give (200, 304, 400, 404, 405,
 * 429, 503, 500) matches the schema the document declares for that
 * operation and status, with additionalProperties closed so an undocumented
 * field fails here. The documented query parameters equal the accepted ones.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";
import express from "express";
import request from "supertest";
import SwaggerParser from "@apidevtools/swagger-parser";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const mocks = vi.hoisted(() => ({ nasa: vi.fn(), usgs: vi.fn() }));
vi.mock("../src/services/nasa.service.js", () => ({ fetchNasaEvents: mocks.nasa, fetchNasaEventsRated: mocks.nasa, fetchNasaEventsFast: mocks.nasa }));
vi.mock("../src/services/usgs.service.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, fetchUsgsEarthquakes: mocks.usgs };
});

const { createTestApp } = await import("./helpers.js");
const { feedService, FeedUnavailableError } = await import("../src/services/feed.service.js");
const { createV1Router } = await import("../src/routes/v1.routes.js");
const { buildOpenApi } = await import("../src/api/v1/openapi.js");
const { LIST_PARAMS } = await import("../src/api/v1/events.js");

const hoursAgo = (h) => new Date(Date.now() - h * 3600_000).toISOString();
const STORM = {
  id: "EONET_7",
  title: "Tropical Storm Example",
  categories: [{ id: "severeStorms", title: "Severe Storms" }],
  geometry: [
    { date: hoursAgo(30), type: "Point", coordinates: [130, 15], magnitudeValue: 50, magnitudeUnit: "kts" },
    { date: hoursAgo(6), type: "Point", coordinates: [131, 16], magnitudeValue: 100, magnitudeUnit: "kts" },
  ],
  sources: [{ id: "JTWC", url: "https://example.org/jtwc/7" }],
  link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_7",
};
const FLOOD = {
  id: "EONET_8",
  title: "Flood in Nepal 1104225",
  categories: [{ id: "floods", title: "Floods" }],
  geometry: [{ date: hoursAgo(10), type: "Point", coordinates: [85, 27] }],
  sources: [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=FL&eventid=1104225" }],
  gdacs: { level: "red", score: 2.5 },
};
const QUAKE = {
  id: "us1",
  properties: { mag: 6.4, place: "53 km S of Kushiro, Japan", time: Date.now() - 1800_000, updated: Date.now(), url: "https://example.org/us1", status: "reviewed", alert: "yellow", tsunami: 1, felt: 12, magType: "mww" },
  geometry: { coordinates: [144.4, 42.5, 50] },
};

const doc = buildOpenApi();
const ajv = new Ajv2020({ strict: false, allErrors: true });
addFormats(ajv);
ajv.addSchema({ $id: "openapi.json", components: doc.components });
// OpenAPI component refs point into the document; resolve them through the schema registered above
const schemaFor = (s) => JSON.parse(JSON.stringify(s).replaceAll('"#/components/', '"openapi.json#/components/'));

/** The response object declared for an operation and status, refs to components/responses followed. */
function declared(path, status) {
  const op = doc.paths[path].get;
  let r = op.responses[status];
  expect(r, `${path} declares ${status}`).toBeDefined();
  if (r.$ref) r = doc.components.responses[r.$ref.split("/").pop()];
  return r;
}

/** Asserts the response matches the documented schema and declared headers. */
function expectContract(res, path) {
  const r = declared(path, res.status);
  if (res.status === 304) {
    expect(res.text || "").toBe("");
    return;
  }
  const schema = r.content["application/json"].schema;
  const validate = ajv.compile(schemaFor(schema));
  const ok = validate(res.body);
  expect(ok, `${path} ${res.status}: ${ajv.errorsText(validate.errors)}`).toBe(true);
  for (const name of Object.keys(r.headers || {})) {
    if (name === "ETag" && res.status !== 200) continue;
    expect(res.headers[name.toLowerCase()], `${path} ${res.status} header ${name}`).toBeDefined();
  }
}

// a limit no test reaches: the RateLimit headers the document declares are still sent
const app = createTestApp({ v1RateLimit: { limit: 100_000 } });

beforeEach(() => {
  feedService.reset();
  mocks.nasa.mockReset().mockResolvedValue([STORM, FLOOD]);
  mocks.usgs.mockReset().mockResolvedValue([QUAKE]);
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("the OpenAPI document", () => {
  beforeAll(async () => {
    // throws on anything that is not a valid OpenAPI 3.1 document (schema + $ref resolution)
    await SwaggerParser.validate(structuredClone(doc));
  });

  it("is a valid OpenAPI 3.1 document, served at /api/v1/openapi.json", async () => {
    const res = await request(app).get("/api/v1/openapi.json");
    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe("3.1.0");
    expect(res.body).toEqual(JSON.parse(JSON.stringify(doc)));
    expectContract(res, "/openapi.json");
  });

  it("documents exactly the query parameters the route accepts", () => {
    const names = doc.paths["/disasters"].get.parameters.map((p) => p.$ref.split("/").pop());
    expect(names).toEqual(LIST_PARAMS);
  });

  it("documents the rate limit the router enforces", () => {
    expect(doc.info.description).toContain("60 requests per minute");
  });
});

describe("responses match the document", () => {
  it("200 list, with every filter, and the next page", async () => {
    const res = await request(app).get("/api/v1/disasters?limit=1");
    expectContract(res, "/disasters");
    const next = await request(app).get(`/api/v1/disasters?limit=1&cursor=${res.body.meta.nextCursor}`);
    expectContract(next, "/disasters");
    const filtered = await request(app).get("/api/v1/disasters?type=earthquake,storm&severity=high&minSeverity=medium&from=2020-01-01&to=2100-01-01&bbox=100,0,150,50&country=japan");
    expectContract(filtered, "/disasters");
    expect(filtered.body.data.map((e) => e.id)).toEqual(["usgs:us1"]);
  });

  it("every event shape (earthquake, storm, flood with GDACS level)", async () => {
    const res = await request(app).get("/api/v1/disasters");
    expectContract(res, "/disasters");
    expect(res.body.data.map((e) => e.type).sort()).toEqual(["earthquake", "flood", "storm"]);
    for (const e of res.body.data) {
      const one = await request(app).get(`/api/v1/disasters/${e.id}`);
      expectContract(one, "/disasters/{id}");
    }
  });

  it("304 on a matching ETag", async () => {
    const first = await request(app).get("/api/v1/types");
    const res = await request(app).get("/api/v1/types").set("If-None-Match", first.headers.etag);
    expect(res.status).toBe(304);
    expectContract(res, "/types");
  });

  it("types and index", async () => {
    expectContract(await request(app).get("/api/v1/types"), "/types");
    expectContract(await request(app).get("/api/v1"), "/");
  });

  it("400 and 404", async () => {
    expectContract(await request(app).get("/api/v1/disasters?limit=999"), "/disasters");
    expectContract(await request(app).get("/api/v1/disasters/bad id"), "/disasters/{id}");
    expectContract(await request(app).get("/api/v1/disasters/usgs:missing"), "/disasters/{id}");
  });

  it("503 when nothing can be served, 500 on an unexpected error", async () => {
    const down = express();
    down.use("/api/v1", createV1Router({ feed: { snapshot: async () => { throw new FeedUnavailableError(); } }, rateLimit: false }));
    expectContract(await request(down).get("/api/v1/disasters"), "/disasters");
    const broken = express();
    broken.use("/api/v1", createV1Router({ feed: { snapshot: async () => { throw new Error("boom"); } }, rateLimit: false }));
    expectContract(await request(broken).get("/api/v1/disasters/usgs:x"), "/disasters/{id}");
  });

  it("429 with Retry-After and RateLimit headers", async () => {
    const limited = express();
    limited.set("trust proxy", 1);
    limited.use("/api/v1", createV1Router({ rateLimit: { limit: 1, windowMs: 60_000 } }));
    const get = () => request(limited).get("/api/v1/types").set("X-Forwarded-For", "192.0.2.50");
    expectContract(await get(), "/types");
    expectContract(await get(), "/types");
  });

  it("401 for a wrong API key", async () => {
    const res = await request(app).get("/api/v1/types").set("X-API-Key", "dwk_not-a-real-key");
    expect(res.status).toBe(401);
    expectContract(res, "/types");
  });

  it("405 bodies use the documented error schema", async () => {
    const res = await request(app).post("/api/v1/disasters");
    expect(res.status).toBe(405);
    const validate = ajv.compile(schemaFor({ $ref: "#/components/schemas/Error" }));
    expect(validate(res.body), ajv.errorsText(validate.errors)).toBe(true);
  });
});

const { matchSources } = await import("../src/services/fusion/match.js");
const { scoreEvents } = await import("../src/services/fusion/scores.js");
const { createPopulationIndex } = await import("../src/services/fusion/population.js");
const router = createV1Router;

describe("fusion fields (sources, confidence, priority) match the document", () => {
  const population = createPopulationIndex([[42.5, 144.4, 250_000], [16, 131, 30_000]]);

  // a fusion that matches invented observations of every confirming source with the real rules and scores
  const fakeFusion = {
    async fuse(events) {
      const quake = events.find((e) => e.type === "earthquake");
      const storm = events.find((e) => e.type === "storm");
      const emsc = [{ source: "emsc", sourceId: "20261107_0000001", time: Date.parse(quake.occurredAt) + 2000, lat: quake.lat + 0.05, lng: quake.lng, magnitude: 6.3, agency: "JMA", relaysUsgs: false, url: "https://www.seismicportal.eu/eventdetails.html?unid=20261107_0000001" }];
      const nhc = [{ source: "nhc", sourceId: "wp992026", name: "Example", lat: storm.lat, lng: storm.lng, time: Date.parse(storm.occurredAt), windKts: 95, classificationLabel: "Hurricane", url: "https://www.nhc.noaa.gov/" }];
      const matches = matchSources(events, { emsc, nhc, firms: new Map() });
      return { matches, scores: scoreEvents(events, matches, { now: Date.now(), population }), status: { emsc: "ok", nhc: "ok", firms: "off" } };
    },
  };
  const app2 = express();
  app2.use("/api/v1", router({ rateLimit: { limit: 100_000 }, fusion: fakeFusion }));

  it("every event carries the fusion fields in the documented shape", async () => {
    const res = await request(app2).get("/api/v1/disasters");
    expectContract(res, "/disasters");
    expect(res.body.meta).toMatchObject({ confirmingSources: { emsc: "ok", nhc: "ok", firms: "off" }, scoreVersion: 1 });
    const quake = res.body.data.find((e) => e.id === "usgs:us1");
    expect(quake.sources.map((s) => `${s.source}:${s.role}`)).toEqual(["usgs:primary", "emsc:confirming"]);
    expect(quake.confidence.score).toBe(80);
    expect(quake.priority.exposure).toEqual({ population: 250_000, radiusKm: 100 });
    const storm = res.body.data.find((e) => e.type === "storm");
    expect(storm.sources.map((s) => s.source)).toEqual(["eonet", "nhc"]);
    const flood = res.body.data.find((e) => e.type === "flood");
    expect(flood.sources.map((s) => `${s.source}:${s.role}`)).toEqual(["eonet:primary", "gdacs:listed"]);
    for (const e of res.body.data) expectContract(await request(app2).get(`/api/v1/disasters/${e.id}`), "/disasters/{id}");
  });

  it("the fields a v1 client already reads are unchanged and come first", async () => {
    const before = await request(app).get("/api/v1/disasters"); // fusion sources off: primary only
    const after = await request(app2).get("/api/v1/disasters");
    const ORIGINAL = ["id", "source", "type", "severity", "severityReason", "title", "place", "country", "lat", "lng", "occurredAt", "updatedAt", "status", "measurements", "alerts", "links"];
    for (const e of after.body.data) {
      expect(Object.keys(e).slice(0, ORIGINAL.length)).toEqual(ORIGINAL);
      const old = before.body.data.find((x) => x.id === e.id);
      for (const k of ORIGINAL) expect(e[k], `${e.id}.${k}`).toEqual(old[k]);
    }
  });

  it("minConfidence and minPriority filter on the scores and are validated", async () => {
    const all = await request(app2).get("/api/v1/disasters");
    const high = await request(app2).get("/api/v1/disasters?minConfidence=80");
    expectContract(high, "/disasters");
    expect(high.body.data.map((e) => e.id)).toEqual(all.body.data.filter((e) => e.confidence.score >= 80).map((e) => e.id));
    const prio = await request(app2).get("/api/v1/disasters?minPriority=1&minConfidence=0");
    expect(prio.body.meta.total).toBe(all.body.data.filter((e) => e.priority.score >= 1).length);
    for (const bad of ["minConfidence=101", "minPriority=-1", "minPriority=5.5", "minConfidence=high"]) {
      const res = await request(app2).get(`/api/v1/disasters?${bad}`);
      expect(res.status, bad).toBe(400);
      expectContract(res, "/disasters");
    }
  });

  it("without fusion the events are served unscored; a score filter is then a 503", async () => {
    const broken = express();
    broken.use("/api/v1", router({ rateLimit: { limit: 100_000 }, fusion: { fuse: async () => { throw new Error("fusion down"); } } }));
    const res = await request(broken).get("/api/v1/disasters");
    expectContract(res, "/disasters");
    expect(res.body.data.every((e) => e.confidence === null && e.priority === null && e.sources.length === 1)).toBe(true);
    expect(res.body.meta.confirmingSources).toEqual({ emsc: "error", nhc: "error", firms: "error" });
    const filtered = await request(broken).get("/api/v1/disasters?minConfidence=50");
    expect(filtered.status).toBe(503);
    expectContract(filtered, "/disasters");
  });
});
