/**
 * GDACS impact-level client: link parsing, level mapping, caching, parallel
 * lookups, timeouts and the "never throw, fall back" behaviour. No network.
 */
import { describe, it, expect, vi } from "vitest";
import { createGdacsClient, parseGdacsRef, parseGdacsLevel, GDACS_LEVEL_SEVERITY, gdacsKey } from "../src/services/gdacs.js";
import { assessEonetEvent } from "../src/utils/severity.js";

const fire = (eventid = "1032806", extra = {}) => ({
  id: `EONET_${eventid}`,
  title: `Wildfire in Testland ${eventid}`,
  categories: [{ id: "wildfires", title: "Wildfires" }],
  sources: [{ id: "GDACS", url: `https://www.gdacs.org/report.aspx?eventtype=WF&eventid=${eventid}` }],
  geometry: [{ date: "2026-10-13T00:00:00Z", type: "Point", coordinates: [10, 20], magnitudeValue: 5604, magnitudeUnit: "hectare" }],
  ...extra,
});
const payload = (alertlevel, alertscore = 1, severitytext = "impact text") => ({
  ok: true,
  json: async () => ({ type: "Feature", properties: { eventtype: "WF", eventid: 1, alertlevel, alertscore, severitydata: { severitytext } } }),
});
const fetchReturning = (level) => vi.fn(async () => payload(level));

describe("parseGdacsRef / parseGdacsLevel", () => {
  it("reads eventtype and eventid from the EONET source link, in either parameter order", () => {
    expect(parseGdacsRef(fire("1032806"))).toEqual({ eventtype: "WF", eventid: "1032806" });
    expect(parseGdacsRef({ sources: [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventid=1104231&eventtype=FL" }] })).toEqual({ eventtype: "FL", eventid: "1104231" });
    expect(parseGdacsRef({ sources: [{ id: "IRWIN", url: "https://irwin.doi.gov/x" }] })).toBeNull();
    expect(parseGdacsRef({ sources: [] })).toBeNull();
    expect(parseGdacsRef(null)).toBeNull();
  });

  it("maps Green/Orange/Red to low/medium/high and rejects anything else", () => {
    expect(GDACS_LEVEL_SEVERITY).toEqual({ green: "low", orange: "medium", red: "high" });
    expect(parseGdacsLevel({ properties: { alertlevel: "Green", alertscore: 1, severitydata: { severitytext: "t" } } })).toEqual({ level: "green", score: 1, text: "t" });
    expect(parseGdacsLevel({ properties: { alertlevel: "ORANGE", alertscore: "2.5" } })).toEqual({ level: "orange", score: 2.5, text: null });
    expect(parseGdacsLevel({ properties: { alertlevel: "Red" } })).toMatchObject({ level: "red" });
    expect(parseGdacsLevel({ properties: { alertlevel: "Purple" } })).toBeNull();
    expect(parseGdacsLevel({})).toBeNull();
  });
});

describe("createGdacsClient", () => {
  it("attaches the level to GDACS-linked events only and leaves the others untouched", async () => {
    const fetchImpl = fetchReturning("Orange");
    const client = createGdacsClient({ fetchImpl, log: { warn() {} }, disabled: false });
    const events = [fire("1"), { id: "EONET_us", sources: [{ id: "IRWIN", url: "https://irwin.doi.gov/x" }], geometry: [] }];
    await client.enrich(events);
    expect(events[0].gdacs).toEqual({ level: "orange", score: 1, text: "impact text" });
    expect(events[1].gdacs).toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toBe("https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=WF&eventid=1");
  });

  it("caches per eventid for hours: a second enrich makes no request, after the TTL it does", async () => {
    let t = 1_000_000;
    const fetchImpl = fetchReturning("Green");
    const client = createGdacsClient({ fetchImpl, now: () => t, ttlMs: 6 * 3600 * 1000, log: { warn() {} }, disabled: false });
    await client.enrich([fire("7")]);
    await client.enrich([fire("7")]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(client.status()).toMatchObject({ requests: 1, hits: 1, cached: 1 });
    t += 6 * 3600 * 1000 + 1;
    await client.enrich([fire("7")]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fetches many events in parallel with bounded concurrency and deduplicates ids", async () => {
    let active = 0, maxActive = 0;
    const fetchImpl = vi.fn(async () => {
      active++; maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      return payload("Green");
    });
    const client = createGdacsClient({ fetchImpl, concurrency: 3, log: { warn() {} }, disabled: false });
    const events = [...Array(10)].map((_, i) => fire(String(i % 7))); // 7 distinct ids
    await client.enrich(events);
    expect(fetchImpl).toHaveBeenCalledTimes(7);
    expect(maxActive).toBeLessThanOrEqual(3);
    expect(events.every((e) => e.gdacs?.level === "green")).toBe(true);
  });

  it("never throws: an unreachable GDACS yields null, remembers the failure briefly, and the rule falls back to the area", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => { throw new Error("ECONNRESET"); });
    const warn = vi.fn();
    const client = createGdacsClient({ fetchImpl, now: () => t, failureTtlMs: 600_000, log: { warn }, disabled: false });
    const [ev] = await client.enrich([fire("9")]);
    expect(ev.gdacs).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    await client.enrich([fire("9")]); // inside the failure TTL: no new request
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    t = 600_001;
    await client.enrich([fire("9")]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.status()).toMatchObject({ failures: 2, lastError: "ECONNRESET" });
    // fallback: 5,604 ha without a level -> low by the size rule
    const rated = assessEonetEvent(ev, "wildfire");
    expect(rated).toMatchObject({ severity: "low", gdacsLevel: null, areaHa: 5604 });
    expect(rated.reason).toBe("Low: 5,604 ha burned (< 7,000 ha)");
  });

  it("aborts a slow GDACS after the timeout and keeps serving the previous level while it is down", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async (url, { signal }) => {
      if (fetchImpl.mock.calls.length === 1) return payload("Red");
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    });
    const client = createGdacsClient({ fetchImpl, now: () => t, timeoutMs: 20, ttlMs: 1000, log: { warn() {} }, disabled: false });
    const [first] = await client.enrich([fire("5")]);
    expect(first.gdacs.level).toBe("red");
    t = 2000; // expired -> refetch, which times out
    const started = Date.now();
    const [second] = await client.enrich([fire("5")]);
    expect(Date.now() - started).toBeLessThan(1000);
    expect(second.gdacs.level).toBe("red"); // stale level kept
    expect(client.status().lastError).toBe("timeout after 20 ms");
  });

  it("a non-OK answer or a payload without a level yields null (no level, not an error for the caller)", async () => {
    const client = createGdacsClient({ fetchImpl: vi.fn(async () => ({ ok: false, status: 500 })), log: { warn() {} }, disabled: false });
    expect(await client.getLevel({ eventtype: "FL", eventid: "1" })).toBeNull();
    const client2 = createGdacsClient({ fetchImpl: vi.fn(async () => ({ ok: true, json: async () => ({ properties: {} }) })), log: { warn() {} }, disabled: false });
    expect(await client2.getLevel({ eventtype: "FL", eventid: "1" })).toBeNull();
  });

  it("disabled client leaves events untouched and makes no request", async () => {
    const fetchImpl = fetchReturning("Red");
    const client = createGdacsClient({ fetchImpl, disabled: true });
    const [ev] = await client.enrich([fire("3")]);
    expect(ev.gdacs).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(gdacsKey({ eventtype: "WF", eventid: "3" })).toBe("WF:3");
  });
});
