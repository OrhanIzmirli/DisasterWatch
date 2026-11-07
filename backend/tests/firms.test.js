/**
 * NASA FIRMS lookup (src/services/sources/firms.js): off without a key, URL and
 * box, CSV parsing, the 10 km / 48 h / confidence filter, background refresh
 * that never blocks peek(), TTL, backoff, and that the key never reaches a log
 * or status. Detections are invented; nothing is fetched.
 */
import { describe, it, expect, vi } from "vitest";
import { bboxAround, buildFirmsUrl, createFirmsLookup, distanceKm, firmsMapUrl, FIRMS_TTL_MS, parseFirmsCsv, summarizeDetections } from "../src/services/sources/firms.js";

const NOW = Date.parse("2026-11-07T12:00:00Z");
const KEY = "abcdef0123456789abcdef0123456789";
const HEADER = "latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,confidence,version,bright_ti5,frp,daynight";
const row = (lat, lng, { date = "2026-11-07", time = "0930", conf = "n", frp = 12.5 } = {}) => `${lat},${lng},330.1,0.4,0.4,${date},${time},N20,VIIRS,${conf},2.0NRT,290.2,${frp},D`;
const csv = (...rows) => [HEADER, ...rows].join("\n");
const textResponse = (text, status = 200) => ({ ok: status < 400, status, text: async () => text });
const FIRE = { id: "nasa:EONET_1", lat: -18.2, lng: 25.2 };

describe("helpers", () => {
  it("box around a point, clamped at the edges", () => {
    const [w, s, e, n] = bboxAround(-18.2, 25.2, 10);
    expect(n - s).toBeCloseTo(0.1797, 3);
    expect(e - w).toBeGreaterThan(n - s); // longitude degrees are shorter away from the equator
    expect(bboxAround(10, 179.99, 10)[2]).toBe(180);
    expect(bboxAround(89.99, 0, 10)[3]).toBe(90);
  });

  it("URL carries key, source, box and day range", () => {
    expect(buildFirmsUrl(KEY, [1, 2, 3, 4])).toBe(`https://firms.modaps.eosdis.nasa.gov/api/area/csv/${KEY}/VIIRS_NOAA20_NRT/1,2,3,4/2`);
    expect(firmsMapUrl(-18.2, 25.2)).toBe("https://firms.modaps.eosdis.nasa.gov/map/#d:48hrs;@25.2,-18.2,11z");
  });

  it("parses the CSV; anything else (an invalid key answer) throws", () => {
    expect(parseFirmsCsv(csv(row(-18.2, 25.2, { time: "45" })))).toEqual([{ lat: -18.2, lng: 25.2, time: Date.parse("2026-11-07T00:45:00Z"), confidence: "n", frp: 12.5 }]);
    expect(parseFirmsCsv(HEADER)).toEqual([]);
    expect(() => parseFirmsCsv("Invalid MAP_KEY.")).toThrow(/detection CSV/);
  });

  it("counts detections within 10 km and 48 h, without low-confidence pixels", () => {
    const rows = parseFirmsCsv(
      csv(
        row(-18.2, 25.2, { frp: 40 }),
        row(-18.25, 25.22), // ~6 km
        row(-18.4, 25.2), // ~22 km: outside
        row(-18.2, 25.2, { conf: "l" }), // low confidence
        row(-18.2, 25.2, { date: "2026-11-05", time: "0900" }) // 51 h old
      )
    );
    expect(distanceKm(-18.2, 25.2, -18.4, 25.2)).toBeCloseTo(22.2, 0);
    expect(summarizeDetections(rows, { lat: -18.2, lng: 25.2, now: NOW })).toEqual({ count: 2, latest: Date.parse("2026-11-07T09:30:00Z"), maxFrp: 40 });
    expect(summarizeDetections([], { lat: 0, lng: 0, now: NOW })).toEqual({ count: 0, latest: null, maxFrp: null });
  });
});

describe("createFirmsLookup", () => {
  it("is off without a key: nothing fetched, nothing known", async () => {
    const fetchImpl = vi.fn();
    const firms = createFirmsLookup({ mapKey: "", fetchImpl, now: () => NOW });
    await firms.refresh([FIRE]);
    expect(firms.peek([FIRE]).size).toBe(0);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(firms.status()).toEqual({ enabled: false, fetchedAt: null, items: null, failing: false });
  });

  it("peek answers from the cache only; refresh fills it in the background and respects the TTL", async () => {
    let t = NOW;
    const fetchImpl = vi.fn(async () => textResponse(csv(row(-18.2, 25.2), row(-18.21, 25.2))));
    const firms = createFirmsLookup({ mapKey: KEY, fetchImpl, now: () => t });
    expect(firms.peek([FIRE]).size).toBe(0);
    const pending = firms.refresh([FIRE]);
    firms.refresh([FIRE]); // same event while in flight: no second request
    await pending;
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(firms.peek([FIRE]).get("nasa:EONET_1")).toMatchObject({ count: 2, url: firmsMapUrl(-18.2, 25.2), fetchedAt: NOW });
    t += FIRMS_TTL_MS - 1;
    await firms.refresh([FIRE]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t += 2;
    await firms.refresh([FIRE]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("an event that moves is looked up again", async () => {
    const fetchImpl = vi.fn(async () => textResponse(csv()));
    const firms = createFirmsLookup({ mapKey: KEY, fetchImpl, now: () => NOW });
    await firms.refresh([FIRE]);
    await firms.refresh([{ ...FIRE, lat: -18.5 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("several fires are fetched a few at a time", async () => {
    let active = 0;
    let peak = 0;
    const fetchImpl = vi.fn(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return textResponse(csv());
    });
    const firms = createFirmsLookup({ mapKey: KEY, fetchImpl, now: () => NOW, concurrency: 3 });
    await firms.refresh(Array.from({ length: 8 }, (_, i) => ({ id: `f${i}`, lat: i, lng: i })));
    expect(fetchImpl).toHaveBeenCalledTimes(8);
    expect(peak).toBe(3);
    expect(firms.status()).toMatchObject({ enabled: true, items: 8, failing: false });
  });

  it("a failure stops the round, backs off, and never logs the key", async () => {
    const warn = vi.fn();
    const fetchImpl = vi.fn(async (url) => {
      throw new Error(`request to ${url} failed`);
    });
    const firms = createFirmsLookup({ mapKey: KEY, fetchImpl, now: () => NOW, log: { warn }, concurrency: 1 });
    await firms.refresh([FIRE, { id: "b", lat: 1, lng: 1 }]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).not.toContain(KEY);
    expect(warn.mock.calls[0][0]).toContain("<key>");
    expect(firms.status().failing).toBe(true);
    await firms.refresh([FIRE]); // gate closed: nothing sent
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(firms.status())).not.toContain(KEY);
  });

  it("an invalid-key answer (200 with text) counts as a failure", async () => {
    const firms = createFirmsLookup({ mapKey: KEY, fetchImpl: async () => textResponse("Invalid MAP_KEY."), now: () => NOW, log: { warn: () => {} } });
    await firms.refresh([FIRE]);
    expect(firms.peek([FIRE]).size).toBe(0);
    expect(firms.status().failing).toBe(true);
  });
});
