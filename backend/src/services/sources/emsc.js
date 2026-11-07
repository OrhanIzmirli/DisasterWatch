/**
 * EMSC earthquakes (SeismicPortal FDSN event service), used only to confirm
 * USGS earthquakes; an event EMSC lists and USGS does not is never shown.
 *
 * Licence: CC BY 4.0 for downloaded data, credit "EMSC-CSEM SeismicPortal"
 * (https://www.seismicportal.eu/terms.html, read 2026-11-07). No key; no
 * published rate limit, so one small request every EMSC_TTL_MS at most.
 *
 * Fetching: the 30-day window (about 1,700 events of M4.0+, ~0.9 MB) once, then
 * only what changed since the last fetch (updatedafter, a few events), merged
 * by EMSC's unique id; a full fetch again every EMSC_FULL_REFRESH_MS. M4.0, not
 * 4.5: agencies' magnitudes differ, and a USGS M4.5 can be an EMSC M4.1.
 *
 * `agency` (EMSC's "auth") says who computed the solution. "NEIC" is the USGS
 * itself: such an EMSC entry is the USGS solution relayed, not an independent
 * confirmation (the confidence score counts it as "listed" only).
 */
import { fetchJson } from "./sourceCache.js";

export const EMSC_QUERY_URL = "https://www.seismicportal.eu/fdsnws/event/1/query";
export const EMSC_TTL_MS = 5 * 60 * 1000;
export const EMSC_FULL_REFRESH_MS = 6 * 60 * 60 * 1000;
export const EMSC_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const EMSC_MIN_MAG = 4.0;
/** updatedafter starts this much before the last fetch, so nothing updated in between is missed. */
const OVERLAP_MS = 2 * 60 * 1000;
/** EMSC event types kept: known and suspected earthquakes (no blasts, no rockbursts). */
const EARTHQUAKE_TYPES = new Set(["ke", "se"]);
/** Agency codes that are the USGS itself. */
export const USGS_AGENCIES = new Set(["NEIC", "USGS", "US"]);

const isoNoMs = (ms) => new Date(ms).toISOString().slice(0, 19);

export function buildEmscUrl({ start, updatedAfter, minMag = EMSC_MIN_MAG, limit = 5000 }) {
  const params = new URLSearchParams({ format: "json", minmag: String(minMag), limit: String(limit), orderby: "time" });
  if (start !== undefined) params.set("starttime", isoNoMs(start));
  if (updatedAfter !== undefined) params.set("updatedafter", isoNoMs(updatedAfter));
  return `${EMSC_QUERY_URL}?${params}`;
}

/** One FDSN GeoJSON feature -> observation, or null when it is not a usable earthquake. */
export function normalizeEmscFeature(f) {
  const p = f?.properties ?? {};
  const unid = typeof p.unid === "string" && p.unid ? p.unid : typeof f?.id === "string" ? f.id : null;
  const time = Date.parse(p.time);
  const lat = Number(p.lat);
  const lng = Number(p.lon);
  const magnitude = Number(p.mag);
  if (!unid || !Number.isFinite(time) || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(magnitude)) return null;
  if (p.evtype && !EARTHQUAKE_TYPES.has(String(p.evtype).toLowerCase())) return null;
  const agency = p.auth ? String(p.auth).toUpperCase() : null;
  return {
    source: "emsc",
    sourceId: unid,
    type: "earthquake",
    time,
    updatedAt: Date.parse(p.lastupdate) || time,
    lat,
    lng,
    depthKm: Number.isFinite(Number(p.depth)) ? Number(p.depth) : null,
    magnitude,
    magnitudeType: p.magtype ? String(p.magtype) : null,
    agency,
    relaysUsgs: agency !== null && USGS_AGENCIES.has(agency),
    region: p.flynn_region ? String(p.flynn_region) : null,
    url: `https://www.seismicportal.eu/eventdetails.html?unid=${encodeURIComponent(unid)}`,
  };
}

export function normalizeEmsc(payload) {
  return (Array.isArray(payload?.features) ? payload.features : []).map(normalizeEmscFeature).filter(Boolean);
}

/** Merges updated observations into the previous ones (by id), dropping those outside the window; newest first. */
export function mergeEmsc(previous, updates, now) {
  const byId = new Map(previous.map((o) => [o.sourceId, o]));
  for (const o of updates) byId.set(o.sourceId, o);
  return [...byId.values()].filter((o) => o.time >= now - EMSC_WINDOW_MS).sort((a, b) => b.time - a.time || (a.sourceId < b.sourceId ? -1 : 1));
}

/**
 * Fetcher for createSourceCache: full window on the first call and every
 * EMSC_FULL_REFRESH_MS, otherwise only the updates since the previous fetch.
 */
export function createEmscFetcher({ fetchImpl, now = () => Date.now(), timeoutMs = 15_000 } = {}) {
  let lastFullAt = 0;
  return async function fetchEmsc(prev) {
    const t = now();
    const full = prev === null || t - lastFullAt >= EMSC_FULL_REFRESH_MS;
    const url = full ? buildEmscUrl({ start: t - EMSC_WINDOW_MS }) : buildEmscUrl({ updatedAfter: prev.fetchedAt - OVERLAP_MS });
    const payload = await fetchJson(url, { timeoutMs, fetchImpl, label: "EMSC" });
    const observations = normalizeEmsc(payload);
    if (full) {
      lastFullAt = t;
      return mergeEmsc([], observations, t);
    }
    return mergeEmsc(prev.data, observations, t);
  };
}
