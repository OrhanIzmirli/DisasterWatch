/**
 * Public API v1 model and query handling (src/api/v1/events.js): mapping from
 * the source payloads, GDACS reduced to level + link, the 30-day window,
 * parameter validation, filters (bbox across the antimeridian too) and cursor paging.
 */
import { describe, it, expect } from "vitest";
import {
  BadRequest,
  buildEvents,
  createEventCache,
  decodeCursor,
  encodeCursor,
  matches,
  parseListQuery,
  selectPage,
  WINDOW_MS,
} from "../src/api/v1/events.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();

const quake = (id, mag, hoursAgo, place = "53 km S of Kushiro, Japan", lng = 144.4, lat = 42.5) => ({
  id,
  properties: { mag, place, time: NOW - hoursAgo * 3600_000, updated: NOW, url: `https://example.org/${id}`, status: "reviewed", alert: "green", tsunami: 0, magType: "mww" },
  geometry: { coordinates: [lng, lat, 35] },
});

const FIRE = {
  id: "EONET_10",
  title: "Wildfire in Botswana 1032764",
  categories: [{ id: "wildfires", title: "Wildfires" }],
  geometry: [{ date: ago(5), type: "Point", coordinates: [25.2, -18.2], magnitudeValue: 12000, magnitudeUnit: "ha" }],
  sources: [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1032764" }],
  link: "https://eonet.gsfc.nasa.gov/api/v3/events/EONET_10",
  gdacs: { level: "orange", score: 1.7 },
  // where GDACS places it: must not reach the public model
  gdacsPlace: { lat: 10, lng: 10, countries: ["ZA"] },
};

describe("buildEvents", () => {
  const events = buildEvents({ nasa: [FIRE], usgs: [quake("us1", 6.2, 2), quake("us2", 4.8, 24 * 31)] }, NOW);

  it("maps both sources to the public model, newest first, inside 30 days", () => {
    // us1 is 2 h old, the fire 5 h, us2 31 days (outside the window)
    expect(events.map((e) => e.id)).toEqual(["usgs:us1", "eonet:EONET_10"]);
    const q = events.find((e) => e.id === "usgs:us1");
    expect(q).toMatchObject({
      source: "usgs",
      type: "earthquake",
      severity: "high",
      country: "Japan",
      lat: 42.5,
      lng: 144.4,
      measurements: { magnitude: 6.2, magnitudeType: "mww", depthKm: 35, burnedAreaHa: null },
      alerts: { usgsPager: "green", tsunami: false, gdacs: null },
      links: [{ name: "USGS event page", url: "https://example.org/us1" }],
    });
  });

  it("keeps only the GDACS level and report link; coordinates stay EONET's", () => {
    const fire = events.find((e) => e.id === "eonet:EONET_10");
    expect(fire).toMatchObject({ source: "eonet", type: "wildfire", severity: "medium", lat: -18.2, lng: 25.2, alerts: { gdacs: "orange" } });
    expect(fire.links.map((l) => l.url)).toContain("https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1032764");
    const json = JSON.stringify(fire);
    expect(json).not.toMatch(/score|affectedCountries|1\.7|"ZA"/);
  });

  it("an event exactly at the window edge is kept, one just past it is not", () => {
    const edge = buildEvents({ nasa: null, usgs: [quake("in", 5, WINDOW_MS / 3600_000), quake("out", 5, WINDOW_MS / 3600_000 + 0.01)] }, NOW);
    expect(edge.map((e) => e.id)).toEqual(["usgs:in"]);
  });
});

describe("createEventCache", () => {
  const at = (msAgo) => ({ id: `e${msAgo}`, occurredAt: new Date(NOW - msAgo).toISOString() });

  it("builds only when a source payload changes", () => {
    let builds = 0;
    const cache = createEventCache(() => (builds++, [at(1000)]));
    const served = { nasa: [], usgs: [] };
    cache(served, NOW);
    cache(served, NOW + 1000);
    cache(served, NOW + 61_000); // a minute later: only the window is re-applied
    expect(builds).toBe(1);
    cache({ ...served, usgs: [] }, NOW + 62_000);
    expect(builds).toBe(2);
  });

  it("keeps the same array while the same events are in the window (the fusion keys its matches on it)", () => {
    const old = at(WINDOW_MS - 30_000); // leaves the window in 30 s
    const cache = createEventCache(() => [at(1000), old]);
    const served = { nasa: [], usgs: [] };
    const first = cache(served, NOW);
    expect(first).toHaveLength(2);
    expect(cache(served, NOW + 25_000)).toBe(first); // same minute
    expect(cache(served, NOW + 20_000 + 0)).toBe(first);
    const later = cache(served, NOW + 61_000); // the old one has left
    expect(later).not.toBe(first);
    expect(later.map((e) => e.id)).toEqual(["e1000"]);
    expect(cache(served, NOW + 125_000)).toBe(later); // nothing else left: same array again
  });
});

describe("parseListQuery", () => {
  const bad = (q) => {
    expect(() => parseListQuery(q)).toThrow(BadRequest);
  };

  it("defaults", () => {
    expect(parseListQuery({})).toMatchObject({ limit: 50, types: undefined, bbox: undefined, cursor: undefined });
  });

  it("accepts and normalises valid values", () => {
    const f = parseListQuery({ type: "Earthquake, flood", severity: "high,unrated", minSeverity: "medium", from: "2026-11-01", to: "2026-11-07T10:00:00Z", bbox: "170,-50,-170,-10", country: "Japan", limit: "200" });
    expect(f).toMatchObject({ types: ["earthquake", "flood"], severities: ["high", "unrated"], minSeverity: "medium", country: "japan", limit: 200 });
    expect(f.bbox).toEqual({ minLng: 170, minLat: -50, maxLng: -170, maxLat: -10 });
    expect(f.from).toBe(Date.parse("2026-11-01"));
  });

  it("rejects unknown parameters, values and malformed input", () => {
    bad({ typ: "flood" });
    bad({ type: "volcano" });
    bad({ minSeverity: "unrated" });
    bad({ minSeverity: "low,high" });
    bad({ limit: "0" });
    bad({ limit: "201" });
    bad({ limit: "10.5" });
    bad({ from: "yesterday" });
    bad({ from: "2026-11-07", to: "2026-11-01" });
    bad({ bbox: "1,2,3" });
    bad({ bbox: "0,10,10,0" }); // minLat above maxLat
    bad({ bbox: "0,0,200,10" });
    bad({ type: ["flood", "storm"] }); // repeated parameter
    bad({ cursor: "not-a-cursor" });
    bad({ country: "" });
    bad({ minConfidence: "101" });
    bad({ minPriority: "-5" });
    bad({ minPriority: "1e2" });
  });

  it("score minimums: integers 0-100; an unscored event never passes one", () => {
    expect(parseListQuery({ minConfidence: "0", minPriority: "100" })).toMatchObject({ minConfidence: 0, minPriority: 100 });
    const scored = { type: "earthquake", severity: "high", occurredAt: new Date(NOW).toISOString(), lat: 0, lng: 0, confidence: { score: 70 }, priority: { score: 40 } };
    expect(matches(scored, parseListQuery({ minConfidence: "70" }))).toBe(true);
    expect(matches(scored, parseListQuery({ minConfidence: "71" }))).toBe(false);
    expect(matches(scored, parseListQuery({ minPriority: "41" }))).toBe(false);
    expect(matches({ ...scored, confidence: null, priority: null }, parseListQuery({ minConfidence: "0" }))).toBe(false);
    expect(matches({ ...scored, confidence: null }, parseListQuery({}))).toBe(true);
  });
});

describe("filters and paging", () => {
  const events = buildEvents(
    {
      nasa: [FIRE],
      usgs: [quake("a", 6.5, 1), quake("b", 5.5, 2), quake("c", 4.6, 3, "Fiji region", 179.5, -17), quake("d", 4.7, 3, "Tonga", -175, -20)],
    },
    NOW
  );
  const f = (q) => parseListQuery(q);

  it("type, severity and minSeverity", () => {
    expect(events.filter((e) => matches(e, f({ type: "wildfire" }))).map((e) => e.id)).toEqual(["eonet:EONET_10"]);
    expect(events.filter((e) => matches(e, f({ minSeverity: "medium" }))).map((e) => e.id)).toEqual(["usgs:a", "usgs:b", "eonet:EONET_10"]);
    expect(events.filter((e) => matches(e, f({ severity: "low" }))).map((e) => e.id).sort()).toEqual(["usgs:c", "usgs:d"]);
  });

  it("bbox, including one across the antimeridian, and country", () => {
    expect(events.filter((e) => matches(e, f({ bbox: "170,-30,-170,-10" }))).map((e) => e.id).sort()).toEqual(["usgs:c", "usgs:d"]);
    expect(events.filter((e) => matches(e, f({ bbox: "20,-20,30,-15" }))).map((e) => e.id)).toEqual(["eonet:EONET_10"]);
    expect(events.filter((e) => matches(e, f({ country: "japan" }))).map((e) => e.id)).toEqual(["usgs:a", "usgs:b"]);
  });

  it("from/to", () => {
    expect(events.filter((e) => matches(e, f({ from: ago(2.5) }))).map((e) => e.id)).toEqual(["usgs:a", "usgs:b"]);
    expect(events.filter((e) => matches(e, f({ to: ago(2.5) }))).map((e) => e.id)).not.toContain("usgs:a");
  });

  it("cursor paging walks every event once, in order", () => {
    const seen = [];
    let cursor;
    let pages = 0;
    do {
      const { page, total, nextCursor } = selectPage(events, f({ limit: "2", ...(cursor ? { cursor } : {}) }));
      expect(total).toBe(events.length);
      seen.push(...page.map((e) => e.id));
      cursor = nextCursor;
      pages++;
    } while (cursor && pages < 10);
    expect(seen).toEqual(events.map((e) => e.id));
    expect(pages).toBe(3);
  });

  it("a cursor round-trips and survives the event it points to leaving the feed", () => {
    const c = encodeCursor(events[1]);
    expect(decodeCursor(c)).toEqual({ occurredAt: events[1].occurredAt, id: events[1].id });
    const without = events.filter((e) => e.id !== events[1].id);
    const { page } = selectPage(without, f({ cursor: c, limit: "200" }));
    expect(page.map((e) => e.id)).toEqual(events.slice(2).map((e) => e.id));
  });
});
