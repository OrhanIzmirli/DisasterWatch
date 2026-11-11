/**
 * Cross-source matching (src/services/fusion): the earthquake, storm, FIRMS
 * and GDACS rules at their edges, aftershocks that must stay apart, the
 * ambiguity guard, one-to-one and determinism, independence roles, and the
 * fusion wrapper (wait limit, background FIRMS, cache). Invented data only.
 */
import { describe, it, expect, vi } from "vitest";
import { assign, EQ_RULE, matchSources, quakeCost, stormName } from "../src/services/fusion/match.js";
import { createFusion } from "../src/services/fusion/index.js";

const T0 = Date.parse("2026-11-07T10:00:00Z");
const KM_LAT = 1 / 111.195; // degrees of latitude per km

const quake = (id, { mag = 5.5, dtSec = 0, northKm = 0, lat = 10, lng = 120 } = {}) => ({
  id: `usgs:${id}`,
  source: "usgs",
  type: "earthquake",
  title: "Example quake",
  lat: lat + northKm * KM_LAT,
  lng,
  occurredAt: new Date(T0 + dtSec * 1000).toISOString(),
  measurements: { magnitude: mag },
  alerts: { gdacs: null },
  links: [{ name: "USGS event page", url: `https://earthquake.usgs.gov/earthquakes/eventpage/${id}` }],
});
const emsc = (id, { mag = 5.5, dtSec = 0, northKm = 0, lat = 10, lng = 120, agency = "GFZ" } = {}) => ({
  source: "emsc",
  sourceId: id,
  type: "earthquake",
  time: T0 + dtSec * 1000,
  lat: lat + northKm * KM_LAT,
  lng,
  magnitude: mag,
  agency,
  relaysUsgs: agency === "NEIC",
  url: `https://www.seismicportal.eu/eventdetails.html?unid=${id}`,
});

describe("earthquake rule edges", () => {
  const cases = [
    ["same quake", {}, {}, true],
    ["60 s apart, magnitudes 0.6 apart", { mag: 5.5 }, { dtSec: 60, mag: 6.1 }, true],
    ["61 s apart, magnitudes 0.6 apart", { mag: 5.5 }, { dtSec: 61, mag: 6.1 }, false],
    ["120 s apart, magnitudes 0.5 apart", { mag: 5.5 }, { dtSec: 120, mag: 6.0 }, true],
    ["121 s apart, magnitudes 0.5 apart", { mag: 5.5 }, { dtSec: 121, mag: 6.0 }, false],
    ["99 km apart", {}, { northKm: 99 }, true],
    ["101 km apart", {}, { northKm: 101 }, false],
    ["magnitudes 0.8 apart", { mag: 5.0 }, { mag: 5.8 }, true],
    ["magnitudes 0.9 apart", { mag: 5.0 }, { mag: 5.9 }, false],
  ];
  for (const [name, q, o, expected] of cases) {
    it(name, () => {
      expect(quakeCost(quake("a", q), emsc("x", o)) !== null).toBe(expected);
    });
  }

  it("across the antimeridian", () => {
    expect(quakeCost(quake("a", { lat: -17, lng: 179.9 }), emsc("x", { lat: -17, lng: -179.9 }))).not.toBeNull();
  });

  it("thresholds are the documented ones", () => {
    expect(EQ_RULE).toEqual({ maxDtSec: 60, maxDtSecCloseMag: 120, closeMag: 0.5, maxDistanceKm: 100, maxMagDelta: 0.8 });
  });
});

describe("assignment", () => {
  it("aftershocks two minutes and 20 km apart keep their own EMSC entries", () => {
    const events = [quake("main", { mag: 6.4 }), quake("after", { mag: 5.6, dtSec: 115, northKm: 20 })];
    const obs = [emsc("e-main", { mag: 6.3, dtSec: 3 }), emsc("e-after", { mag: 5.5, dtSec: 118, northKm: 22 })];
    const m = matchSources(events, { emsc: obs });
    expect(m.get("usgs:main").sources[1].sourceEventId).toBe("e-main");
    expect(m.get("usgs:after").sources[1].sourceEventId).toBe("e-after");
  });

  it("two near-equal candidates: nothing attached, event marked ambiguous", () => {
    const m = matchSources([quake("a")], { emsc: [emsc("x", { dtSec: 10 }), emsc("y", { dtSec: -11 })] });
    expect(m.get("usgs:a").sources).toHaveLength(1);
    expect(m.get("usgs:a").ambiguous).toEqual(["emsc"]);
  });

  it("one observation never attaches to two events", () => {
    const events = [quake("a"), quake("b", { dtSec: 2, northKm: 1 })];
    const m = matchSources(events, { emsc: [emsc("x", { dtSec: 1 })] });
    const attached = [...m.values()].filter((v) => v.sources.some((s) => s.source === "emsc"));
    expect(attached.length).toBeLessThanOrEqual(1);
  });

  it("an event whose best observation went elsewhere takes its next one", () => {
    // x fits a better than b; b still has y
    const events = [quake("a"), quake("b", { dtSec: 30, northKm: 40 })];
    const obs = [emsc("x", { dtSec: 1 }), emsc("y", { dtSec: 32, northKm: 41 })];
    const { pairs } = assign(events, obs, quakeCost);
    expect(pairs.map((p) => `${p.e.id}>${p.o.sourceId}`).sort()).toEqual(["usgs:a>x", "usgs:b>y"]);
  });

  it("is deterministic whatever the input order", () => {
    const events = Array.from({ length: 6 }, (_, i) => quake(`q${i}`, { dtSec: i * 40, northKm: i * 15, mag: 5 + i * 0.1 }));
    const obs = events.map((e, i) => emsc(`o${i}`, { dtSec: i * 40 + 2, northKm: i * 15 + 3, mag: 5 + i * 0.1 }));
    const key = (m) => JSON.stringify([...m].sort());
    const a = matchSources(events, { emsc: obs });
    const b = matchSources(events.slice().reverse(), { emsc: obs.slice().reverse() });
    expect(key(a)).toBe(key(b));
  });

  it("an EMSC entry computed by the USGS is listed, not confirming", () => {
    const m = matchSources([quake("a")], { emsc: [emsc("x", { agency: "NEIC" })] });
    expect(m.get("usgs:a").sources[1]).toMatchObject({ source: "emsc", role: "listed", agency: "NEIC", matchedBy: "rule", distanceKm: 0, timeDeltaSec: 0 });
  });
});

describe("storms, FIRMS, GDACS", () => {
  const storm = (title, { lat = 20, lng = -60, hoursAgo = 2, links = [] } = {}) => ({
    id: `eonet:${title.replace(/\s/g, "")}`,
    source: "eonet",
    type: "storm",
    title,
    lat,
    lng,
    occurredAt: new Date(T0 - hoursAgo * 3600_000).toISOString(),
    measurements: {},
    alerts: { gdacs: null },
    links,
  });
  const nhcStorm = (name, { lat = 20, lng = -60 } = {}) => ({ source: "nhc", sourceId: `al99${name}`, type: "storm", name, lat, lng, time: T0, windKts: 65, classificationLabel: "Hurricane", url: "https://www.nhc.noaa.gov/" });

  it("storm names from EONET titles", () => {
    expect(stormName("Tropical Storm Pena")).toBe("pena");
    expect(stormName("Hurricane Melissa")).toBe("melissa");
    expect(stormName("Super Typhoon Example")).toBe("example");
    expect(stormName("Tropical Depression 14E")).toBeNull();
  });

  it("by name up to 1,500 km; without a name only within 300 km and 12 h", () => {
    const named = matchSources([storm("Hurricane Examplea", { lat: 30 })], { nhc: [nhcStorm("Examplea", { lat: 20 })] }); // ~1,110 km
    expect(named.get("eonet:HurricaneExamplea").sources[1]).toMatchObject({ source: "nhc", matchedBy: "name", role: "confirming", classification: "Hurricane" });
    const far = matchSources([storm("Tropical Depression 14E", { lat: 23 })], { nhc: [nhcStorm("Other", { lat: 20 })] }); // ~333 km
    expect(far.get("eonet:TropicalDepression14E").sources).toHaveLength(1);
    const near = matchSources([storm("Tropical Depression 14E", { lat: 22 })], { nhc: [nhcStorm("Other", { lat: 20 })] }); // ~222 km
    expect(near.get("eonet:TropicalDepression14E").sources[1].matchedBy).toBe("rule");
    const lastSeason = matchSources([storm("Hurricane Examplea", { hoursAgo: 8 * 24 })], { nhc: [nhcStorm("Examplea")] }); // same name, 8 days apart
    expect(lastSeason.get("eonet:HurricaneExamplea").sources).toHaveLength(1);
  });

  it("NHC is only listed when the EONET event was taken from the NHC", () => {
    const m = matchSources([storm("Hurricane Exampleb", { links: [{ name: "NOAA_NHC", url: "https://www.nhc.noaa.gov/archive/x" }] })], { nhc: [nhcStorm("Exampleb")] });
    expect(m.get("eonet:HurricaneExampleb").sources[1].role).toBe("listed");
  });

  const fire = { id: "eonet:F1", source: "eonet", type: "wildfire", title: "Wildfire", lat: 0, lng: 0, occurredAt: new Date(T0).toISOString(), measurements: {}, alerts: { gdacs: "orange" }, links: [] };

  it("FIRMS: 3 or more detections confirm, 1-2 are listed, 0 adds nothing", () => {
    const at = (count) => matchSources([fire], { firms: new Map([["eonet:F1", { count, latest: T0 - 3600_000, url: "https://firms.example/map" }]]) }).get("eonet:F1").sources;
    expect(at(3)[1]).toMatchObject({ source: "firms", role: "confirming", detections: 3, matchedBy: "proximity", timeDeltaSec: -3600 });
    expect(at(2)[1].role).toBe("listed");
    expect(at(0)).toHaveLength(1);
  });

  it("GDACS by reference; listed when the event came from GDACS only", () => {
    const report = { name: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1" };
    const fromGdacs = matchSources([{ ...fire, links: [report] }]).get("eonet:F1").sources[1];
    expect(fromGdacs).toMatchObject({ source: "gdacs", role: "listed", matchedBy: "reference", level: "orange", url: report.url });
    const withIrwin = matchSources([{ ...fire, links: [{ name: "IRWIN", url: "https://irwin.doi.gov/x" }, report] }]).get("eonet:F1").sources[1];
    expect(withIrwin.role).toBe("confirming");
    expect(matchSources([{ ...fire, alerts: { gdacs: null }, links: [report] }]).get("eonet:F1").sources).toHaveLength(1);
  });

  it("a missing source (null) adds nothing and breaks nothing; the primary is always first", () => {
    const m = matchSources([quake("a"), fire], { emsc: null, nhc: null, firms: null });
    expect(m.get("usgs:a").sources).toEqual([{ source: "usgs", role: "primary", sourceEventId: "a", url: "https://earthquake.usgs.gov/earthquakes/eventpage/a", matchedBy: null, distanceKm: null, timeDeltaSec: null }]);
    expect(m.get("eonet:F1").sources[0]).toMatchObject({ source: "eonet", role: "primary", url: "https://eonet.gsfc.nasa.gov/api/v3/events/F1" });
  });
});

describe("createFusion", () => {
  const src = (status, data, delayMs = 0) => ({ get: vi.fn(() => new Promise((r) => setTimeout(() => r({ status, data, fetchedAt: T0 }), delayMs))) });
  const firmsOff = { enabled: false, peek: vi.fn(), refresh: vi.fn() };

  it("matches with what the sources hold and caches the result", async () => {
    const emscData = [emsc("x")];
    const fusion = createFusion({ sources: { emsc: src("ok", emscData), nhc: src("ok", []), firms: firmsOff }, now: () => T0 });
    const events = [quake("a")];
    const first = await fusion.fuse(events);
    expect(first.status).toEqual({ emsc: "ok", nhc: "ok", firms: "off" });
    expect(first.matches.get("usgs:a").sources[1].sourceEventId).toBe("x");
    expect((await fusion.fuse(events)).matches).toBe(first.matches);
    expect(firmsOff.refresh).not.toHaveBeenCalled();
  });

  it("does not wait longer than the limit for a slow source", async () => {
    const fusion = createFusion({ sources: { emsc: src("ok", [emsc("x")], 200), nhc: src("ok", []), firms: firmsOff }, now: () => T0, waitMs: 20 });
    const { status, matches } = await fusion.fuse([quake("a")]);
    expect(status.emsc).toBe("pending");
    expect(matches.get("usgs:a").sources).toHaveLength(1);
  });

  it("asks FIRMS in the background for recent wildfires only", async () => {
    const firms = { enabled: true, refresh: vi.fn(async () => {}), peek: vi.fn(() => new Map()) };
    const fusion = createFusion({ sources: { emsc: src("ok", []), nhc: src("ok", []), firms }, now: () => T0 });
    const fire = (id, hoursAgo) => ({ id, source: "eonet", type: "wildfire", lat: 0, lng: 0, occurredAt: new Date(T0 - hoursAgo * 3600_000).toISOString(), measurements: {}, alerts: {}, links: [] });
    const { status } = await fusion.fuse([fire("new", 5), fire("old", 100)]);
    expect(firms.refresh.mock.calls[0][0].map((e) => e.id)).toEqual(["new"]);
    expect(status.firms).toBe("pending");
  });
});

describe("assign runs per independent group", () => {
  // the previous single global run, kept here as the reference
  function globalAssign(events, observations, costFn) {
    const cand = [];
    for (const e of events) for (const o of observations) {
      const fit = costFn(e, o);
      if (fit) cand.push({ e, o, fit });
    }
    const sortCost = (a, b) => a.fit.cost - b.fit.cost || (a.o.sourceId < b.o.sourceId ? -1 : a.o.sourceId > b.o.sourceId ? 1 : 0) || (a.e.id < b.e.id ? -1 : 1);
    const clear = (list) => list.length < 2 || list[1].fit.cost >= 1.5 * list[0].fit.cost + 1e-9;
    const group = (list, key) => {
      const m = new Map();
      for (const c of list) (m.get(key(c)) ?? m.set(key(c), []).get(key(c))).push(c);
      for (const l of m.values()) l.sort(sortCost);
      return m;
    };
    const pairs = [];
    const ambiguous = new Set();
    const doneE = new Set();
    const doneO = new Set();
    for (let changed = true; changed; ) {
      changed = false;
      const live = cand.filter((c) => !doneE.has(c.e.id) && !doneO.has(c.o.sourceId));
      const byE = group(live, (c) => c.e.id);
      const byO = group(live, (c) => c.o.sourceId);
      for (const id of [...byE.keys()].sort()) {
        const eList = byE.get(id);
        const best = eList[0];
        const oList = byO.get(best.o.sourceId);
        if (oList[0] !== best || doneO.has(best.o.sourceId)) continue;
        changed = true;
        doneE.add(id);
        doneO.add(best.o.sourceId);
        if (clear(eList) && clear(oList)) pairs.push(best);
        else ambiguous.add(id);
        break;
      }
    }
    return { pairs, ambiguous };
  }

  // small deterministic pseudo-random generator, so a failure is reproducible
  const rng = (seed) => () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const key = ({ pairs, ambiguous }) => JSON.stringify({ pairs: pairs.map((p) => `${p.e.id}>${p.o.sourceId}`).sort(), ambiguous: [...ambiguous].sort() });

  it("gives the same pairs and ambiguous events as one global run (dense clusters, aftershock swarms, isolated quakes)", () => {
    for (let seed = 1; seed <= 40; seed++) {
      const r = rng(seed);
      const events = [];
      const obs = [];
      for (let i = 0; i < 60; i++) {
        // a few dense spots make many candidates per event; the rest are isolated
        const spot = r() < 0.4 ? Math.floor(r() * 3) : 10 + i;
        const base = { lat: 10 + spot, lng: 120, dtSec: Math.floor(r() * 90), northKm: r() * 60, mag: 4.5 + r() * 1.5 };
        events.push(quake(`q${seed}-${i}`, base));
        if (r() < 0.85) obs.push(emsc(`o${seed}-${i}`, { ...base, dtSec: base.dtSec + Math.floor(r() * 50), northKm: base.northKm + r() * 40, mag: base.mag + (r() - 0.5) }));
      }
      expect(key(assign(events, obs, quakeCost)), `seed ${seed}`).toBe(key(globalAssign(events, obs, quakeCost)));
    }
  });
});
