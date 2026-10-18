import fs from "node:fs";
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTestApp, resetDb, prisma } from "./helpers.js";
import { createIngestRunner, ingestOnce, WAKE_MIN_INTERVAL_MS } from "../src/jobs/ingest.js";
import { createGdacsClient } from "../src/services/gdacs.js";
import { secretsEqual, MIN_SECRET_LENGTH } from "../src/routes/internal.routes.js";
import { nasaEventsToContract } from "../src/events/mappers.js";
import { disasterEventSchema } from "../src/events/contract.js";
import { createStormContext } from "../src/services/stormContext.js";
// the notification service's own matching rules, so the test checks what a subscriber would receive
import { matchesSubscription } from "../../notification-service/src/match.js";

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
// a test-only value, generated for this file; real secrets live in Render / GitHub settings only
const SECRET = "t".repeat(MIN_SECRET_LENGTH) + "-test-only";
const STATS = { fetched: 3, dropped: 0, inserted: 2, published: 2, pending: 0, errors: [] };

function fakeRunner(t0 = 1_000_000) {
  let t = t0;
  const ingest = vi.fn(async () => STATS);
  const runner = createIngestRunner({ ingest, now: () => t, log: quiet });
  return { runner, ingest, advance: (ms) => (t += ms) };
}

const appWith = (internal) => createTestApp({ internal: { log: quiet, ready: () => Promise.resolve(), ...internal } });

describe("ingest runner shared by the timer and the wake endpoint", () => {
  it("a wake right after a run does nothing (idempotent), a later one runs", async () => {
    const { runner, ingest, advance } = fakeRunner();
    await runner.run("timer");
    expect(await runner.wake()).toMatchObject({ ran: false, reason: "recent" });
    expect(ingest).toHaveBeenCalledTimes(1);
    advance(WAKE_MIN_INTERVAL_MS);
    expect(await runner.wake()).toMatchObject({ ran: true, reason: "ran" });
    expect(ingest).toHaveBeenCalledTimes(2);
    expect(runner.status()).toMatchObject({ running: false, lastTrigger: "wake", lastWakeOutcome: "ran", lastStats: { inserted: 2, published: 2 } });
  });

  it("a wake during a run joins it instead of starting a second one (cold start: the start-up run is in progress)", async () => {
    let release;
    const ingest = vi.fn(() => new Promise((r) => (release = () => r(STATS))));
    const runner = createIngestRunner({ ingest, now: () => 5, log: quiet });
    const timer = runner.run("timer");
    const wake = runner.wake();
    release();
    await timer;
    expect(await wake).toMatchObject({ ran: false, reason: "in-progress" });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(runner.status().lastWakeOutcome).toBe("joined-running");
  });

  it("a failing run is reported, not thrown", async () => {
    const runner = createIngestRunner({ ingest: async () => { throw new Error("db down"); }, now: () => 1, log: quiet });
    const out = await runner.wake();
    expect(out.last.error).toBe("db down");
    expect(runner.status()).toMatchObject({ lastErrorSources: ["run"], lastWakeOutcome: "failed" });
  });

  it("a recent run that failed (or had a failed part) does not block the wake: it is retried", async () => {
    let t = 0;
    const ingest = vi.fn().mockResolvedValueOnce({ ...STATS, errors: ["publish: The group coordinator is not available"] }).mockResolvedValue(STATS);
    const runner = createIngestRunner({ ingest, now: () => t, log: quiet });
    await runner.run("timer");
    expect(runner.status().lastErrorSources).toEqual(["publish"]); // the source only, never the upstream message
    t += 60_000;
    expect(await runner.wake()).toMatchObject({ ran: true, reason: "ran" });
    expect(ingest).toHaveBeenCalledTimes(2);
  });
});

describe("POST /internal/ingest", () => {
  it("compares secrets in constant time whatever their length", () => {
    expect(secretsEqual(SECRET, SECRET)).toBe(true);
    expect(secretsEqual(SECRET, SECRET + "x")).toBe(false);
    expect(secretsEqual("", SECRET)).toBe(false);
  });

  it("does not exist without a secret, or with one shorter than 32 characters", async () => {
    const { runner, ingest } = fakeRunner();
    for (const secret of [undefined, "", "short-secret"]) {
      const res = await request(appWith({ secret, runner })).post("/internal/ingest").set("Authorization", `Bearer ${secret ?? ""}`);
      expect(res.status).toBe(404);
    }
    expect(ingest).not.toHaveBeenCalled();
  });

  it("answers 401 to a missing or wrong secret and runs nothing", async () => {
    const { runner, ingest } = fakeRunner();
    const app = appWith({ secret: SECRET, runner });
    expect((await request(app).post("/internal/ingest")).status).toBe(401);
    expect((await request(app).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}x`)).status).toBe(401);
    expect((await request(app).post("/internal/ingest").set("Authorization", SECRET)).status).toBe(401);
    expect(ingest).not.toHaveBeenCalled();
  });

  it("reads the secret from the Authorization header only: one in the URL / query string is refused", async () => {
    const { runner, ingest } = fakeRunner();
    const app = appWith({ secret: SECRET, runner });
    for (const q of [`?secret=${SECRET}`, `?token=${SECRET}`, `?authorization=Bearer%20${SECRET}`]) {
      expect((await request(app).post(`/internal/ingest${q}`)).status).toBe(401);
    }
    expect(ingest).not.toHaveBeenCalled();
  });

  it("the workflow sends the secret in a header and never prints it", () => {
    const yml = fs.readFileSync(new URL("../../.github/workflows/wake.yml", import.meta.url), "utf8");
    // every line that reads the value ($INGEST_WAKE_SECRET or secrets.INGEST_WAKE_SECRET; the error text only names it)
    const uses = yml.split(/\r?\n/).filter((l) => /\$INGEST_WAKE_SECRET|secrets\.INGEST_WAKE_SECRET/.test(l) && !l.trim().startsWith("#"));
    // only: the env mapping from secrets, the "is it set" check, and the Authorization header
    expect(uses).toHaveLength(3);
    expect(uses[0].trim()).toBe("INGEST_WAKE_SECRET: ${{ secrets.INGEST_WAKE_SECRET }}");
    expect(uses[1]).toContain('[ -z "$INGEST_WAKE_SECRET" ]');
    expect(uses[2]).toContain('-H "Authorization: Bearer $INGEST_WAKE_SECRET"');
    expect(yml).toContain('"$BACKEND_URL/internal/ingest"'); // no query string
    expect(yml).not.toMatch(/set -x|--verbose|--trace|curl[^\n]* -v |echo[^\n]*\$\{?INGEST_WAKE_SECRET/);
  });

  it("runs an ingestion with the right secret, then is idempotent; the body carries counts only", async () => {
    const { runner, ingest } = fakeRunner();
    const app = appWith({ secret: SECRET, runner });
    const first = await request(app).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}`);
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ ok: true, ran: true, reason: "ran", stats: { fetched: 3, inserted: 2, published: 2, pending: 0, errors: 0 } });
    const second = await request(app).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}`);
    expect(second.body).toMatchObject({ ran: false, reason: "recent" });
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(first.body) + JSON.stringify(second.body)).not.toContain(SECRET);
  });

  it("ok is false when a part of the run failed (the workflow fails on it)", async () => {
    const runner = createIngestRunner({ ingest: async () => ({ ...STATS, errors: ["publish: broker unreachable"] }), now: () => 1, log: quiet });
    const res = await request(appWith({ secret: SECRET, runner })).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: false, stats: { errors: 1 } });
    expect(JSON.stringify(res.body)).not.toContain("broker unreachable");
  });

  it("waits for the first Kafka connection attempt, but not longer than the timeout", async () => {
    const { runner, ingest } = fakeRunner();
    const app = appWith({ secret: SECRET, runner, ready: () => new Promise(() => {}), readyTimeoutMs: 50 });
    const res = await request(app).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}`);
    expect(res.status).toBe(200);
    expect(ingest).toHaveBeenCalledTimes(1);
  });

  it("is rate limited per client", async () => {
    const { runner } = fakeRunner();
    const app = appWith({ secret: SECRET, runner, limit: { windowMs: 60_000, limit: 2 } });
    const codes = [];
    for (let i = 0; i < 3; i++) codes.push((await request(app).post("/internal/ingest").set("Authorization", "Bearer wrong")).status);
    expect(codes).toEqual([401, 401, 429]);
  });
});

describe("/health shows the ingestion runner and the storm lists", () => {
  it("has the ingest status and news.storms", async () => {
    const res = await request(createTestApp({ internal: { log: quiet } })).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.ingest).toMatchObject({ running: expect.any(Boolean) });
    expect(res.body.ingest).toHaveProperty("lastWakeAt");
    expect(res.body.ingest.eonetFallbackRecorded).toMatchObject({ total: expect.any(Number) });
    expect(res.body.news).toHaveProperty("storms");
  });

  it("the storm context reports last success and last error per source", async () => {
    let t = new Date("2026-10-18T12:00:00Z");
    const ctx = createStormContext({
      fetchEvents: async () => [{ title: "Hurricane Trudy", closed: null, categories: [{ id: "severeStorms" }] }],
      fetchCyclones: async () => {
        throw new Error("GDACS event list 503");
      },
      now: () => t,
      log: quiet,
    });
    await ctx.names();
    expect(ctx.status()).toEqual({
      eonet: { lastAttemptAt: "2026-10-18T12:00:00.000Z", lastSuccessAt: "2026-10-18T12:00:00.000Z", lastError: null, names: 1 },
      gdacs: { lastAttemptAt: "2026-10-18T12:00:00.000Z", lastSuccessAt: null, lastError: "GDACS event list 503", names: null },
    });
  });
});

describe("alerts use the same location as the map marker", () => {
  // EONET_25292 / GDACS 1104230 "Flood in Türkiye": EONET's polygon (episode 1, south-central Türkiye)
  // vs the GDACS event point (Istanbul); simplified geometry
  const TURKIYE_FLOOD = {
    id: "EONET_25292",
    title: "Flood in Türkiye 1104230",
    categories: [{ id: "floods", title: "Floods" }],
    sources: [{ id: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=FL&eventid=1104230" }],
    geometry: [
      {
        date: "2026-10-11T20:00:00Z",
        type: "Polygon",
        coordinates: [[[32.0, 37.0], [34.5, 37.0], [34.5, 38.6], [32.0, 38.6], [32.0, 37.0]]],
      },
    ],
    gdacsPlace: { countries: ["TR"], lat: 41.1157, lng: 28.9986 },
  };
  const sub = (centerLat, centerLng) => ({ active: true, type: "any", minSeverity: "low", radiusKm: 100, centerLat, centerLng });
  const ISTANBUL = sub(41.01, 28.98);
  const KONYA = sub(37.87, 32.48); // inside the EONET polygon

  it("the contract event sits on the GDACS point (Istanbul) and still satisfies the unchanged schema", () => {
    const { events } = nasaEventsToContract([TURKIYE_FLOOD]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventId: "nasa:EONET_25292", lat: 41.1157, lng: 28.9986 });
    expect(Object.keys(events[0]).sort()).toEqual(["eventId", "lat", "lng", "occurredAt", "severity", "source", "title", "type", "v"]);
    expect(disasterEventSchema.safeParse(events[0]).success).toBe(true);
  });

  it("matches a subscription near Istanbul and no longer the one in south-central Türkiye", () => {
    const [event] = nasaEventsToContract([TURKIYE_FLOOD]).events;
    expect(matchesSubscription(event, ISTANBUL).matched).toBe(true);
    expect(matchesSubscription(event, KONYA).matched).toBe(false);
  });

  it("a GDACS point alone is enough, as on the map (no usable EONET geometry)", () => {
    const [event] = nasaEventsToContract([{ ...TURKIYE_FLOOD, updated: "2026-10-11T20:00:00Z", geometry: [{ date: "2026-10-11T20:00:00Z", type: "Point", coordinates: null }] }]).events;
    expect(event).toMatchObject({ lat: 41.1157, lng: 28.9986, occurredAt: "2026-10-11T20:00:00.000Z" });
  });

  it("without a GDACS point the EONET geometry is used as before", () => {
    const { gdacsPlace, ...eonetOnly } = TURKIYE_FLOOD;
    const [event] = nasaEventsToContract([eonetOnly]).events;
    expect(matchesSubscription(event, KONYA).matched).toBe(true);
    expect(matchesSubscription(event, ISTANBUL).matched).toBe(false);
  });
});

describe("events recorded with the EONET point because GDACS was unreachable (counted on /health)", () => {
  // simplified geometry; GDACS link like the real EONET source
  const flood = (n, extra = {}) => ({
    id: `EONET_${n}`,
    title: `Flood in Testland ${n}`,
    categories: [{ id: "floods", title: "Floods" }],
    sources: [{ id: "GDACS", url: `https://www.gdacs.org/report.aspx?eventtype=FL&eventid=${n}` }],
    geometry: [{ date: "2026-10-11T20:00:00Z", type: "Point", coordinates: [33, 37.8] }],
    ...extra,
  });
  const gdacsAnswer = { ok: true, json: async () => ({ properties: { alertlevel: "Green", alertscore: 1, country: "Testland", iso3: "TST" }, geometry: { type: "Point", coordinates: [29, 41.1] } }) };

  it("the GDACS client marks an event it could not ask about, and clears the mark once GDACS answers", async () => {
    let t = 0;
    let down = true;
    const fetchImpl = vi.fn(async () => { if (down) throw new Error("ECONNRESET"); return gdacsAnswer; });
    const client = createGdacsClient({ fetchImpl, now: () => t, failureTtlMs: 1000, log: quiet, disabled: false });
    const ev = flood(1);
    await client.enrich([ev]);
    expect(ev).toMatchObject({ gdacsPlace: null, gdacsUnreachable: true });
    down = false;
    t = 1001;
    await client.enrich([ev]);
    expect(ev).not.toHaveProperty("gdacsUnreachable");
  });

  it("a stale cached answer served while GDACS is down is not a fallback", async () => {
    let t = 0;
    const fetchImpl = vi.fn().mockResolvedValueOnce(gdacsAnswer).mockRejectedValue(new Error("ECONNRESET"));
    const client = createGdacsClient({ fetchImpl, now: () => t, ttlMs: 10, log: quiet, disabled: false });
    const ev = flood(2);
    await client.enrich([ev]);
    t = 100;
    await client.enrich([ev]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(ev).not.toHaveProperty("gdacsUnreachable");
  });

  it("the mapper lists only events placed on EONET because of an unreachable GDACS", () => {
    const noLink = { ...flood(8), sources: [] };
    const { events, eonetFallback } = nasaEventsToContract([
      flood(3, { gdacsPlace: null, gdacsUnreachable: true }), // GDACS down -> EONET point
      flood(4, { gdacsPlace: { countries: ["TR"], lat: 41.1, lng: 29 } }), // GDACS point
      flood(5, { gdacsPlace: null }), // GDACS answered without a point: EONET is the only location anyway
      noLink, // no GDACS link
    ]);
    expect(events).toHaveLength(4);
    expect(eonetFallback).toEqual(["nasa:EONET_3"]);
    expect(events.find((e) => e.eventId === "nasa:EONET_3")).toMatchObject({ lat: 37.8, lng: 33 });
  });

  it("ingestOnce counts the newly recorded ones (once), the runner adds them up for /health", async () => {
    await resetDb();
    const events = [flood(6, { gdacsPlace: null, gdacsUnreachable: true }), flood(7, { gdacsPlace: { countries: ["TR"], lat: 41.1, lng: 29 } })];
    const deps = { prisma, fetchNasa: async () => events, fetchUsgs: async () => [], publish: vi.fn(async () => {}) };
    const log = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const runner = createIngestRunner({ ingest: (o) => ingestOnce({ ...o, ...deps }), now: () => 1_000_000, log });

    await runner.run("timer");
    expect(runner.status().lastStats).toMatchObject({ inserted: 2 });
    expect(runner.status().eonetFallbackRecorded).toMatchObject({ total: 1, lastRun: 1 });
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("nasa:EONET_6"));

    await runner.run("timer"); // already recorded: not counted again
    expect(runner.status().eonetFallbackRecorded).toMatchObject({ total: 1, lastRun: 0 });
    const row = await prisma.ingestedEvent.findUnique({ where: { eventId: "nasa:EONET_6" } });
    expect(row).toMatchObject({ lat: 37.8, lng: 33 });
  });

  it("the wake endpoint reports the count of the run", async () => {
    const runner = createIngestRunner({ ingest: async () => ({ ...STATS, eonetFallback: 2 }), now: () => 1, log: quiet });
    const res = await request(appWith({ secret: SECRET, runner })).post("/internal/ingest").set("Authorization", `Bearer ${SECRET}`);
    expect(res.body.stats).toMatchObject({ eonetFallback: 2 });
    expect(runner.status().eonetFallbackRecorded).toMatchObject({ total: 2, lastRun: 2 });
  });
});
