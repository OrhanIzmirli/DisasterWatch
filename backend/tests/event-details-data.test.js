/**
 * New event detail data: the nearest place of a quake (from the USGS place),
 * a storm's development (EONET geometry series), the countries GDACS lists,
 * and GDACS impact figures fetched on demand. Payloads are invented.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { buildEonetTimeline, buildUsgsDetails, buildEonetDetails, nearestPlaceFromUsgs, TIMELINE_MAX_POINTS } from "../src/utils/eventDetails.js";
import {
  createGdacsImpactClient,
  impactModelUrl,
  parseImpactRef,
  parsePopulationAffected,
  parseReportedImpacts,
} from "../src/services/gdacsImpact.js";

describe("nearestPlaceFromUsgs", () => {
  it("reads distance, direction and place from a USGS place", () => {
    expect(nearestPlaceFromUsgs("100 km SSE of Palekastro, Greece")).toEqual({ name: "Palekastro, Greece", distanceKm: 100, direction: "SSE" });
    expect(nearestPlaceFromUsgs("3 km N of Exampleville, CA")).toEqual({ name: "Exampleville, CA", distanceKm: 3, direction: "N" });
  });

  it("gives null for a region (no named place to measure from)", () => {
    expect(nearestPlaceFromUsgs("Fiji region")).toBeNull();
    expect(nearestPlaceFromUsgs("south of the Kermadec Islands")).toBeNull();
    expect(nearestPlaceFromUsgs(null)).toBeNull();
  });

  it("is part of every USGS item, and absent (null) on EONET items", () => {
    const usgs = buildUsgsDetails({ id: "x1", properties: { mag: 4.7, place: "100 km SSE of Palekastro, Greece", time: 0 }, geometry: { coordinates: [26, 34, 40] } });
    expect(usgs.nearestPlace).toEqual({ name: "Palekastro, Greece", distanceKm: 100, direction: "SSE" });
    expect(usgs.timeline).toBeNull();
    expect(usgs.affectedCountries).toBeNull();
  });
});

const point = (date, lng, lat, value, unit) => ({ date, type: "Point", coordinates: [lng, lat], magnitudeValue: value, magnitudeUnit: unit });

describe("buildEonetTimeline", () => {
  it("lists a storm's advisories oldest first with the wind in kts", () => {
    const tl = buildEonetTimeline(
      [point("2026-11-03T12:00:00Z", 88, 15, 90, "kts"), point("2026-11-03T00:00:00Z", 87, 14, 45, "kts"), point("2026-11-04T00:00:00Z", 89, 17, 55, "kts")],
      "storm"
    );
    expect(tl.map((p) => [p.at.slice(0, 13), p.value])).toEqual([
      ["2026-11-03T00", 45],
      ["2026-11-03T12", 90],
      ["2026-11-04T00", 55],
    ]);
    expect(tl[0]).toMatchObject({ unit: "kts", lat: 14, lng: 87 });
  });

  it("keeps the first and last of a long series and at most TIMELINE_MAX_POINTS", () => {
    const series = Array.from({ length: 100 }, (_, i) => point(new Date(Date.UTC(2026, 10, 1) + i * 3_600_000).toISOString(), 80, 10, 30 + i, "kts"));
    const tl = buildEonetTimeline(series, "storm");
    expect(tl).toHaveLength(TIMELINE_MAX_POINTS);
    expect(tl[0].value).toBe(30);
    expect(tl.at(-1).value).toBe(129);
  });

  it("gives null for a single entry, for floods, and a null value for an entry without a measurement", () => {
    expect(buildEonetTimeline([point("2026-11-03T00:00:00Z", 1, 1, 100, "hectare")], "wildfire")).toBeNull();
    expect(buildEonetTimeline([point("2026-11-03T00:00:00Z", 1, 1, null, null), point("2026-11-04T00:00:00Z", 1, 1, null, null)], "flood")).toBeNull();
    const tl = buildEonetTimeline([point("2026-11-03T00:00:00Z", 1, 1, null, null), point("2026-11-04T00:00:00Z", 1, 1, 500, "acres")], "wildfire");
    expect(tl[0].value).toBeNull();
    expect(tl[1].value).toBeCloseTo(202.3, 1); // acres -> ha
  });
});

describe("affectedCountries on EONET items", () => {
  const event = { id: "EONET_1", title: "Wildfire in Exampleland", categories: [{ id: "wildfires", title: "Wildfires" }], geometry: [point("2026-11-03T00:00:00Z", 1, 1, 100, "hectare")] };

  it("lists the codes GDACS gave for the event", () => {
    expect(buildEonetDetails({ ...event, gdacsPlace: { countries: ["AU", "PG"], lat: 1, lng: 1 } }, "wildfire").affectedCountries).toEqual(["AU", "PG"]);
  });

  it("is null (unknown) when GDACS has no answer, never an empty list", () => {
    expect(buildEonetDetails({ ...event, gdacsPlace: null }, "wildfire").affectedCountries).toBeNull();
    expect(buildEonetDetails({ ...event, gdacsPlace: { countries: [], lat: null, lng: null } }, "wildfire").affectedCountries).toBeNull();
  });
});

describe("GDACS impact parsing", () => {
  it("accepts only known event types and numeric ids", () => {
    expect(parseImpactRef("wf", "123")).toEqual({ eventtype: "WF", eventid: "123" });
    expect(parseImpactRef("EQ", "123")).toBeNull();
    expect(parseImpactRef("WF", "12a")).toBeNull();
    expect(parseImpactRef("WF", "../x")).toBeNull();
  });

  it("follows only an impact link on the GDACS export API", () => {
    const ok = { properties: { impacts: [{ resource: { impact: "https://www.gdacs.org/gdacsapi/api/export/getimpact?id=42" } }] } };
    expect(impactModelUrl(ok)).toBe("https://www.gdacs.org/gdacsapi/api/export/getimpact?id=42");
    for (const bad of ["https://example.com/gdacsapi/api/export/getimpact?id=42", "http://www.gdacs.org/gdacsapi/api/export/getimpact?id=42", "https://www.gdacs.org/other?id=42", "not a url"]) {
      expect(impactModelUrl({ properties: { impacts: [{ resource: { impact: bad } }] } })).toBeNull();
    }
  });

  it("reads POPAFFECTED and the latest reported impacts", () => {
    const model = { datums: [{ alias: "POP", source: "Population", datum: [{ scalars: { scalar: [{ name: "SUMPOP1.0", value: "5" }, { name: "POPAFFECTED", value: "1234" }] } }] }] };
    expect(parsePopulationAffected(model)).toBe(1234);
    expect(parsePopulationAffected({ datums: [] })).toBeNull();
    const payload = {
      properties: {
        sendai: [
          { latest: true, sendainame: "rescued", sendaivalue: "3", region: "North", country: "Exampleland" },
          { latest: false, sendainame: "rescued", sendaivalue: "1", region: "North", country: "Exampleland" },
          { latest: true, sendainame: "houses damaged", sendaivalue: "12", region: "South", country: "Exampleland" },
        ],
      },
    };
    expect(parseReportedImpacts(payload)).toEqual([
      { kind: "rescued", value: 3, region: "North", country: "Exampleland" },
      { kind: "houses damaged", value: 12, region: "South", country: "Exampleland" },
    ]);
  });
});

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe("createGdacsImpactClient", () => {
  const eventPayload = {
    properties: {
      impacts: [{ resource: { impact: "https://www.gdacs.org/gdacsapi/api/export/getimpact?id=7" } }],
      sendai: [{ latest: true, sendainame: "evacuated", sendaivalue: "40", region: "East", country: "Exampleland" }],
    },
  };
  const model = { datums: [{ alias: "POP", datum: [{ scalars: { scalar: [{ name: "POPAFFECTED", value: "250" }] } }] }] };

  it("combines the event's reported impacts with the model's population and caches the answer", async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).includes("getimpact") ? json(model) : json(eventPayload)));
    const client = createGdacsImpactClient({ fetchImpl, now: () => Date.parse("2026-11-07T00:00:00Z") });
    const a = await client.getImpact({ eventtype: "WF", eventid: "1" });
    expect(a).toEqual({ populationAffected: 250, reported: [{ kind: "evacuated", value: 40, region: "East", country: "Exampleland" }], fetchedAt: "2026-11-07T00:00:00.000Z" });
    await client.getImpact({ eventtype: "WF", eventid: "1" });
    expect(fetchImpl).toHaveBeenCalledTimes(2); // event + model, then served from the cache
    expect(fetchImpl.mock.calls.every(([url]) => String(url).startsWith("https://www.gdacs.org/"))).toBe(true);
  });

  it("keeps the event's figures with an unknown population when only the model fails", async () => {
    const fetchImpl = vi.fn(async (url) => (String(url).includes("getimpact") ? json({}, 500) : json(eventPayload)));
    const a = await createGdacsImpactClient({ fetchImpl }).getImpact({ eventtype: "WF", eventid: "1" });
    expect(a.populationAffected).toBeNull();
    expect(a.reported).toHaveLength(1);
  });

  it("answers null when GDACS cannot be reached", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("timeout");
    });
    expect(await createGdacsImpactClient({ fetchImpl }).getImpact({ eventtype: "FL", eventid: "9" })).toBeNull();
  });
});

describe("GET /disasters/impact", () => {
  it("rejects an invalid reference and maps an unreachable GDACS to 503", async () => {
    const { gdacsImpactClient } = await import("../src/services/gdacsImpact.js");
    const { createTestApp } = await import("./helpers.js");
    const app = createTestApp();
    expect((await request(app).get("/disasters/impact?eventtype=EQ&eventid=1")).status).toBe(400);

    const spy = vi.spyOn(gdacsImpactClient, "getImpact").mockResolvedValueOnce(null);
    expect((await request(app).get("/disasters/impact?eventtype=WF&eventid=1")).status).toBe(503);

    spy.mockResolvedValueOnce({ populationAffected: null, reported: [], fetchedAt: "2026-11-07T00:00:00.000Z" });
    const ok = await request(app).get("/disasters/impact?eventtype=FL&eventid=2");
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ populationAffected: null, reported: [], fetchedAt: "2026-11-07T00:00:00.000Z", source: "GDACS" });
    spy.mockRestore();
  });
});
