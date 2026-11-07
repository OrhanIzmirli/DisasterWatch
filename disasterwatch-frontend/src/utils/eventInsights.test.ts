import { describe, it, expect } from "vitest";
import type { DrawerEvent } from "../components/EventDetailDrawer";
import type { SeverityRules } from "../services/feedCache";
import { depthClass, distanceKm, lifecycle, nearbyEvents, quakeClass, severityScale, stormCategory, summarySentence } from "./eventInsights";

const NOW = new Date("2026-11-06T12:00:00Z");
// the shape GET /disasters serves as `severityRules` (backend/src/utils/severity.js)
const RULES: SeverityRules = {
  earthquake: { basis: "magnitude", unit: "M", medium: 5.0, high: 6.0, step: 0.1 },
  wildfire: { basis: "burnedArea", unit: "ha", medium: 7000, high: 10000, step: 1 },
  storm: { basis: "peakWind", unit: "kts", medium: 64, high: 96, step: 1 },
  gdacs: { levels: { green: "low", orange: "medium", red: "high" }, appliesTo: ["wildfire", "flood"] },
};
const base = (over: Partial<DrawerEvent>, details: Record<string, unknown> = {}): DrawerEvent =>
  ({
    id: 1,
    type: "earthquake",
    severity: "low",
    location: "",
    meta: "",
    description: "",
    lat: 0,
    lng: 0,
    ...over,
    details: { sources: [], severityReason: "", severitySource: "", ...details },
  }) as unknown as DrawerEvent;

describe("quakeClass and depthClass (USGS classes)", () => {
  it("puts magnitudes in the USGS classes at their boundaries", () => {
    expect(quakeClass(3.9).label).toBe("Minor");
    expect(quakeClass(4.0).label).toBe("Light");
    expect(quakeClass(5.0).label).toBe("Moderate");
    expect(quakeClass(6.0).label).toBe("Strong");
    expect(quakeClass(7.0).label).toBe("Major");
    expect(quakeClass(8.0).label).toBe("Great");
  });

  it("classifies focal depth as shallow, intermediate or deep", () => {
    expect(depthClass(10).label).toBe("Shallow");
    expect(depthClass(70).label).toBe("Intermediate depth");
    expect(depthClass(300).label).toBe("Deep");
  });
});

describe("stormCategory (Saffir-Simpson)", () => {
  it("names the category from the sustained wind in knots", () => {
    expect(stormCategory(30)).toBe("Tropical depression");
    expect(stormCategory(34)).toBe("Tropical storm");
    expect(stormCategory(64)).toBe("Category 1 hurricane");
    expect(stormCategory(96)).toBe("Category 3 hurricane");
    expect(stormCategory(137)).toBe("Category 5 hurricane");
  });
});

describe("severityScale", () => {
  it("shows the magnitude thresholds of the backend rule for a quake and marks its level", () => {
    const s = severityScale(base({ type: "earthquake", severity: "medium" }), RULES);
    expect(s.current).toBe("medium");
    expect(s.steps.map((x) => x.range)).toEqual(["below M 5.0", "M 5.0–5.9", "M 6.0 and above"]);
  });

  it("uses the GDACS levels when GDACS rated the event", () => {
    const s = severityScale(base({ type: "wildfire", severity: "low" }, { gdacsLevel: "green" }), RULES);
    expect(s.basis).toMatch(/GDACS/);
    expect(s.steps[0].range).toBe("GDACS Green");
  });

  it("uses burned area for a fire GDACS does not cover, and peak wind for storms", () => {
    expect(severityScale(base({ type: "wildfire" }), RULES).steps[2].range).toBe("10,000 ha and above");
    expect(severityScale(base({ type: "storm" }), RULES).steps[1].range).toBe("64–95 kts (Cat 1–2)");
  });

  it("draws the ranges from the served rules, so a changed threshold shows up without a frontend change", () => {
    const moved = { ...RULES, earthquake: { ...RULES.earthquake, medium: 5.5 } };
    expect(severityScale(base({ type: "earthquake" }), moved).steps.map((x) => x.range)).toEqual(["below M 5.5", "M 5.5–5.9", "M 6.0 and above"]);
  });

  it("shows the levels without ranges when the feed carried no rules", () => {
    const s = severityScale(base({ type: "storm", severity: "high" }), null);
    expect(s.current).toBe("high");
    expect(s.steps.map((x) => x.range)).toEqual(["", "", ""]);
  });

  it("marks nothing for a not-rated event", () => {
    expect(severityScale(base({ type: "flood", severity: "unrated" }), RULES).current).toBeNull();
  });
});

describe("summarySentence", () => {
  it("describes a quake with its magnitude, depth, place and age", () => {
    const e = base({ type: "earthquake" }, { magnitudeLabel: "4.7", depthKm: 40.2, place: "100 km SSE of Palekastro, Greece", occurredAt: "2026-11-02T12:00:00Z" });
    expect(summarySentence(e, NOW)).toBe("A magnitude 4.7 earthquake at 40 km depth, 100 km SSE of Palekastro, Greece, 4 days ago.");
  });

  it("gives a fire's area in hectares and km²", () => {
    const e = base({ type: "wildfire", location: "Wildfire in Australia" }, { areaHa: 20731, place: "Australia", occurredAt: "2026-11-04T12:00:00Z" });
    expect(summarySentence(e, NOW)).toBe("A wildfire of about 20,700 hectares (207.3 km²) in Australia, first reported 2 days ago.");
  });

  it("never leaves empty parts when the place or time is missing", () => {
    const e = base({ type: "earthquake" }, { magnitudeLabel: "5.0" });
    expect(summarySentence(e, NOW)).toBe("A magnitude 5.0 earthquake.");
  });

  it("says when a storm has weakened since its peak", () => {
    const e = base({ type: "storm", location: "Hurricane Simon" }, { peakKts: 135, currentKts: 55, occurredAt: "2026-11-06T05:00:00Z" });
    expect(summarySentence(e, NOW)).toBe("A storm that peaked at 135 kts (category 4 hurricane) and has weakened to 55 kts, 7 hours ago.");
  });

  it("never uses the event title as a place", () => {
    const e = base({ type: "flood", location: "Flood in Libya 1104231" });
    expect(summarySentence(e, NOW)).toBe("A flood reported.");
  });
});

describe("lifecycle", () => {
  it("says how long a closed event was tracked", () => {
    const e = base({ type: "wildfire" }, { status: "Closed", occurredAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-04T00:00:00Z" });
    expect(lifecycle(e)).toBe("Closed: the source stopped tracking it after 3 days.");
  });

  it("says an open event is still tracked, and nothing for quakes", () => {
    expect(lifecycle(base({ type: "flood" }, { status: "Open" }))).toBe("Open: the source is still tracking it.");
    expect(lifecycle(base({ type: "earthquake" }, { status: "Reviewed" }))).toBeNull();
  });
});

describe("nearbyEvents", () => {
  const here = { id: 1, lat: 35, lng: 25 };
  const others = [
    { id: 1, lat: 35, lng: 25 },
    { id: 2, lat: 35, lng: 27 }, // ~182 km
    { id: 3, lat: 36, lng: 25 }, // ~111 km
    { id: 4, lat: 50, lng: 25 }, // far
  ];

  it("lists other events within the radius, nearest first, without the event itself", () => {
    expect(nearbyEvents(here, others, 500).map((n) => n.event.id)).toEqual([3, 2]);
  });

  it("measures great-circle distance", () => {
    expect(Math.round(distanceKm({ lat: 0, lng: 0 }, { lat: 0, lng: 1 }))).toBe(111);
  });
});
