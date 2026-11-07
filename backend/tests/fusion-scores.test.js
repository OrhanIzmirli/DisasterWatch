/**
 * Confidence and priority scores (src/services/fusion/scores.js), the
 * population index (population.js) and the GeoNames build script: the
 * documented worked examples, edges, monotonicity (a confirmation never lowers
 * confidence, time never raises it) and unknown exposure. Invented data only.
 */
import { describe, it, expect } from "vitest";
import zlib from "node:zlib";
import {
  CONFIRMATION_CAP,
  confidenceScore,
  exposurePoints,
  exposureRadiusKm,
  priorityScore,
  PRIORITY_WEIGHTS,
  SCORE_VERSION,
  scoreEvents,
  severityPoints,
} from "../src/services/fusion/scores.js";
import { createPopulationIndex, loadPopulationIndex } from "../src/services/fusion/population.js";
import { parseGeonames, unzipFirst } from "../scripts/fetch-population.mjs";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const primary = (source) => ({ source, role: "primary" });
const quake = (extra = {}) => ({
  id: "usgs:a",
  source: "usgs",
  type: "earthquake",
  status: "reviewed",
  severity: "high",
  lat: 10,
  lng: 120,
  occurredAt: new Date(NOW - 3600_000).toISOString(),
  measurements: { magnitude: 6.2 },
  alerts: { usgsPager: null, gdacs: null },
  links: [],
  ...extra,
});
const fire = (extra = {}) => ({
  id: "eonet:F",
  source: "eonet",
  type: "wildfire",
  severity: "medium",
  lat: 0,
  lng: 0,
  occurredAt: new Date(NOW - 2 * 3600_000).toISOString(),
  measurements: { burnedAreaHa: 12000 },
  alerts: { gdacs: "orange" },
  links: [{ name: "GDACS", url: "https://www.gdacs.org/report.aspx?x=1" }],
  ...extra,
});

describe("confidence", () => {
  it("worked example 1: reviewed USGS quake + independent EMSC = 80", () => {
    const c = confidenceScore(quake(), [primary("usgs"), { source: "emsc", role: "confirming", agency: "GFZ" }], NOW);
    expect(c.score).toBe(80);
    expect(c.components.map((x) => [x.term, x.points])).toEqual([
      ["primary", 60],
      ["confirmation", 20],
    ]);
    expect(c.components[1].reason).toBe("EMSC: independent confirmation (solution by GFZ)");
  });

  it("automatic USGS solution and a relayed EMSC entry", () => {
    expect(confidenceScore(quake({ status: "automatic" }), [primary("usgs"), { source: "emsc", role: "listed", agency: "NEIC" }], NOW).score).toBe(50);
  });

  it("worked example 2: EONET fire from GDACS + FIRMS, two days old = 66", () => {
    const old = fire({ occurredAt: new Date(NOW - 50 * 3600_000).toISOString() });
    const c = confidenceScore(old, [primary("eonet"), { source: "firms", role: "confirming", detections: 7, timeDeltaSec: null }, { source: "gdacs", role: "listed", level: "orange" }], NOW);
    // 40 + 25 + 5 - floor((50 - 24) / 6) = 70 - 4
    expect(c.score).toBe(66);
    expect(c.components.at(-1)).toMatchObject({ term: "staleness", points: -4, reason: "last seen 50 h ago" });
  });

  it("a recent FIRMS detection counts as seen", () => {
    const old = fire({ occurredAt: new Date(NOW - 50 * 3600_000).toISOString() });
    const c = confidenceScore(old, [primary("eonet"), { source: "firms", role: "confirming", detections: 3, timeDeltaSec: 48 * 3600 }], NOW);
    expect(c.components.some((x) => x.term === "staleness")).toBe(false);
  });

  it("official EONET contributors raise the primary points", () => {
    const c = confidenceScore(fire({ links: [{ name: "IRWIN", url: "https://irwin.example" }] }), [primary("eonet")], NOW);
    expect(c.components[0]).toMatchObject({ points: 45, reason: "NASA EONET, reported by IRWIN" });
  });

  it("confirmations are capped at 40 and the score at 100", () => {
    const all = [primary("eonet"), { source: "nhc", role: "confirming" }, { source: "firms", role: "confirming", detections: 9 }, { source: "gdacs", role: "confirming", level: "red" }];
    const c = confidenceScore(fire({ links: [{ name: "JTWC", url: "https://x.example" }] }), all, NOW);
    expect(c.components.find((x) => x.term === "cap").points).toBe(CONFIRMATION_CAP - 70);
    expect(c.score).toBe(85);
  });

  it("monotone: adding a confirmation never lowers it, time never raises it", () => {
    const base = [primary("eonet")];
    let prev = confidenceScore(fire(), base, NOW).score;
    for (const s of [{ source: "gdacs", role: "listed" }, { source: "firms", role: "listed", detections: 1 }, { source: "nhc", role: "confirming" }, { source: "emsc", role: "confirming" }]) {
      base.push(s);
      const next = confidenceScore(fire(), base, NOW).score;
      expect(next).toBeGreaterThanOrEqual(prev);
      prev = next;
    }
    let last = 101;
    for (let h = 0; h <= 30 * 24; h += 7) {
      const s = confidenceScore(fire(), [primary("eonet")], NOW + h * 3600_000).score;
      expect(s).toBeLessThanOrEqual(last);
      last = s;
    }
    expect(last).toBe(20); // 40 - at most 20
  });

  it("earthquakes do not go stale", () => {
    expect(confidenceScore(quake(), [primary("usgs")], NOW + 20 * 24 * 3600_000).score).toBe(60);
  });
});

describe("priority", () => {
  const pop = (population) => ({ near: () => ({ population, places: 3 }) });

  it("severity takes the strongest measurement or level", () => {
    expect(severityPoints(quake({ measurements: { magnitude: 4.5 } }))).toEqual({ value: 20, basis: "magnitude 4.5" });
    expect(severityPoints(quake({ measurements: { magnitude: 7.5 } })).value).toBe(100);
    expect(severityPoints(quake({ measurements: { magnitude: 5 }, alerts: { usgsPager: "orange" } }))).toEqual({ value: 75, basis: "USGS PAGER orange" });
    expect(severityPoints(fire())).toEqual({ value: 75, basis: "12000 ha burned" }); // 20 + (log10(12000) - 2) * 80/3 ≈ 75 beats GDACS orange (60)
    expect(severityPoints(fire({ measurements: { burnedAreaHa: 500 } })).basis).toBe("GDACS orange alert");
    expect(severityPoints({ type: "storm", measurements: {}, alerts: {} }, [{ source: "nhc", windKts: 137 }])).toEqual({ value: 100, basis: "wind 137 kt" });
    expect(severityPoints({ type: "flood", severity: "unrated", measurements: {}, alerts: {} })).toEqual({ value: 15, basis: "rated unrated, no measurement" });
  });

  it("exposure points and radius", () => {
    expect([1000, 10_000, 1_000_000, 100_000_000, 1e9, 0].map(exposurePoints)).toEqual([0, 20, 60, 100, 100, 0]);
    expect([4.6, 5.5, 6.5, 7.2].map((m) => exposureRadiusKm(quake({ measurements: { magnitude: m } })))).toEqual([25, 50, 100, 200]);
    expect(exposureRadiusKm(fire())).toBe(25);
  });

  it("worked example: M6.2 quake, 1M people within 100 km, confidence 80 -> 66", () => {
    const p = priorityScore(quake(), [primary("usgs")], 80, pop(1_000_000));
    // severity 20 + 1.7 * 80/3 = 65; 0.45 * 65 + 0.35 * 60 + 0.20 * 80 = 29.25 + 21 + 16 = 66.25
    expect(p.score).toBe(66);
    expect(p.components.map((t) => [t.term, t.value, t.weight])).toEqual([
      ["severity", 65, 0.45],
      ["exposure", 60, 0.35],
      ["confidence", 80, 0.2],
    ]);
    expect(p.exposure).toEqual({ population: 1_000_000, radiusKm: 100 });
  });

  it("unknown exposure: the other weights are scaled up, exposure says why", () => {
    const p = priorityScore(quake(), [primary("usgs")], 80, null);
    expect(p.exposure).toBeNull();
    expect(p.components[1]).toEqual({ term: "exposure", value: null, weight: 0, basis: "population data not available" });
    expect(p.components[0].weight + p.components[2].weight).toBeCloseTo(1, 2);
    expect(p.score).toBe(70); // 65 * 0.692 + 80 * 0.308 = 69.6
  });

  it("weights sum to one; scoreEvents scores every event", () => {
    expect(Object.values(PRIORITY_WEIGHTS).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10);
    const scores = scoreEvents([quake(), fire()], new Map([["usgs:a", { sources: [primary("usgs")] }]]), { now: NOW, population: null });
    expect([...scores.keys()]).toEqual(["usgs:a", "eonet:F"]);
    expect(scores.get("eonet:F").confidence.components[0].term).toBe("primary");
    expect(SCORE_VERSION).toBe(1);
  });
});

describe("population", () => {
  it("sums the places within the radius, across the antimeridian too", () => {
    const idx = createPopulationIndex([
      [10, 120, 1000],
      [10.5, 120, 2000], // ~56 km
      [12, 120, 4000], // ~222 km
      [-17, 179.9, 100],
      [-17, -179.9, 200],
    ]);
    expect(idx.near(10, 120, 50)).toEqual({ population: 1000, places: 1 });
    expect(idx.near(10, 120, 100)).toEqual({ population: 3000, places: 2 });
    expect(idx.near(-17, 179.95, 25)).toEqual({ population: 300, places: 2 });
    expect(idx.near(10, 120, 100)).toBe(idx.near(10, 120, 100)); // memoised
  });

  it("a missing table means unknown exposure, not an error", () => {
    expect(loadPopulationIndex("/no/such/file.json", { warn: () => {} })).toBeNull();
  });

  it("build script: reads the first zip entry and keeps populated places only", () => {
    const tsv = [
      ["1", "Exampleton", "", "", "10.5", "20.25", "P", "PPL", "XX", "", "", "", "", "", "12000"],
      ["2", "Example Quarter", "", "", "10.5", "20.26", "P", "PPLX", "XX", "", "", "", "", "", "3000"],
      ["3", "Example Hill", "", "", "10.6", "20.3", "T", "HLL", "XX", "", "", "", "", "", "0"],
    ]
      .map((r) => r.join("\t"))
      .join("\n");
    const data = zlib.deflateRawSync(Buffer.from(tsv));
    const name = Buffer.from("cities.txt");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(0, 42);
    const cdOffset = local.length + name.length + data.length;
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt32LE(cdOffset, 16);
    const zip = Buffer.concat([local, name, data, central, name, eocd]);
    expect(parseGeonames(unzipFirst(zip).toString("utf8"))).toEqual([[10.5, 20.25, 12000]]);
    expect(() => unzipFirst(Buffer.from("not a zip at all, definitely not"))).toThrow(/not a zip/);
  });
});
