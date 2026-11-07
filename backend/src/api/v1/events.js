/**
 * Public API v1: the event model, query parsing, filtering and cursor paging.
 *
 * Events come from the same in-memory source cache as the dashboard feed
 * (feedService.snapshot()), so API traffic never adds NASA/USGS requests.
 * The public model is its own shape: the dashboard's feed items can change
 * without breaking API clients.
 *
 * GDACS (see attribution.js): only the alert level and the report link are
 * exposed. EONET events are normalised without the GDACS point, so coordinates
 * always come from EONET itself.
 */
import { normalizeNasaEvents } from "../../utils/normalizeDisasters.js";
import { normalizeUsgsEarthquakes } from "../../services/usgs.service.js";
import { FEED_TYPES, FEED_SEVERITIES } from "../../services/feed.service.js";

/** Every type covers this many days (EONET is fetched for 30 days, USGS from its month feed). */
export const WINDOW_DAYS = 30;
export const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
export const PAGE_LIMIT = { min: 1, max: 200, fallback: 50 };
/** Requests per client IP per window (routes/v1.routes.js; documented in openapi.js). */
export const RATE_LIMIT = Object.freeze({ windowMs: 60 * 1000, limit: 60 });

export const TYPES = FEED_TYPES; // earthquake, wildfire, flood, storm
export const SEVERITIES = FEED_SEVERITIES; // high, medium, low, unrated
const RANK = { low: 1, medium: 2, high: 3 };

/** Query parameters GET /v1/disasters accepts; anything else is a 400 (typos should not pass silently). */
export const LIST_PARAMS = ["type", "severity", "minSeverity", "from", "to", "bbox", "country", "limit", "cursor"];

export class BadRequest extends Error {
  constructor(message) {
    super(message);
    this.name = "BadRequest";
  }
}

const numOrNull = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Feed item (utils/normalizeDisasters.js, services/usgs.service.js) -> public v1 event. */
export function toPublicEvent(item) {
  const d = item.details ?? {};
  const source = d.source === "usgs" ? "usgs" : "eonet";
  return {
    id: source === "usgs" ? d.eventId : String(d.eventId ?? "").replace(/^nasa:/, "eonet:"),
    source,
    type: item.type,
    severity: item.severity,
    severityReason: d.severityReason ?? null,
    title: d.cleanTitle || item.location,
    place: d.place ?? null,
    country: item.country ?? null,
    lat: item.lat,
    lng: item.lng,
    occurredAt: d.occurredAt ?? null,
    updatedAt: d.updatedAt ?? null,
    status: d.status ?? null,
    measurements: {
      magnitude: numOrNull(d.magnitude),
      magnitudeType: d.magType ?? null,
      depthKm: numOrNull(d.depthKm),
      burnedAreaHa: numOrNull(d.areaHa),
      peakWindKts: numOrNull(d.peakKts),
      currentWindKts: numOrNull(d.currentKts),
    },
    alerts: {
      usgsPager: d.pagerAlert ?? null,
      tsunami: typeof d.tsunami === "boolean" ? d.tsunami : null,
      gdacs: d.gdacsLevel ?? null,
    },
    links: Array.isArray(d.sources) ? d.sources.map((s) => ({ name: s.name, url: s.url })) : [],
  };
}

/** Newest first; the id breaks ties so the order (and the cursor) is total. */
export function compareEvents(a, b) {
  return b.occurredAt.localeCompare(a.occurredAt) || a.id.localeCompare(b.id);
}

/**
 * Raw source payloads -> every public event of the window, sorted.
 * The GDACS point is dropped before normalising (coordinates stay EONET's).
 */
export function buildEvents({ nasa, usgs }, nowMs) {
  const eonet = nasa ? normalizeNasaEvents(nasa.map(({ gdacsPlace: _omit, ...e }) => e)) : [];
  const quakes = usgs ? normalizeUsgsEarthquakes(usgs, { limit: Number.MAX_SAFE_INTEGER }) : [];
  const since = nowMs - WINDOW_MS;
  return [...eonet, ...quakes]
    .map(toPublicEvent)
    .filter((e) => e.id && e.occurredAt && Date.parse(e.occurredAt) >= since && Date.parse(e.occurredAt) <= nowMs + 60_000)
    .sort(compareEvents);
}

/** Remembers the last build per pair of source payloads: a refresh (every 5 min) is the only time events are rebuilt. */
export function createEventCache(build = buildEvents) {
  let last = null;
  return function eventsFor(served, nowMs) {
    // the window edge moves with the clock, so the build is also redone once a minute
    const minute = Math.floor(nowMs / 60_000);
    if (last && last.nasa === served.nasa && last.usgs === served.usgs && last.minute === minute) return last.events;
    const events = build(served, nowMs);
    last = { nasa: served.nasa, usgs: served.usgs, minute, events };
    return events;
  };
}

/* ---------------- query parsing ---------------- */

const one = (v, name) => {
  if (v === undefined) return undefined;
  if (Array.isArray(v)) throw new BadRequest(`${name} is given more than once`);
  if (typeof v !== "string") throw new BadRequest(`${name} is not a plain value`);
  return v.trim();
};

function list(v, name, allowed) {
  const s = one(v, name);
  if (s === undefined) return undefined;
  const values = [...new Set(s.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean))];
  if (!values.length) throw new BadRequest(`${name} is empty`);
  const bad = values.filter((x) => !allowed.includes(x));
  if (bad.length) throw new BadRequest(`${name}: unknown value ${bad.join(", ")} (allowed: ${allowed.join(", ")})`);
  return values;
}

function isoDate(v, name) {
  const s = one(v, name);
  if (s === undefined) return undefined;
  // full ISO 8601 date or date-time; Date.parse alone would accept "1" or "March 3"
  if (!/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})?)?$/.test(s)) throw new BadRequest(`${name} must be an ISO 8601 date or date-time`);
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new BadRequest(`${name} is not a valid date`);
  return t;
}

function bbox(v) {
  const s = one(v, "bbox");
  if (s === undefined) return undefined;
  const parts = s.split(",").map((x) => x.trim());
  if (parts.length !== 4 || parts.some((x) => x === "" || !Number.isFinite(Number(x)))) {
    throw new BadRequest("bbox must be minLng,minLat,maxLng,maxLat");
  }
  const [minLng, minLat, maxLng, maxLat] = parts.map(Number);
  if ([minLng, maxLng].some((x) => x < -180 || x > 180)) throw new BadRequest("bbox longitudes must be between -180 and 180");
  if ([minLat, maxLat].some((x) => x < -90 || x > 90)) throw new BadRequest("bbox latitudes must be between -90 and 90");
  if (minLat > maxLat) throw new BadRequest("bbox minLat must not be above maxLat");
  // minLng > maxLng is a box across the antimeridian (e.g. 170,-50,-170,-10)
  return { minLng, minLat, maxLng, maxLat };
}

function limit(v) {
  const s = one(v, "limit");
  if (s === undefined) return PAGE_LIMIT.fallback;
  if (!/^\d+$/.test(s)) throw new BadRequest(`limit must be an integer from ${PAGE_LIMIT.min} to ${PAGE_LIMIT.max}`);
  const n = Number(s);
  if (n < PAGE_LIMIT.min || n > PAGE_LIMIT.max) throw new BadRequest(`limit must be an integer from ${PAGE_LIMIT.min} to ${PAGE_LIMIT.max}`);
  return n;
}

/** Opaque cursor: base64url of [occurredAt, id] of the last event of the previous page. */
export function encodeCursor(e) {
  return Buffer.from(JSON.stringify([e.occurredAt, e.id])).toString("base64url");
}

export function decodeCursor(v) {
  const s = one(v, "cursor");
  if (s === undefined) return undefined;
  try {
    if (s.length > 300) throw new Error("too long");
    const [occurredAt, id] = JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
    if (typeof occurredAt !== "string" || typeof id !== "string" || !Number.isFinite(Date.parse(occurredAt))) throw new Error("shape");
    return { occurredAt, id };
  } catch {
    throw new BadRequest("cursor is not valid; use meta.nextCursor of the previous page");
  }
}

/** req.query -> validated filters. Throws BadRequest with a message meant for the caller. */
export function parseListQuery(query) {
  const unknown = Object.keys(query).filter((k) => !LIST_PARAMS.includes(k));
  if (unknown.length) throw new BadRequest(`unknown parameter ${unknown.join(", ")} (allowed: ${LIST_PARAMS.join(", ")})`);
  const minSeverity = list(query.minSeverity, "minSeverity", ["low", "medium", "high"]);
  if (minSeverity && minSeverity.length > 1) throw new BadRequest("minSeverity takes one value");
  const country = one(query.country, "country");
  if (country !== undefined && (country.length === 0 || country.length > 60)) throw new BadRequest("country must be 1 to 60 characters");
  const filters = {
    types: list(query.type, "type", TYPES),
    severities: list(query.severity, "severity", SEVERITIES),
    minSeverity: minSeverity?.[0],
    from: isoDate(query.from, "from"),
    to: isoDate(query.to, "to"),
    bbox: bbox(query.bbox),
    country: country?.toLowerCase(),
    limit: limit(query.limit),
    cursor: decodeCursor(query.cursor),
  };
  if (filters.from !== undefined && filters.to !== undefined && filters.from > filters.to) throw new BadRequest("from must not be after to");
  return filters;
}

function inBox(e, b) {
  if (e.lat < b.minLat || e.lat > b.maxLat) return false;
  return b.minLng <= b.maxLng ? e.lng >= b.minLng && e.lng <= b.maxLng : e.lng >= b.minLng || e.lng <= b.maxLng;
}

export function matches(e, f) {
  if (f.types && !f.types.includes(e.type)) return false;
  if (f.severities && !f.severities.includes(e.severity)) return false;
  if (f.minSeverity && !(RANK[e.severity] >= RANK[f.minSeverity])) return false; // unrated never passes a minimum
  const t = Date.parse(e.occurredAt);
  if (f.from !== undefined && t < f.from) return false;
  if (f.to !== undefined && t > f.to) return false;
  if (f.bbox && !inBox(e, f.bbox)) return false;
  if (f.country && (e.country ?? "").toLowerCase() !== f.country) return false;
  return true;
}

/** Sorted events + filters -> { page, total, nextCursor }. */
export function selectPage(events, f) {
  const all = events.filter((e) => matches(e, f));
  const after = f.cursor ? all.filter((e) => compareEvents(e, f.cursor) > 0) : all;
  const page = after.slice(0, f.limit);
  const nextCursor = after.length > f.limit ? encodeCursor(page[page.length - 1]) : null;
  return { page, total: all.length, nextCursor };
}
