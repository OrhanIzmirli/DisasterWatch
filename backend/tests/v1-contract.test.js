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

  it("405 bodies use the documented error schema", async () => {
    const res = await request(app).post("/api/v1/disasters");
    expect(res.status).toBe(405);
    const validate = ajv.compile(schemaFor({ $ref: "#/components/schemas/Error" }));
    expect(validate(res.body), ajv.errorsText(validate.errors)).toBe(true);
  });
});
