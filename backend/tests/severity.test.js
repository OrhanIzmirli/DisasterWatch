/**
 * Severity from the source: GDACS impact level first (wildfires, floods),
 * calibrated size thresholds as the wildfire fallback, Saffir-Simpson on the
 * peak advisory wind for storms, "unrated" when nothing can be rated.
 * Pure unit tests (no database, no network).
 */
import { describe, it, expect } from "vitest";
import {
  assessSeverity,
  assessEonetEvent,
  toHectares,
  toKnots,
  saffirSimpson,
  severityFromMag,
  UNRATED_REASON,
  STORM_HIGH_KTS,
  STORM_MEDIUM_KTS,
  WILDFIRE_HIGH_HA,
  WILDFIRE_MEDIUM_HA,
  ACRES_TO_HA,
} from "../src/utils/severity.js";
import { buildEonetDetails } from "../src/utils/eventDetails.js";
import { nasaEventsToContract } from "../src/events/mappers.js";

const fire = (value, unit, gdacsLevel = null) => assessSeverity({ type: "wildfire", magnitudeValue: value, magnitudeUnit: unit, gdacsLevel });
const flood = (gdacsLevel = null) => assessSeverity({ type: "flood", gdacsLevel });
const storm = (peakKts, currentKts = peakKts) => assessSeverity({ type: "storm", peakKts, currentKts });

describe("thresholds (calibrated on 90 days of EONET data, see README)", () => {
  it("are the documented ones", () => {
    expect([STORM_MEDIUM_KTS, STORM_HIGH_KTS]).toEqual([64, 96]);
    expect([WILDFIRE_MEDIUM_HA, WILDFIRE_HIGH_HA]).toEqual([7_000, 10_000]);
    expect(ACRES_TO_HA).toBeCloseTo(0.40469, 5);
  });
});

describe("GDACS impact level is primary for wildfires and floods", () => {
  it.each([
    ["green", "low"],
    ["orange", "medium"],
    ["red", "high"],
    ["Red", "high"],
  ])("level %s -> %s", (level, severity) => {
    expect(fire(5_604, "hectare", level).severity).toBe(severity);
    expect(flood(level).severity).toBe(severity);
  });

  it("beats the size rule in both directions", () => {
    expect(fire(47_910, "hectare", "green").severity).toBe("low"); // huge but Green
    expect(fire(1_568, "hectare", "orange").severity).toBe("medium"); // small but Orange
  });

  it("explains the level and keeps the burned area in the sentence", () => {
    expect(fire(18_310, "hectare", "orange").reason).toBe("Medium: GDACS impact level Orange (18,310 ha burned)");
    expect(fire(null, null, "red").reason).toBe("High: GDACS impact level Red");
    expect(flood("green").reason).toBe("Low: GDACS impact level Green");
  });

  it("ignores an unknown level and falls back", () => {
    expect(fire(12_000, "hectare", "purple").severity).toBe("high");
    expect(flood("purple")).toEqual({ severity: "unrated", reason: UNRATED_REASON });
  });
});

describe("wildfire fallback: burned area in hectares", () => {
  it.each([
    [6_999, "low"],
    [7_000, "medium"],
    [9_999, "medium"],
    [10_000, "high"],
    [202, "low"],
    [43_703, "high"],
  ])("%s hectare -> %s", (ha, severity) => {
    expect(fire(ha, "hectare").severity).toBe(severity);
  });

  it("converts acres to hectares in one place (acres × 0.40469)", () => {
    expect(toHectares(24_710, "acres")).toBeCloseTo(9_999.9, 0); // just under 10,000 ha
    expect(toHectares(24_711, "acres")).toBeCloseTo(10_000.3, 0);
    expect(toHectares(17_298, "acres")).toBeCloseTo(7_000.3, 0);
    expect(toHectares(500, "hectare")).toBe(500);
    expect(toHectares(500, "ha")).toBe(500);
    expect(toHectares(500, "km2")).toBeNull();
    expect(toHectares(null, "hectare")).toBeNull();
    expect(toHectares(-1, "hectare")).toBeNull();
  });

  it("rates US (IRWIN) fires reported in acres on the converted value", () => {
    expect(fire(24_711, "acres").severity).toBe("high");
    expect(fire(17_298, "acres").severity).toBe("medium");
    expect(fire(5_019, "acres").severity).toBe("low"); // 2,031 ha
    expect(fire(24_711, "acres").reason).toBe("High: 10,000 ha burned (≥ 10,000 ha)");
  });

  it("explains the rating in hectares from the same thresholds", () => {
    expect(fire(9_965, "hectare").reason).toBe("Medium: 9,965 ha burned (7,000–9,999 ha)");
    expect(fire(15_293, "hectare").reason).toBe("High: 15,293 ha burned (≥ 10,000 ha)");
    expect(fire(5_604, "hectare").reason).toBe("Low: 5,604 ha burned (< 7,000 ha)");
  });

  it("accepts a pre-normalised areaHa", () => {
    expect(assessSeverity({ type: "wildfire", areaHa: 10_000 }).severity).toBe("high");
    expect(assessSeverity({ type: "wildfire", areaHa: 6_999 }).severity).toBe("low");
  });

  it("is unrated without a value, with an unknown unit, or for a flood without a level", () => {
    expect(fire(null, null)).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(fire(5_000, "km2")).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(flood()).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(assessSeverity({ type: "flood", magnitudeValue: 12, magnitudeUnit: "NM^2" }).severity).toBe("unrated");
  });
});

describe("storm: Saffir-Simpson on the peak advisory wind, current wind reported", () => {
  it.each([
    [63, "low"],
    [64, "medium"],
    [95, "medium"],
    [96, "high"],
    [155, "high"],
    [20, "low"],
  ])("peak %s kts -> %s", (kts, severity) => {
    expect(storm(kts, 30).severity).toBe(severity);
  });

  it("rates the peak, not the current wind (a decayed hurricane stays high)", () => {
    expect(storm(135, 55)).toEqual({ severity: "high", reason: "High: peak wind 135 kts (Saffir-Simpson category 4, ≥ 96 kts), now 55 kts" });
    expect(storm(85, 60).reason).toBe("Medium: peak wind 85 kts (Saffir-Simpson category 2, 64–95 kts), now 60 kts");
    expect(storm(50, 30).reason).toBe("Low: peak wind 50 kts (tropical storm, below hurricane strength, < 64 kts), now 30 kts");
    expect(storm(65, 65).reason).toBe("Medium: peak wind 65 kts (Saffir-Simpson category 1, 64–95 kts), now 65 kts");
  });

  it("Saffir-Simpson categories", () => {
    expect([33, 34, 64, 83, 96, 113, 137].map(saffirSimpson)).toEqual([
      "tropical depression, below hurricane strength",
      "tropical storm, below hurricane strength",
      "Saffir-Simpson category 1",
      "Saffir-Simpson category 2",
      "Saffir-Simpson category 3",
      "Saffir-Simpson category 4",
      "Saffir-Simpson category 5",
    ]);
  });

  it("falls back to a single magnitude value in kts, and is unrated without a wind", () => {
    expect(assessSeverity({ type: "storm", magnitudeValue: 100, magnitudeUnit: "kts" }).severity).toBe("high");
    expect(assessSeverity({ type: "storm", magnitudeValue: 100, magnitudeUnit: "mph" })).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(assessSeverity({ type: "storm" })).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(toKnots(70, "knots")).toBe(70);
    expect(toKnots(70, "mph")).toBeNull();
  });
});

describe("earthquakes and unknown types", () => {
  it("earthquake rules are unchanged (rounded magnitude 6.0 high, 5.0–5.9 medium, < 5.0 low)", () => {
    expect(severityFromMag(5.95)).toBe("high");
    expect(severityFromMag(5.0)).toBe("medium");
    expect(severityFromMag(4.94)).toBe("low");
    expect(assessSeverity({ type: "earthquake", magnitude: null }).severity).toBe("low");
  });

  it("types without a rule are unrated", () => {
    expect(assessSeverity({ type: "volcano" }).severity).toBe("unrated");
  });
});

describe("EONET event -> rating, details and Kafka contract agree", () => {
  const event = ({ unit = "hectare", values = [1, 5_604], category = "Wildfires", gdacs = undefined, sources = [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1" }] } = {}) => ({
    id: "EONET_1",
    title: "Wildfire in Testland 1",
    categories: [{ id: category.toLowerCase().replace(" ", ""), title: category }],
    sources,
    ...(gdacs !== undefined ? { gdacs } : {}),
    geometry: values.map((v, i) => ({ date: `2026-10-1${i}T00:00:00Z`, type: "Point", coordinates: [10, 20], magnitudeValue: v, magnitudeUnit: unit })),
  });

  it("uses the attached GDACS level and keeps the measurement", () => {
    const ev = event({ gdacs: { level: "orange", score: 2, text: "Orange impact" } });
    const r = assessEonetEvent(ev, "wildfire");
    expect(r).toMatchObject({ severity: "medium", gdacsLevel: "orange", gdacsScore: 2, areaHa: 5_604, magnitudeValue: 5_604, magnitudeUnit: "hectare" });
    const d = buildEonetDetails(ev, "wildfire");
    expect(d).toMatchObject({ severity: "medium", gdacsLevel: "orange", severityReason: "Medium: GDACS impact level Orange (5,604 ha burned)", severitySource: "Impact level assigned by GDACS (gdacs.org)" });
  });

  it("without a level (GDACS unreachable or a US fire) the size rule applies and the source says so", () => {
    const d = buildEonetDetails(event({ gdacs: null, values: [1, 24_711], unit: "acres" }), "wildfire");
    expect(d).toMatchObject({ severity: "high", gdacsLevel: null, severitySource: "Severity rule applied to the burned area reported by EONET (no GDACS level for this fire)" });
    expect(d.areaHa).toBeCloseTo(10_000.3, 0);
  });

  it("a flood is rated by its GDACS level and unrated without one", () => {
    const rated = buildEonetDetails(event({ category: "Floods", values: [null], gdacs: { level: "red", score: 3 } }), "flood");
    expect(rated).toMatchObject({ severity: "high", gdacsLevel: "red", severityReason: "High: GDACS impact level Red" });
    const un = buildEonetDetails(event({ category: "Floods", values: [null] }), "flood");
    expect(un).toMatchObject({ severity: "unrated", gdacsLevel: null, severitySource: "GDACS impact level unavailable; EONET reports no flood magnitude" });
  });

  it("a storm is rated on the peak of its advisory series and reports the current wind", () => {
    const ev = event({ category: "Severe Storms", unit: "kts", values: [35, 135, 115, 55], sources: [{ id: "JTWC", url: "https://x" }] });
    const r = assessEonetEvent(ev, "storm");
    expect(r).toMatchObject({ severity: "high", peakKts: 135, currentKts: 55, gdacsLevel: null });
    expect(r.reason).toBe("High: peak wind 135 kts (Saffir-Simpson category 4, ≥ 96 kts), now 55 kts");
    expect(buildEonetDetails(ev, "storm")).toMatchObject({ peakKts: 135, currentKts: 55, severity: "high", severitySource: "Severity rule applied to the peak advisory wind reported by EONET" });
  });

  it("the Kafka event carries the same severity as the feed details", () => {
    const ev = event({ gdacs: { level: "green", score: 1 } });
    const { events, dropped } = nasaEventsToContract([ev]);
    expect(dropped).toBe(0);
    expect(events[0].severity).toBe("low");
    expect(buildEonetDetails(ev, "wildfire").severity).toBe("low");
    const un = nasaEventsToContract([event({ category: "Floods", values: [null] })]);
    expect(un.events[0].severity).toBe("unrated"); // valid contract value
  });
});
