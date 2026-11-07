/**
 * Confidence and priority scores (0-100), docs/scoring.md sections 2 and 3.
 * Every score is returned with the terms that produced it, so a client can
 * show "why" and anyone can recompute it. Change a number here and in
 * docs/scoring.md together, and raise SCORE_VERSION.
 */

export const SCORE_VERSION = 1;

/* ---------------- confidence ---------------- */

/** Points of the primary source. */
export const PRIMARY_POINTS = { usgsReviewed: 60, usgsAutomatic: 45, eonetOfficial: 45, eonet: 40 };

/** EONET contributors that are official agencies (fire services, warning centres). */
export const OFFICIAL_EONET_SOURCES = new Set(["IRWIN", "INCIWEB", "CALFIRE", "NOAA_NHC", "JTWC", "FEMA", "BCWILDFIRE", "ABFIRE", "MBFIRE", "SKFIRE", "ONFIRE", "QCFIRE", "NSWRFS", "NIFC", "CEMS"]);

/** Points per matched source and role (see match.js for the roles). */
export const CONFIRMATION_POINTS = {
  nhc: { confirming: 30, listed: 10 },
  firms: { confirming: 25, listed: 10 },
  emsc: { confirming: 20, listed: 5 },
  gdacs: { confirming: 15, listed: 5 },
};
export const CONFIRMATION_CAP = 40;

/** Staleness (not for earthquakes): -1 point per full STALE_STEP_H hours past STALE_GRACE_H since the event was last seen, at most STALE_MAX. */
export const STALE_GRACE_H = 24;
export const STALE_STEP_H = 6;
export const STALE_MAX = 20;

const clamp = (n, lo = 0, hi = 100) => Math.min(hi, Math.max(lo, n));
const SOURCE_NAMES = { usgs: "USGS", eonet: "NASA EONET", emsc: "EMSC", nhc: "NOAA NHC", firms: "NASA FIRMS", gdacs: "GDACS" };

function primaryTerm(event) {
  if (event.source === "usgs") {
    const reviewed = event.status === "reviewed";
    return { term: "primary", source: "usgs", points: reviewed ? PRIMARY_POINTS.usgsReviewed : PRIMARY_POINTS.usgsAutomatic, reason: reviewed ? "USGS, reviewed by a seismologist" : "USGS, automatic solution" };
  }
  const official = (event.links ?? []).map((l) => String(l.name ?? "").toUpperCase()).filter((n) => OFFICIAL_EONET_SOURCES.has(n));
  return official.length
    ? { term: "primary", source: "eonet", points: PRIMARY_POINTS.eonetOfficial, reason: `NASA EONET, reported by ${official.join(", ")}` }
    : { term: "primary", source: "eonet", points: PRIMARY_POINTS.eonet, reason: "NASA EONET" };
}

/** When the event was last seen by any source (ms): the primary time, a later FIRMS detection or NHC advisory. */
export function lastSeen(event, sources) {
  let t = Date.parse(event.updatedAt ?? "") || Date.parse(event.occurredAt);
  for (const s of sources) {
    if (s.source === "firms" && s.timeDeltaSec !== null) t = Math.max(t, Date.parse(event.occurredAt) + s.timeDeltaSec * 1000);
    if (s.source === "nhc" && s.timeDeltaSec !== null && s.observedAt) t = Math.max(t, Date.parse(s.observedAt));
  }
  return t;
}

/**
 * @param {object} event public v1 event
 * @param {object[]} sources matched sources (match.js), primary first
 * -> { score, components: [{ term, source?, role?, points, reason }] }
 */
export function confidenceScore(event, sources, now) {
  const components = [primaryTerm(event)];
  let confirm = 0;
  for (const s of sources.slice(1)) {
    const points = CONFIRMATION_POINTS[s.source]?.[s.role] ?? 0;
    if (!points) continue;
    confirm += points;
    const what = s.role === "confirming" ? "independent confirmation" : "lists it, not independently";
    const detail = s.source === "emsc" && s.agency ? ` (solution by ${s.agency})` : s.source === "firms" ? ` (${s.detections} satellite detections)` : s.source === "gdacs" && s.level ? ` (${s.level} alert)` : "";
    components.push({ term: "confirmation", source: s.source, role: s.role, points, reason: `${SOURCE_NAMES[s.source] ?? s.source}: ${what}${detail}` });
  }
  if (confirm > CONFIRMATION_CAP) components.push({ term: "cap", points: CONFIRMATION_CAP - confirm, reason: `confirmations count for at most ${CONFIRMATION_CAP} points` });

  if (event.type !== "earthquake") {
    const hours = (now - lastSeen(event, sources)) / 3600_000;
    const penalty = Math.min(STALE_MAX, Math.max(0, Math.floor((hours - STALE_GRACE_H) / STALE_STEP_H)));
    if (penalty > 0) components.push({ term: "staleness", points: -penalty, reason: `last seen ${Math.floor(hours)} h ago` });
  }
  return { score: clamp(components.reduce((a, c) => a + c.points, 0)), components };
}

/* ---------------- priority ---------------- */

export const PRIORITY_WEIGHTS = { severity: 0.45, exposure: 0.35, confidence: 0.2 };
export const GDACS_LEVEL_POINTS = { green: 20, orange: 60, red: 100 };
export const PAGER_LEVEL_POINTS = { green: 20, yellow: 50, orange: 75, red: 100 };
/** Used only when an event has no measurement and no alert level. */
export const SEVERITY_LABEL_POINTS = { high: 70, medium: 45, low: 25, unrated: 15 };

/** Radius (km) within which people count as exposed. */
export function exposureRadiusKm(event) {
  if (event.type === "earthquake") {
    const m = event.measurements?.magnitude ?? 0;
    return m >= 7 ? 200 : m >= 6 ? 100 : m >= 5 ? 50 : 25;
  }
  return { storm: 200, flood: 50, wildfire: 25 }[event.type] ?? 50;
}

/** 0 at 1,000 people or fewer, +20 per tenfold: 10k -> 20, 1M -> 60, 100M -> 100. */
export const exposurePoints = (population) => clamp(Math.round(20 * Math.log10(Math.max(1, population) / 1000)));

/** -> { value, basis } : the highest of the measurements and alert levels the event has. */
export function severityPoints(event, sources = []) {
  const m = event.measurements ?? {};
  const cands = [];
  if (Number.isFinite(m.magnitude)) cands.push([clamp(Math.round(20 + ((m.magnitude - 4.5) * 80) / 3)), `magnitude ${m.magnitude}`]);
  const nhcWind = sources.find((s) => s.source === "nhc")?.windKts;
  const wind = [m.peakWindKts, m.currentWindKts, nhcWind].filter(Number.isFinite);
  if (wind.length) cands.push([clamp(Math.round(20 + ((Math.max(...wind) - 34) * 80) / 103)), `wind ${Math.max(...wind)} kt`]);
  if (Number.isFinite(m.burnedAreaHa) && m.burnedAreaHa > 0) cands.push([clamp(Math.round(20 + ((Math.log10(m.burnedAreaHa) - 2) * 80) / 3)), `${Math.round(m.burnedAreaHa)} ha burned`]);
  const gdacs = event.alerts?.gdacs;
  if (GDACS_LEVEL_POINTS[gdacs]) cands.push([GDACS_LEVEL_POINTS[gdacs], `GDACS ${gdacs} alert`]);
  const pager = event.alerts?.usgsPager;
  if (PAGER_LEVEL_POINTS[pager]) cands.push([PAGER_LEVEL_POINTS[pager], `USGS PAGER ${pager}`]);
  if (!cands.length) return { value: SEVERITY_LABEL_POINTS[event.severity] ?? SEVERITY_LABEL_POINTS.unrated, basis: `rated ${event.severity ?? "unrated"}, no measurement` };
  const [value, basis] = cands.sort((a, b) => b[0] - a[0])[0];
  return { value, basis };
}

/**
 * @param {{ near: Function } | null} population index (population.js); null = exposure unknown
 * -> { score, components: [{ term, value, weight, basis }], exposure: { population, radiusKm } | null }
 * Without exposure the other two weights are scaled up to sum to 1 (documented).
 */
export function priorityScore(event, sources, confidence, population) {
  const sev = severityPoints(event, sources);
  const radiusKm = exposureRadiusKm(event);
  const exp = population ? population.near(event.lat, event.lng, radiusKm) : null;
  const terms = [
    { term: "severity", value: sev.value, weight: PRIORITY_WEIGHTS.severity, basis: sev.basis },
    exp
      ? {
          term: "exposure",
          value: exposurePoints(exp.population),
          weight: PRIORITY_WEIGHTS.exposure,
          basis: exp.population > 0 ? `about ${exp.population.toLocaleString("en-US")} people in places within ${radiusKm} km` : `no places of 5,000 or more people within ${radiusKm} km`,
        }
      : { term: "exposure", value: null, weight: 0, basis: "population data not available" },
    { term: "confidence", value: confidence, weight: PRIORITY_WEIGHTS.confidence, basis: `confidence ${confidence}` },
  ];
  const total = terms.reduce((a, t) => a + t.weight, 0);
  for (const t of terms) t.weight = Math.round((t.weight / total) * 1000) / 1000;
  const score = clamp(Math.round(terms.reduce((a, t) => a + (t.value ?? 0) * t.weight, 0)));
  return { score, components: terms, exposure: exp ? { population: exp.population, radiusKm } : null };
}

/**
 * Scores for every event.
 * @param {object[]} events public v1 events
 * @param {Map<string, { sources }>} matches match.js output
 * -> Map eventId -> { confidence, priority }
 */
export function scoreEvents(events, matches, { now, population = null }) {
  const out = new Map();
  for (const e of events) {
    const sources = matches.get(e.id)?.sources ?? [];
    const confidence = confidenceScore(e, sources, now);
    out.set(e.id, { confidence, priority: priorityScore(e, sources, confidence.score, population) });
  }
  return out;
}
