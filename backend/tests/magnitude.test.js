import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { formatMagnitude, roundMagnitude } from "../src/utils/magnitude.js";
import { assessSeverity } from "../src/utils/severity.js";
import { buildUsgsDetails } from "../src/utils/eventDetails.js";
import { normalizeUsgsEarthquakes } from "../src/services/usgs.service.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const USGS = JSON.parse(fs.readFileSync(path.join(here, "fixtures", "usgs-feature.json"), "utf8"));

/** The Kokopo fixture with another magnitude and the title USGS would publish for it. */
function featureWithMag(mag, title) {
  return {
    ...USGS,
    properties: { ...USGS.properties, mag, title: title ?? USGS.properties.title, time: Date.now() - 60_000 },
  };
}

describe("formatMagnitude: one rounding rule, half-up on the decimal value (like USGS titles)", () => {
  it.each([
    [6.05, "6.1"], // toFixed(1) said "6.0" (6.05 is stored as 6.04999…)
    [4.45, "4.5"],
    [5.95, "6.0"],
    [1.95, "2.0"], // live USGS feed: title "M 2.0", toFixed "1.9"
    [1.15, "1.2"],
    [6.0, "6.0"],
    [6, "6.0"],
    [5.949, "5.9"],
    [6.04, "6.0"],
    [7.25, "7.3"],
    [4.5, "4.5"],
    ["6.05", "6.1"], // numeric strings from older payloads
    [-0.85, "-0.9"],
  ])("%j -> %j", (input, expected) => {
    expect(formatMagnitude(input)).toBe(expected);
  });

  it.each([[null], [undefined], [""], ["abc"], [NaN], [Infinity]])("%j -> null (not reported)", (input) => {
    expect(formatMagnitude(input)).toBeNull();
    expect(roundMagnitude(input)).toBeNull();
  });

  it("roundMagnitude returns the number behind the label", () => {
    expect(roundMagnitude(6.05)).toBe(6.1);
    expect(roundMagnitude(5.95)).toBe(6);
  });
});

describe("every surface shows the same magnitude", () => {
  it.each([
    // raw, label, severity decided on the RAW value
    [6.05, "6.1", "high"],
    [5.95, "6.0", "medium"], // displays as 6.0 but 5.95 < 6.0, so it stays medium
    [4.45, "4.5", "low"], // displays as 4.5 but 4.45 < 5.0, so it stays low
    [4.95, "5.0", "low"],
    [5.0, "5.0", "medium"],
    [6.0, "6.0", "high"],
  ])("raw %s -> label %s, severity %s", (raw, label, severity) => {
    const title = `M ${label} - ${USGS.properties.place}`;
    const details = buildUsgsDetails(featureWithMag(raw, title));
    const [item] = normalizeUsgsEarthquakes([featureWithMag(raw, title)], { minMag: 0 });

    expect(details.magnitude).toBe(raw); // raw value is still exposed
    expect(details.magnitudeLabel).toBe(label);
    expect(details.cleanTitle).toBe(title); // title
    expect(details.severityReason).toContain(`magnitude ${label} `); // "Why it's on the map"
    expect(item.meta).toMatch(new RegExp(`^Mag ${label.replace(".", "\\.")} • \\d+ min ago$`)); // feed meta
    expect(item.description).toBe(`Earthquake detected • Magnitude ${label}`);

    expect(details.severity).toBe(severity);
    expect(item.severity).toBe(severity);
    expect(assessSeverity({ type: "earthquake", magnitude: raw }).severity).toBe(severity);
  });

  it("does not trust the USGS title string: a title rounded differently is replaced", () => {
    // USGS publishes "M 6.1" for 6.05; an older feed that still said "M 6.0" is normalised too
    const details = buildUsgsDetails(featureWithMag(6.05, "M 6.0 - 126 km S of Kokopo, Papua New Guinea"));
    expect(details.cleanTitle).toBe("M 6.1 - 126 km S of Kokopo, Papua New Guinea");
    expect(details.magnitudeLabel).toBe("6.1");
  });

  it("falls back to the place when the magnitude is not reported", () => {
    const details = buildUsgsDetails(featureWithMag(null, "M ? - 126 km S of Kokopo, Papua New Guinea"));
    expect(details.magnitudeLabel).toBeNull();
    expect(details.cleanTitle).toBe("M ? - 126 km S of Kokopo, Papua New Guinea");
    expect(details.severityReason).toBe("Low: magnitude not reported by source");
  });
});
