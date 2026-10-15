/**
 * Severity from the source measurement: every threshold edge, the unit
 * normalisation and the "unrated" cases. Pure unit tests (no database).
 */
import { describe, it, expect } from "vitest";
import {
  assessSeverity,
  assessEonetEvent,
  toHectares,
  toKnots,
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

const storm = (kts, unit = "kts") => assessSeverity({ type: "storm", magnitudeValue: kts, magnitudeUnit: unit });
const fire = (value, unit) => assessSeverity({ type: "wildfire", magnitudeValue: value, magnitudeUnit: unit });

describe("thresholds", () => {
  it("are the documented ones", () => {
    expect([STORM_MEDIUM_KTS, STORM_HIGH_KTS]).toEqual([64, 96]);
    expect([WILDFIRE_MEDIUM_HA, WILDFIRE_HIGH_HA]).toEqual([4_000, 40_000]);
    expect(ACRES_TO_HA).toBeCloseTo(0.40469, 5);
  });
});

describe("storm (EONET wind speed in kts)", () => {
  it.each([
    [63, "low"],
    [64, "medium"],
    [95, "medium"],
    [96, "high"],
    [0, "low"],
    [150, "high"],
  ])("%s kts -> %s", (kts, severity) => {
    expect(storm(kts).severity).toBe(severity);
  });

  it("explains the rating from the same thresholds", () => {
    expect(storm(96).reason).toBe("High: 96 kts sustained wind (≥ 96 kts, Saffir-Simpson category 3 or stronger)");
    expect(storm(80).reason).toBe("Medium: 80 kts sustained wind (64–95 kts, hurricane strength)");
    expect(storm(40).reason).toBe("Low: 40 kts sustained wind (< 64 kts, tropical storm)");
  });

  it("is unrated without a value or with a unit that is not knots", () => {
    expect(storm(null)).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(storm(80, "mph")).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(storm(80, null)).toEqual({ severity: "unrated", reason: UNRATED_REASON });
  });
});

describe("wildfire (burned area normalised to hectares)", () => {
  it.each([
    [3_999, "low"],
    [4_000, "medium"],
    [39_999, "medium"],
    [40_000, "high"],
    [1, "low"],
    [250_000, "high"],
  ])("%s hectare -> %s", (ha, severity) => {
    expect(fire(ha, "hectare").severity).toBe(severity);
  });

  it("converts acres to hectares in one place (acres × 0.40469)", () => {
    expect(toHectares(98_842, "acres")).toBeCloseTo(40_000.4, 0);
    expect(toHectares(100_000, "acres")).toBeCloseTo(40_469, 0);
    expect(toHectares(10_000, "acres")).toBeCloseTo(4_046.9, 1);
    expect(toHectares(500, "hectare")).toBe(500);
    expect(toHectares(500, "ha")).toBe(500);
    expect(toHectares(500, "km2")).toBeNull();
    expect(toHectares(null, "hectare")).toBeNull();
    expect(toHectares(-1, "hectare")).toBeNull();
  });

  it("98,842 acres is rated high; 9,880 acres (3,998 ha) is low; 9,885 acres (4,000 ha) is medium", () => {
    expect(fire(98_842, "acres").severity).toBe("high");
    expect(fire(9_880, "acres").severity).toBe("low");
    expect(fire(9_885, "acres").severity).toBe("medium");
  });

  it("explains the rating in hectares from the same thresholds", () => {
    expect(fire(9_965, "hectare").reason).toBe("Medium: 9,965 ha burned (4,000–39,999 ha)");
    expect(fire(98_842, "acres").reason).toBe("High: 40,000 ha burned (≥ 40,000 ha)");
    expect(fire(120, "hectare").reason).toBe("Low: 120 ha burned (< 4,000 ha)");
  });

  it("accepts a pre-normalised areaHa", () => {
    expect(assessSeverity({ type: "wildfire", areaHa: 40_000 }).severity).toBe("high");
    expect(assessSeverity({ type: "wildfire", areaHa: 3_999 }).severity).toBe("low");
  });

  it("is unrated without a value or with an unknown unit", () => {
    expect(fire(null, null)).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(fire(5_000, "km2")).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(fire(undefined, "hectare")).toEqual({ severity: "unrated", reason: UNRATED_REASON });
  });
});

describe("floods, unknown types and earthquakes", () => {
  it("floods are always unrated (EONET reports no intensity)", () => {
    expect(assessSeverity({ type: "flood" })).toEqual({ severity: "unrated", reason: UNRATED_REASON });
    expect(assessSeverity({ type: "flood", magnitudeValue: 12, magnitudeUnit: "NM^2" })).toEqual({ severity: "unrated", reason: UNRATED_REASON });
  });

  it("types without a rule are unrated", () => {
    expect(assessSeverity({ type: "volcano" }).severity).toBe("unrated");
  });

  it("earthquake rules are unchanged (rounded magnitude 6.0 high, 5.0–5.9 medium, < 5.0 low)", () => {
    expect(severityFromMag(5.95)).toBe("high");
    expect(severityFromMag(5.0)).toBe("medium");
    expect(severityFromMag(4.94)).toBe("low");
    expect(assessSeverity({ type: "earthquake", magnitude: null }).severity).toBe("low");
  });

  it("toKnots accepts kts/kt/knots only", () => {
    expect(toKnots(70, "kts")).toBe(70);
    expect(toKnots(70, "knots")).toBe(70);
    expect(toKnots(70, "mph")).toBeNull();
  });
});

describe("EONET event -> rating, details and Kafka contract agree", () => {
  const event = (unit, value, category = "Wildfires") => ({
    id: "EONET_1",
    title: "Wildfire in Testland 1",
    categories: [{ id: "wildfires", title: category }],
    sources: [],
    geometry: [
      { date: "2026-10-10T00:00:00Z", type: "Point", coordinates: [10, 20], magnitudeValue: 1, magnitudeUnit: unit },
      { date: "2026-10-11T00:00:00Z", type: "Point", coordinates: [10, 20], magnitudeValue: value, magnitudeUnit: unit },
    ],
  });

  it("uses the latest geometry with a magnitude and keeps the original value and unit", () => {
    const r = assessEonetEvent(event("acres", 98_842), "wildfire");
    expect(r).toMatchObject({ severity: "high", magnitudeValue: 98_842, magnitudeUnit: "acres" });
    expect(r.areaHa).toBeCloseTo(40_000.4, 0);
    const d = buildEonetDetails(event("acres", 98_842), "wildfire");
    expect(d).toMatchObject({ severity: "high", magnitudeValue: 98_842, magnitudeUnit: "acres", severitySource: "Severity rule applied to the burned area reported by EONET" });
    expect(d.areaHa).toBeCloseTo(40_000.4, 0);
  });

  it("the Kafka event carries the same severity as the feed details", () => {
    const { events } = nasaEventsToContract([event("hectare", 3_999)]);
    expect(events[0].severity).toBe("low");
    expect(buildEonetDetails(event("hectare", 3_999), "wildfire").severity).toBe("low");
    const un = nasaEventsToContract([event(null, null, "Floods")]);
    expect(un.events[0].severity).toBe("unrated");
    expect(un.dropped).toBe(0); // "unrated" is a valid contract value
  });
});
