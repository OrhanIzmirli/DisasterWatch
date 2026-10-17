import { describe, it, expect, vi } from "vitest";
import { normalizeNasaEvents, resolveEventLocation, pickBestLatLngFromGeometryArray, LOCATION_DISAGREEMENT_KM } from "../src/utils/normalizeDisasters.js";
import { createGdacsClient } from "../src/services/gdacs.js";

// Synthetic EONET flood: a square polygon around (36.76 N, 33.64 E) whose source is GDACS flood 900001.
const square = (lat, lng, d = 0.5) => [[[lng - d, lat - d], [lng + d, lat - d], [lng + d, lat + d], [lng - d, lat + d], [lng - d, lat - d]]];
const flood = (over = {}) => ({
  id: "EONET_900001",
  title: "Flood in Example 900001",
  link: "https://eonet.example.com/api/v3/events/EONET_900001",
  categories: [{ id: "floods", title: "Floods" }],
  sources: [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=FL&eventid=900001" }],
  geometry: [{ date: new Date(Date.now() - 3600_000).toISOString(), type: "Polygon", coordinates: square(36.76, 33.64) }],
  ...over,
});

describe("resolveEventLocation", () => {
  it("prefers the GDACS event point over the EONET polygon centroid", () => {
    const loc = resolveEventLocation([33.64, 36.76], { countries: ["TR"], lat: 36.8, lng: 33.7 });
    expect(loc).toMatchObject({ coords: [33.7, 36.8], source: "gdacs", precision: "exact", reason: null });
    expect(loc.offsetKm).toBeLessThan(10);
  });

  it(`flags the location approximate when the sources are more than ${LOCATION_DISAGREEMENT_KM} km apart`, () => {
    // GDACS point in Istanbul, EONET polygon centroid in south-central Türkiye (~630 km)
    const loc = resolveEventLocation([33.64, 36.76], { countries: ["TR"], lat: 41.1157, lng: 28.9986 });
    expect(loc).toMatchObject({ coords: [28.9986, 41.1157], source: "gdacs", precision: "approximate", reason: "sources disagree on exact area" });
    expect(loc.offsetKm).toBeGreaterThan(600);
  });

  it("is exact right at the threshold and approximate just past it", () => {
    const kmPerDegLat = 111.19;
    const at = resolveEventLocation([0, 0], { lat: (LOCATION_DISAGREEMENT_KM - 1) / kmPerDegLat, lng: 0 });
    const past = resolveEventLocation([0, 0], { lat: (LOCATION_DISAGREEMENT_KM + 2) / kmPerDegLat, lng: 0 });
    expect(at.precision).toBe("exact");
    expect(past.precision).toBe("approximate");
  });

  it("falls back to the EONET centroid without a GDACS point", () => {
    expect(resolveEventLocation([33.64, 36.76], null)).toEqual({ coords: [33.64, 36.76], precision: "exact", source: "eonet", reason: null, offsetKm: null });
    expect(resolveEventLocation([33.64, 36.76], { countries: ["TR"], lat: null, lng: null })).toMatchObject({ source: "eonet", precision: "exact" });
  });

  it("uses the GDACS point when EONET has no usable geometry, and nothing without either", () => {
    expect(resolveEventLocation(null, { lat: 41.1, lng: 29 })).toMatchObject({ coords: [29, 41.1], source: "gdacs", precision: "exact", offsetKm: null });
    expect(resolveEventLocation(null, null)).toBeNull();
  });
});

describe("feed items (normalizeNasaEvents)", () => {
  it("puts the marker on the GDACS point and says why when the sources disagree", () => {
    const [item] = normalizeNasaEvents([flood({ gdacsPlace: { countries: ["TR"], lat: 41.1157, lng: 28.9986 } })]);
    expect([item.lat, item.lng]).toEqual([41.1157, 28.9986]);
    expect(item.details).toMatchObject({ locationPrecision: "approximate", locationSource: "gdacs", locationReason: "sources disagree on exact area" });
    expect(item.details.locationOffsetKm).toBeGreaterThan(600);
  });

  it("keeps the marker where it was (centroid) and exact without a GDACS point", () => {
    const [item] = normalizeNasaEvents([flood()]);
    const [lng, lat] = pickBestLatLngFromGeometryArray(flood().geometry).coords; // the unchanged EONET centroid
    expect([item.lat, item.lng]).toEqual([lat, lng]);
    expect(item.details).toMatchObject({ locationPrecision: "exact", locationSource: "eonet" });
    expect(item.details).not.toHaveProperty("locationReason");
  });

  it("is exact with the GDACS point when both sources agree", () => {
    const [item] = normalizeNasaEvents([flood({ gdacsPlace: { countries: ["TR"], lat: 36.9, lng: 33.5 } })]);
    expect([item.lat, item.lng]).toEqual([36.9, 33.5]);
    expect(item.details).toMatchObject({ locationPrecision: "exact", locationSource: "gdacs" });
  });
});

describe("GDACS client enrich()", () => {
  it("attaches where GDACS places the event (its point) from the same lookup as the level", async () => {
    const payload = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [28.9986, 41.1157] },
      properties: { alertlevel: "Green", alertscore: 1, affectedcountries: [{ iso2: "TR" }] },
    };
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) }));
    const client = createGdacsClient({ fetchImpl, log: { warn() {} }, disabled: false });
    const events = [flood(), { id: "EONET_other", sources: [{ id: "IRWIN", url: "https://irwin.example.com/x" }], geometry: [] }];
    await client.enrich(events);
    expect(events[0].gdacsPlace).toEqual({ countries: ["TR"], lat: 41.1157, lng: 28.9986 });
    expect(events[1]).not.toHaveProperty("gdacsPlace");
    expect(fetchImpl).toHaveBeenCalledTimes(1); // no extra request for the place
  });
});
