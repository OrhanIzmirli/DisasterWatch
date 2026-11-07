/**
 * NASA FIRMS active-fire detections (VIIRS NOAA-20, near real time), used to
 * confirm EONET wildfires: satellite fire pixels near the event's position in
 * the last 48 hours.
 *
 * Licence: NASA supports full and open sharing; whoever passes FIRMS data to a
 * third party is asked to acknowledge FIRMS, LANCE and ESDIS
 * (https://www.earthdata.nasa.gov/data/tools/firms, read 2026-11-07).
 * DisasterWatch passes on only counts and times, never the detections.
 *
 * Key: a free MAP_KEY (FIRMS_MAP_KEY); without one the lookup is "off" and
 * wildfires are scored from the other sources. Limit: 5,000 transactions per
 * 10 minutes (https://firms.modaps.eosdis.nasa.gov/api/map_key/). One small
 * area request per wildfire, at most once per FIRMS_TTL_MS (NRT data arrives
 * up to 3 h late, so asking more often adds nothing): about 100-200 requests an
 * hour at most, a few per cent of the limit.
 *
 * The lookup never blocks a feed request: peek() answers from the cache and
 * refresh() fetches what is missing or old in the background, a few at a time.
 * The key is part of the URL, so no URL and no response text is ever logged.
 */
import { createBackoffGate, BackoffError } from "../backoff.js";

export const FIRMS_AREA_URL = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
export const FIRMS_SOURCE = "VIIRS_NOAA20_NRT";
/** FIRMS accepts 1..5; two days cover the 48 h looked at. */
export const FIRMS_DAY_RANGE = 2;
export const FIRMS_TTL_MS = 60 * 60 * 1000;
/** A cached answer is still used this long when FIRMS cannot be reached. */
export const FIRMS_STALE_MAX_MS = 6 * 60 * 60 * 1000;
export const FIRMS_RADIUS_KM = 10;
export const FIRMS_MAX_AGE_MS = 48 * 60 * 60 * 1000;
const KM_PER_DEG = 111.32;

export const FIRMS_ACKNOWLEDGEMENT =
  "We acknowledge the use of data from NASA's Fire Information for Resource Management System (FIRMS) (https://earthdata.nasa.gov/firms), part of NASA's Land, Atmosphere Near real-time Capability for Earth observations (LANCE) (https://earthdata.nasa.gov/lance) and NASA's Earth Science Data and Information System (ESDIS).";

const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/** Great-circle distance in km. */
export function distanceKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** [west, south, east, north] around a point; clamped at the poles and the antimeridian (a fire there loses part of its box). */
export function bboxAround(lat, lng, km = FIRMS_RADIUS_KM) {
  const dLat = km / KM_PER_DEG;
  const dLng = km / (KM_PER_DEG * Math.max(0.05, Math.cos((lat * Math.PI) / 180)));
  return [round(clamp(lng - dLng, -180, 180)), round(clamp(lat - dLat, -90, 90)), round(clamp(lng + dLng, -180, 180)), round(clamp(lat + dLat, -90, 90))];
}

export function buildFirmsUrl(mapKey, bbox, { source = FIRMS_SOURCE, dayRange = FIRMS_DAY_RANGE } = {}) {
  return `${FIRMS_AREA_URL}/${encodeURIComponent(mapKey)}/${source}/${bbox.join(",")}/${dayRange}`;
}

/**
 * FIRMS CSV -> [{ lat, lng, time, confidence, frp }]. Throws when the body is
 * not a FIRMS CSV (FIRMS answers an invalid key or an overrun with plain text).
 */
export function parseFirmsCsv(text) {
  const lines = String(text ?? "").trim().split(/\r?\n/);
  const header = lines[0]?.split(",").map((h) => h.trim()) ?? [];
  const col = (name) => header.indexOf(name);
  const [iLat, iLng, iDate, iTime, iConf, iFrp] = ["latitude", "longitude", "acq_date", "acq_time", "confidence", "frp"].map(col);
  if (iLat < 0 || iLng < 0 || iDate < 0 || iTime < 0) throw new Error("FIRMS answered something other than a detection CSV");
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    const lat = Number(c[iLat]);
    const lng = Number(c[iLng]);
    const hhmm = String(c[iTime] ?? "").padStart(4, "0");
    const time = Date.parse(`${c[iDate]}T${hhmm.slice(0, 2)}:${hhmm.slice(2, 4)}:00Z`);
    if (!Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(time)) continue;
    rows.push({ lat, lng, time, confidence: iConf >= 0 ? String(c[iConf] ?? "").trim().toLowerCase() : null, frp: iFrp >= 0 && Number.isFinite(Number(c[iFrp])) ? Number(c[iFrp]) : null });
  }
  return rows;
}

/**
 * Detections within radiusKm of the point and maxAgeMs of now, leaving out
 * low-confidence pixels ("l" for VIIRS, below 30 for MODIS).
 * -> { count, latest (ms | null), maxFrp (MW | null) }
 */
export function summarizeDetections(rows, { lat, lng, now, radiusKm = FIRMS_RADIUS_KM, maxAgeMs = FIRMS_MAX_AGE_MS }) {
  let count = 0;
  let latest = null;
  let maxFrp = null;
  for (const r of rows) {
    if (r.confidence === "l" || (/^\d+$/.test(r.confidence ?? "") && Number(r.confidence) < 30)) continue;
    if (now - r.time > maxAgeMs || r.time - now > 3600_000) continue;
    if (distanceKm(lat, lng, r.lat, r.lng) > radiusKm) continue;
    count++;
    latest = latest === null ? r.time : Math.max(latest, r.time);
    if (r.frp !== null) maxFrp = maxFrp === null ? r.frp : Math.max(maxFrp, r.frp);
  }
  return { count, latest, maxFrp };
}

/** Link to the FIRMS map at the point (for "confirming sources" lists). */
export function firmsMapUrl(lat, lng) {
  return `https://firms.modaps.eosdis.nasa.gov/map/#d:48hrs;@${round(lng, 3)},${round(lat, 3)},11z`;
}

/** Cache key: the event and where it is (an EONET event that moves is looked up again). */
const keyOf = (e) => `${e.id}@${e.lat.toFixed(2)},${e.lng.toFixed(2)}`;

/**
 * @param {object} o
 * @param {string} [o.mapKey] FIRMS MAP_KEY; without it the lookup is off
 */
export function createFirmsLookup({ mapKey, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console, ttlMs = FIRMS_TTL_MS, concurrency = 3, timeoutMs = 20_000, backoff } = {}) {
  const enabled = typeof mapKey === "string" && mapKey.trim() !== "";
  const gate = backoff ?? createBackoffGate({ name: "FIRMS", baseMs: 60_000, maxMs: 30 * 60_000, now });
  const cache = new Map(); // key -> { summary, fetchedAt }
  const inflight = new Set();
  let lastFetchAt = 0;
  let failing = false;
  let running = null;

  async function fetchOne(e) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(buildFirmsUrl(mapKey.trim(), bboxAround(e.lat, e.lng)), { signal: controller.signal });
      if (!res.ok) throw new Error(`FIRMS HTTP ${res.status}`);
      return parseFirmsCsv(await res.text());
    } catch (err) {
      if (err?.name === "AbortError") throw new Error(`FIRMS timed out after ${timeoutMs} ms`);
      throw new Error(String(err?.message || err).replaceAll(mapKey, "<key>"));
    } finally {
      clearTimeout(timer);
    }
  }

  /** eventId -> { count, latest, maxFrp, fetchedAt, url } for the events known; missing ones are absent. */
  function peek(events) {
    const out = new Map();
    if (!enabled) return out;
    const t = now();
    for (const e of events) {
      const hit = cache.get(keyOf(e));
      if (hit && t - hit.fetchedAt <= FIRMS_STALE_MAX_MS) out.set(e.id, { ...hit.summary, fetchedAt: hit.fetchedAt, url: firmsMapUrl(e.lat, e.lng) });
    }
    return out;
  }

  /** Fetches, in the background, the events whose answer is missing or older than the TTL. */
  function refresh(events) {
    if (!enabled) return Promise.resolve();
    const t = now();
    const due = events.filter((e) => Number.isFinite(e?.lat) && Number.isFinite(e?.lng) && !inflight.has(keyOf(e)) && !(t - (cache.get(keyOf(e))?.fetchedAt ?? -Infinity) < ttlMs));
    if (due.length === 0) return running ?? Promise.resolve();
    for (const e of due) inflight.add(keyOf(e));
    const queue = due.slice();
    const worker = async () => {
      while (queue.length) {
        const e = queue.shift();
        try {
          const rows = await gate.run(() => fetchOne(e));
          cache.set(keyOf(e), { summary: summarizeDetections(rows, { lat: e.lat, lng: e.lng, now: now() }), fetchedAt: now() });
          lastFetchAt = now();
          failing = false;
        } catch (err) {
          if (!(err instanceof BackoffError)) {
            failing = true;
            log.warn(`[sources] FIRMS lookup failed: ${err.message}`);
          }
          if (err instanceof BackoffError || failing) queue.length = 0; // stop this round; the gate decides when to try again
        } finally {
          inflight.delete(keyOf(e));
        }
      }
    };
    const batch = Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker)).then(() => {
      for (const e of due) inflight.delete(keyOf(e));
      // forget answers nobody asked about for a day (events that left the feed)
      for (const [k, v] of cache) if (now() - v.fetchedAt > 24 * 3600_000) cache.delete(k);
    });
    running = batch.finally(() => {
      if (running === batch) running = null;
    });
    return batch;
  }

  function status() {
    return { enabled, fetchedAt: lastFetchAt ? new Date(lastFetchAt).toISOString() : null, items: enabled ? cache.size : null, failing };
  }

  function reset() {
    cache.clear();
    inflight.clear();
    lastFetchAt = 0;
    failing = false;
    gate.success();
  }

  return { name: "FIRMS", enabled, peek, refresh, status, reset };
}
