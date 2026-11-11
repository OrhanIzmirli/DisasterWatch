/**
 * Cross-source matching: which observations of the confirming sources (EMSC,
 * NHC, FIRMS, GDACS) describe the same event as a primary event (USGS or
 * EONET, in the public v1 model of api/v1/events.js).
 *
 * The primary event is the anchor: it keeps its id and fields, confirming
 * observations only attach to it. An observation that matches no primary event
 * is ignored (an event only EMSC lists is never shown).
 *
 * Rules (docs/scoring.md):
 *   earthquake  EMSC, |dt| <= 60 s (or <= 120 s when |dmag| <= 0.5), distance <= 100 km, |dmag| <= 0.8
 *   storm       NHC, same storm name, distance <= 1,500 km and |dt| <= 7 days; otherwise distance <= 300 km and |dt| <= 12 h
 *   wildfire    FIRMS, detections within 10 km in the last 48 h (counted by firms.js)
 *   any EONET   GDACS, by reference: the event links to a GDACS report
 *
 * Against false merges:
 *   - only the same type is compared;
 *   - one-to-one: an observation attaches to one event and an event takes one
 *     observation per source;
 *   - mutual best: the pair must be each other's cheapest candidate;
 *   - ambiguity guard: when the second-best candidate on either side costs
 *     less than AMBIGUITY_RATIO times the best, nothing is attached and the
 *     event is marked ambiguous for that source;
 *   - no chains: observations are only compared with primary events, never
 *     with each other.
 *
 * Independence: an observation that relays the primary source (an EMSC entry
 * computed by the USGS, an NHC storm or GDACS report the EONET event was
 * created from) has role "listed"; an independent one has role "confirming".
 */
import { distanceKm } from "../sources/firms.js";

export const EQ_RULE = { maxDtSec: 60, maxDtSecCloseMag: 120, closeMag: 0.5, maxDistanceKm: 100, maxMagDelta: 0.8 };
export const STORM_RULE = { nameMaxDistanceKm: 1500, nameMaxDtHours: 7 * 24, maxDistanceKm: 300, maxDtHours: 12 };
export const FIRMS_RULE = { confirmAt: 3 };
export const AMBIGUITY_RATIO = 1.5;

const hostOf = (url) => {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
};
const linksTo = (event, host) => (event.links ?? []).some((l) => hostOf(l.url)?.endsWith(host));
// parsed once per event: the pair costs ask for it about a million times per matching run
const times = new WeakMap();
const timeOf = (event) => {
  let t = times.get(event);
  if (t === undefined) times.set(event, (t = Date.parse(event.occurredAt)));
  return t;
};
const round = (n, d = 1) => (n === null || n === undefined ? null : Math.round(n * 10 ** d) / 10 ** d);

/** Earthquake pair cost (0 = identical), or null when the pair is outside the rule. */
export function quakeCost(event, obs) {
  const mag = event.measurements?.magnitude;
  const dt = Math.abs(timeOf(event) - obs.time) / 1000;
  if (dt > EQ_RULE.maxDtSecCloseMag) return null; // cheap reject first: most pairs are hours apart
  const dist = distanceKm(event.lat, event.lng, obs.lat, obs.lng);
  const dmag = Number.isFinite(mag) && Number.isFinite(obs.magnitude) ? Math.abs(mag - obs.magnitude) : null;
  if (dmag === null || dmag > EQ_RULE.maxMagDelta || dist > EQ_RULE.maxDistanceKm) return null;
  if (dt > (dmag <= EQ_RULE.closeMag ? EQ_RULE.maxDtSecCloseMag : EQ_RULE.maxDtSec)) return null;
  return { cost: dt / EQ_RULE.maxDtSec + dist / EQ_RULE.maxDistanceKm + dmag / EQ_RULE.maxMagDelta, dt, dist, dmag };
}

/** The storm's name from an EONET title ("Tropical Storm Pena", "Hurricane Melissa"), lower case, or null. */
export function stormName(title) {
  const words = String(title ?? "")
    .replace(/\(.*?\)/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const generic = /^(super|severe|tropical|subtropical|post-tropical|extratropical|cyclonic|cyclone|storm|depression|hurricane|typhoon|major|potential|remnants|of|invest|\d+[a-z]?|[ivx]+)$/i;
  const name = words.filter((w) => !generic.test(w)).pop();
  return name ? name.toLowerCase().replace(/[^a-zÀ-ɏ-]/g, "") || null : null;
}

export function stormCost(event, obs) {
  const dist = distanceKm(event.lat, event.lng, obs.lat, obs.lng);
  const dtH = Math.abs(timeOf(event) - obs.time) / 3600_000;
  const name = stormName(event.title);
  const sameName = name !== null && obs.name && name === obs.name.toLowerCase();
  if (sameName && dist <= STORM_RULE.nameMaxDistanceKm && dtH <= STORM_RULE.nameMaxDtHours) return { cost: dist / STORM_RULE.nameMaxDistanceKm, dt: dtH * 3600, dist, byName: true };
  if (dist <= STORM_RULE.maxDistanceKm && dtH <= STORM_RULE.maxDtHours) return { cost: 1 + dist / STORM_RULE.maxDistanceKm + dtH / STORM_RULE.maxDtHours, dt: dtH * 3600, dist, byName: false };
  return null;
}

/**
 * One-to-one assignment with mutual best and the ambiguity guard, repeated
 * until nothing changes (an event whose best observation went to another
 * event may still take its next one).
 * -> { pairs: [{ e, o, fit }], ambiguous: Set<eventId> }
 */
export function assign(events, observations, costFn) {
  const cand = [];
  for (const e of events) {
    for (const o of observations) {
      const fit = costFn(e, o);
      if (fit) cand.push({ e, o, fit });
    }
  }
  // Candidates that share no event and no observation (directly or through others) never
  // affect each other's decisions, so the rounds run per group: the same pairs and the same
  // ambiguous events as one global run, without regrouping every candidate after each
  // decision (about 1 s per call with 1,500 events and 1,500 EMSC entries on a desktop CPU,
  // several seconds on the free hosting plan, and it blocked every request meanwhile).
  const pairs = [];
  const ambiguous = new Set();
  for (const group of independentGroups(cand)) {
    const out = decide(group);
    pairs.push(...out.pairs);
    for (const id of out.ambiguous) ambiguous.add(id);
  }
  return { pairs, ambiguous };
}

/** Splits candidates into groups connected by a shared event or observation (union-find). */
function independentGroups(cand) {
  const parent = new Map();
  const find = (k) => {
    let r = k;
    while (parent.get(r) !== r) r = parent.get(r);
    for (let n = k; parent.get(n) !== r; ) {
      const next = parent.get(n);
      parent.set(n, r);
      n = next;
    }
    return r;
  };
  const node = (k) => (parent.has(k) ? k : (parent.set(k, k), k));
  for (const c of cand) {
    const a = find(node(`e:${c.e.id}`));
    const b = find(node(`o:${c.o.sourceId}`));
    if (a !== b) parent.set(a, b);
  }
  const groups = new Map();
  for (const c of cand) {
    const r = find(`e:${c.e.id}`);
    (groups.get(r) ?? groups.set(r, []).get(r)).push(c);
  }
  return groups.values();
}

/** The one-to-one rounds over one group of candidates. */
function decide(cand) {
  const sortCost = (a, b) => a.fit.cost - b.fit.cost || (a.o.sourceId < b.o.sourceId ? -1 : a.o.sourceId > b.o.sourceId ? 1 : 0) || (a.e.id < b.e.id ? -1 : 1);
  const clear = (list) => list.length < 2 || list[1].fit.cost >= AMBIGUITY_RATIO * list[0].fit.cost + 1e-9;
  const group = (list, key) => {
    const m = new Map();
    for (const c of list) (m.get(key(c)) ?? m.set(key(c), []).get(key(c))).push(c);
    for (const l of m.values()) l.sort(sortCost);
    return m;
  };

  const pairs = [];
  const ambiguous = new Set();
  const doneE = new Set(); // paired or ambiguous
  const doneO = new Set(); // paired or ambiguous between events
  for (let changed = true; changed; ) {
    changed = false;
    const live = cand.filter((c) => !doneE.has(c.e.id) && !doneO.has(c.o.sourceId));
    const byE = group(live, (c) => c.e.id);
    const byO = group(live, (c) => c.o.sourceId);
    for (const id of [...byE.keys()].sort()) {
      const eList = byE.get(id);
      const best = eList[0];
      const oList = byO.get(best.o.sourceId);
      if (oList[0] !== best || doneO.has(best.o.sourceId)) continue; // not mutual best (yet)
      changed = true;
      doneE.add(id);
      doneO.add(best.o.sourceId);
      if (clear(eList) && clear(oList)) pairs.push(best);
      else ambiguous.add(id);
      break; // regroup: the next decision sees only what is still free
    }
  }
  return { pairs, ambiguous };
}

const primaryEntry = (event) => {
  const usgs = event.source === "usgs";
  const own = usgs ? event.links?.find((l) => hostOf(l.url)?.endsWith("usgs.gov")) : null;
  return {
    source: event.source,
    role: "primary",
    sourceEventId: event.id.replace(/^(usgs|eonet):/, ""),
    url: own?.url ?? (usgs ? null : `https://eonet.gsfc.nasa.gov/api/v3/events/${event.id.replace(/^eonet:/, "")}`),
    matchedBy: null,
    distanceKm: null,
    timeDeltaSec: null,
  };
};

/**
 * @param {object[]} events public v1 events
 * @param {{ emsc?: object[] | null, nhc?: object[] | null, firms?: Map<string, object> | null }} obs
 *   confirming observations; null/undefined = that source is not available
 * -> Map eventId -> { sources: [...], ambiguous: string[] }
 */
export function matchSources(events, { emsc = null, nhc = null, firms = null } = {}) {
  const out = new Map(events.map((e) => [e.id, { sources: [primaryEntry(e)], ambiguous: [] }]));
  const add = (id, entry) => out.get(id).sources.push(entry);

  if (Array.isArray(emsc)) {
    const quakes = events.filter((e) => e.type === "earthquake");
    const { pairs, ambiguous } = assign(quakes, emsc, quakeCost);
    for (const { e, o, fit } of pairs) {
      add(e.id, {
        source: "emsc",
        role: o.relaysUsgs && e.source === "usgs" ? "listed" : "confirming",
        sourceEventId: o.sourceId,
        url: o.url,
        matchedBy: "rule",
        distanceKm: round(fit.dist),
        timeDeltaSec: round(fit.dt, 0),
        agency: o.agency,
        magnitude: o.magnitude,
      });
    }
    for (const id of ambiguous) out.get(id).ambiguous.push("emsc");
  }

  if (Array.isArray(nhc)) {
    const storms = events.filter((e) => e.type === "storm");
    const { pairs, ambiguous } = assign(storms, nhc, stormCost);
    for (const { e, o, fit } of pairs) {
      add(e.id, {
        source: "nhc",
        role: linksTo(e, "nhc.noaa.gov") ? "listed" : "confirming",
        sourceEventId: o.sourceId,
        url: o.url,
        matchedBy: fit.byName ? "name" : "rule",
        distanceKm: round(fit.dist),
        timeDeltaSec: round(fit.dt, 0),
        windKts: o.windKts,
        classification: o.classificationLabel,
        observedAt: new Date(o.time).toISOString(),
      });
    }
    for (const id of ambiguous) out.get(id).ambiguous.push("nhc");
  }

  if (firms instanceof Map) {
    for (const e of events) {
      const hit = e.type === "wildfire" ? firms.get(e.id) : undefined;
      if (!hit || hit.count === 0) continue;
      add(e.id, {
        source: "firms",
        role: hit.count >= FIRMS_RULE.confirmAt ? "confirming" : "listed",
        sourceEventId: null,
        url: hit.url,
        matchedBy: "proximity",
        distanceKm: null,
        timeDeltaSec: hit.latest ? round((hit.latest - timeOf(e)) / 1000, 0) : null,
        detections: hit.count,
      });
    }
  }

  // GDACS by reference: the EONET event links to a GDACS report and carries its level
  for (const e of events) {
    const report = (e.links ?? []).find((l) => hostOf(l.url) === "gdacs.org");
    if (e.source !== "eonet" || !report || !e.alerts?.gdacs) continue;
    // EONET builds events outside the US from GDACS: then GDACS is where the event came from
    const fromGdacs = (e.links ?? []).every((l) => hostOf(l.url) === "gdacs.org");
    add(e.id, { source: "gdacs", role: fromGdacs ? "listed" : "confirming", sourceEventId: null, url: report.url, matchedBy: "reference", distanceKm: null, timeDeltaSec: null, level: e.alerts.gdacs });
  }

  return out;
}
