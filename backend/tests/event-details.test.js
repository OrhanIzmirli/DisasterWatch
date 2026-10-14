import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { assessSeverity, severityFromMag, severityFromType, EARTHQUAKE_HIGH_MAG, EARTHQUAKE_MEDIUM_MAG } from "../src/utils/severity.js";
import { cleanTitle, placeFromEonetTitle, buildUsgsDetails, buildEonetDetails } from "../src/utils/eventDetails.js";
import { normalizeNasaEvents } from "../src/utils/normalizeDisasters.js";
import { normalizeUsgsEarthquakes } from "../src/services/usgs.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name) => JSON.parse(fs.readFileSync(path.join(here, "fixtures", name), "utf8"));

const USGS = fixture("usgs-feature.json"); // M 6.0 Kokopo, PAGER green, reviewed
const FIRE = fixture("eonet-wildfire.json"); // Wildfire in Botswana 1032764, 6889 hectare, GDACS
const STORM = fixture("eonet-storm.json"); // Hurricane Simon, 80 kts, JTWC, open
const FLOOD = fixture("eonet-flood.json"); // Flood in Nepal 1104225, polygon

describe("cleanTitle", () => {
  it.each([
    ["Wildfire in Tanzania 1032766", "Wildfire in Tanzania"],
    ["Flood in Nepal 1104225", "Flood in Nepal"],
    ["Wildfire in Botswana 1032764", "Wildfire in Botswana"],
    ["Hurricane Simon", "Hurricane Simon"],
    ["M 6.0 - 126 km S of Kokopo, Papua New Guinea", "M 6.0 - 126 km S of Kokopo, Papua New Guinea"],
    ["Wildfire Buckhorn 2, Cassia, Idaho", "Wildfire Buckhorn 2, Cassia, Idaho"], // short number is not an id
    ["  Severe   Storm,  central Poland  ", "Severe Storm, central Poland"],
    ["", ""],
    [null, ""],
  ])("%j -> %j", (input, expected) => {
    expect(cleanTitle(input)).toBe(expected);
  });
});

describe("placeFromEonetTitle", () => {
  it("takes the part after 'in' and drops the trailing id", () => {
    expect(placeFromEonetTitle("Wildfire in Tanzania 1032766")).toBe("Tanzania");
    expect(placeFromEonetTitle("Flood in Nepal 1104225")).toBe("Nepal");
    expect(placeFromEonetTitle("Wildfire in Mongolia, China 1032753")).toBe("Mongolia, China");
  });

  it("keeps titles without 'in' as they are", () => {
    expect(placeFromEonetTitle("Hurricane Simon")).toBe("Hurricane Simon");
  });
});

describe("severity rules and their explanations agree", () => {
  it.each([
    [7.2, "high", "High: magnitude 7.2 (≥ 6.0)"],
    [6.0, "high", "High: magnitude 6.0 (≥ 6.0)"],
    [5.9, "medium", "Medium: magnitude 5.9 (5.0–5.9)"],
    [5.0, "medium", "Medium: magnitude 5.0 (5.0–5.9)"],
    [4.9, "low", "Low: magnitude 4.9 (< 5.0)"],
    [4.5, "low", "Low: magnitude 4.5 (< 5.0)"],
  ])("earthquake M%s -> %s", (mag, severity, reason) => {
    expect(assessSeverity({ type: "earthquake", magnitude: mag })).toEqual({ severity, reason });
    expect(severityFromMag(mag)).toBe(severity);
  });

  it("earthquake without a magnitude is low and says so", () => {
    expect(assessSeverity({ type: "earthquake", magnitude: null })).toEqual({
      severity: "low",
      reason: "Low: magnitude not reported by source",
    });
  });

  it("EONET types use fixed ratings with matching sentences", () => {
    expect(assessSeverity({ type: "wildfire" })).toEqual({
      severity: "high",
      reason: "High: wildfires are always rated high (no intensity data from the source)",
    });
    expect(assessSeverity({ type: "storm" })).toEqual({ severity: "medium", reason: "Medium: severe storms are always rated medium" });
    expect(assessSeverity({ type: "flood" })).toEqual({ severity: "medium", reason: "Medium: floods are always rated medium" });
    expect(assessSeverity({ type: "volcano" })).toEqual({ severity: "low", reason: "Low: no severity rule for this event type" });
    for (const t of ["wildfire", "storm", "flood", "other"]) {
      expect(severityFromType(t)).toBe(assessSeverity({ type: t }).severity);
    }
  });

  it("the reason sentence always starts with the rating it explains", () => {
    const cases = [
      { type: "earthquake", magnitude: 6.5 },
      { type: "earthquake", magnitude: 5.5 },
      { type: "earthquake", magnitude: 4.6 },
      { type: "wildfire" },
      { type: "storm" },
      { type: "flood" },
    ];
    for (const c of cases) {
      const { severity, reason } = assessSeverity(c);
      expect(reason.toLowerCase().startsWith(`${severity}:`)).toBe(true);
    }
  });

  it("thresholds exported for documentation match the rule", () => {
    expect(EARTHQUAKE_HIGH_MAG).toBe(6.0);
    expect(EARTHQUAKE_MEDIUM_MAG).toBe(5.0);
  });
});

describe("buildUsgsDetails (real feature)", () => {
  const d = buildUsgsDetails(USGS);

  it("carries the source fields through without inventing anything", () => {
    expect(d).toMatchObject({
      eventId: "usgs:us6000u24c",
      source: "usgs",
      category: "Earthquake",
      cleanTitle: "M 6.0 - 126 km S of Kokopo, Papua New Guinea",
      place: "126 km S of Kokopo, Papua New Guinea",
      status: "reviewed",
      magnitude: 6,
      magType: "mww",
      pagerAlert: "green",
      tsunami: false,
      feltReports: 1,
      severity: "high",
      severityReason: "High: magnitude 6.0 (≥ 6.0)",
      magnitudeValue: null,
      magnitudeUnit: null,
    });
    expect(d.depthKm).toBeCloseTo(20.842, 3);
    expect(d.occurredAt).toBe(new Date(USGS.properties.time).toISOString());
    expect(d.updatedAt).toBe(new Date(USGS.properties.updated).toISOString());
    expect(d.sources).toEqual([{ name: "USGS event page", url: USGS.properties.url }]);
  });

  it("reports null for fields the source leaves empty", () => {
    const sparse = {
      id: "x1",
      properties: { mag: 4.6, place: "somewhere", time: 1791754460893, alert: null, felt: null, tsunami: 0, status: "automatic", title: "M 4.6 - somewhere" },
      geometry: { coordinates: [10, 20] }, // no depth
    };
    const s = buildUsgsDetails(sparse);
    expect(s).toMatchObject({ pagerAlert: null, feltReports: null, depthKm: null, tsunami: false, status: "automatic", updatedAt: null, magType: null });
    expect(s.sources).toEqual([]);
  });

  it("ignores PAGER values outside the documented levels", () => {
    expect(buildUsgsDetails({ id: "x", properties: { mag: 5, alert: "purple", time: 1 }, geometry: {} }).pagerAlert).toBeNull();
    expect(buildUsgsDetails({ id: "x", properties: { mag: 5, alert: "RED", time: 1 }, geometry: {} }).pagerAlert).toBe("red");
  });
});

describe("buildEonetDetails (real events)", () => {
  it("wildfire: category, hectares, GDACS source, closed status", () => {
    const d = buildEonetDetails(FIRE, "wildfire", FIRE.geometry.at(-1));
    expect(d).toMatchObject({
      eventId: "nasa:EONET_25271",
      source: "nasa",
      category: "Wildfires",
      cleanTitle: "Wildfire in Botswana",
      place: "Botswana",
      status: "closed",
      magnitudeValue: 6889,
      magnitudeUnit: "hectare",
      magnitude: null,
      pagerAlert: null,
      tsunami: null,
      feltReports: null,
      severity: "high",
    });
    expect(d.sources[0]).toEqual({ name: "NASA EONET", url: FIRE.link });
    expect(d.sources.map((s) => s.name)).toContain("GDACS");
    expect(d.occurredAt).toBe("2026-10-11T19:00:00.000Z");
  });

  it("storm: open status, wind speed in kts from the latest geometry, JTWC source", () => {
    const d = buildEonetDetails(STORM, "storm", STORM.geometry.at(-1));
    expect(d).toMatchObject({
      eventId: "nasa:EONET_25094",
      category: "Severe Storms",
      cleanTitle: "Hurricane Simon",
      place: "Hurricane Simon",
      status: "open",
      magnitudeValue: 80,
      magnitudeUnit: "kts",
      severity: "medium",
      severityReason: "Medium: severe storms are always rated medium",
    });
    expect(d.sources.map((s) => s.name)).toEqual(["NASA EONET", "JTWC"]);
    expect(d.updatedAt).toBe("2026-10-13T12:00:00.000Z");
  });

  it("flood: polygon geometry, no magnitude, dates still resolved", () => {
    const d = buildEonetDetails(FLOOD, "flood", FLOOD.geometry[0]);
    expect(d).toMatchObject({ category: "Floods", cleanTitle: "Flood in Nepal", place: "Nepal", magnitudeValue: null, magnitudeUnit: null, severity: "medium" });
    expect(d.occurredAt).not.toBeNull();
  });
});

describe("normalizers stay backwards compatible", () => {
  const OLD_KEYS = ["id", "type", "location", "meta", "severity", "timeMinutesAgo", "description", "lat", "lng"];

  it("EONET items keep every old field with the old values and gain `details`", () => {
    const [item] = normalizeNasaEvents([FIRE]);
    for (const k of OLD_KEYS) expect(item).toHaveProperty(k);
    expect(item).toMatchObject({
      type: "wildfire",
      location: "Wildfire in Botswana 1032764", // raw title, as before
      severity: "high",
      description: "Wildfire in Botswana", // title fallback without the source id (shown in Today's events)
    });
    expect(item.meta).toMatch(/^Wildfires • \d+ min ago$/);
    expect(typeof item.id).toBe("number");
    expect(item.lat).toBeCloseTo(-18.2436, 3);
    expect(item.details.eventId).toBe("nasa:EONET_25271");
    expect(item.details.severity).toBe(item.severity);
  });

  it("USGS items keep every old field with the old values and gain `details`", () => {
    const [item] = normalizeUsgsEarthquakes([USGS], { minMag: 4.5 });
    for (const k of OLD_KEYS) expect(item).toHaveProperty(k);
    expect(item).toMatchObject({
      type: "earthquake",
      location: "126 km S of Kokopo, Papua New Guinea",
      severity: "high",
      description: "Earthquake detected • Magnitude 6.0",
    });
    expect(item.meta).toMatch(/^Mag 6\.0 • \d+ min ago$/);
    expect(item.details.eventId).toBe("usgs:us6000u24c");
    expect(item.details.pagerAlert).toBe("green");
    expect(item.details.severity).toBe(item.severity);
  });

  it("the same id is produced for the same source id as before (hash of the raw id)", () => {
    const [a] = normalizeUsgsEarthquakes([USGS], { minMag: 4.5 });
    const [b] = normalizeUsgsEarthquakes([{ ...USGS, properties: { ...USGS.properties, mag: 5.1 } }], { minMag: 4.5 });
    expect(a.id).toBe(b.id);
  });
});
