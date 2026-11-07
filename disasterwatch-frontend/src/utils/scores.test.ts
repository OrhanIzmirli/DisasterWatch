import { describe, it, expect } from "vitest";
import { apiIdOf, confidenceBand, matchDescription, passesScores, priorityBand } from "./scores";

describe("scores helpers", () => {
  it("bands at the documented boundaries", () => {
    expect([39, 40, 69, 70].map(confidenceBand)).toEqual(["low", "medium", "medium", "high"]);
    expect([29, 30, 59, 60].map(priorityBand)).toEqual(["low", "medium", "medium", "high"]);
  });

  it("score filters: unscored events pass only 'any'", () => {
    const s = { confidence: 70, priority: 30, confirmations: 1 };
    expect(passesScores(s, 70, 30)).toBe(true);
    expect(passesScores(s, 71, 0)).toBe(false);
    expect(passesScores(s, 0, 31)).toBe(false);
    expect(passesScores(null, 0, 0)).toBe(true);
    expect(passesScores(undefined, 40, 0)).toBe(false);
  });

  it("feed ids map to API ids", () => {
    expect(apiIdOf("usgs:us7000abcd")).toBe("usgs:us7000abcd");
    expect(apiIdOf("nasa:EONET_12")).toBe("eonet:EONET_12");
    expect(apiIdOf("manual:3")).toBeNull();
    expect(apiIdOf(null)).toBeNull();
  });

  it("describes each kind of match in words", () => {
    const base = { sourceEventId: null, url: null, distanceKm: null, timeDeltaSec: null } as const;
    expect(matchDescription({ ...base, source: "emsc", role: "confirming", matchedBy: "rule", distanceKm: 5.4, timeDeltaSec: 2, agency: "GFZ" })).toBe(
      "Confirms it independently · 2 s and 5.4 km apart · solution by GFZ"
    );
    expect(matchDescription({ ...base, source: "emsc", role: "listed", matchedBy: "rule", distanceKm: 0, timeDeltaSec: 0, agency: "NEIC" })).toBe(
      "Lists it, not independently · 0 s and 0 km apart · solution by NEIC"
    );
    expect(matchDescription({ ...base, source: "nhc", role: "confirming", matchedBy: "name", distanceKm: 120, timeDeltaSec: 10800, classification: "Hurricane" })).toBe(
      "Confirms it independently · same storm name · 3 h and 120 km apart · Hurricane"
    );
    expect(matchDescription({ ...base, source: "firms", role: "confirming", matchedBy: "proximity", timeDeltaSec: -3600, detections: 7 })).toBe(
      "Confirms it independently · 7 satellite fire detections within 10 km"
    );
    expect(matchDescription({ ...base, source: "gdacs", role: "listed", matchedBy: "reference", level: "orange" })).toBe("Lists it, not independently · linked by the event itself · orange alert");
    expect(matchDescription({ ...base, source: "usgs", role: "primary", matchedBy: null })).toBe("Source of this event");
  });
});
