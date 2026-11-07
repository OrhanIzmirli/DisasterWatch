/**
 * Impact figures GDACS publishes for one event, fetched on demand for the event
 * drawer (GET /disasters/impact). Not part of the feed: the population needs a
 * second GDACS request per event, which the feed's lookups must not pay for.
 *
 * - populationAffected: GDACS's estimate of people in the affected area
 *   (`POPAFFECTED` of the impact model linked from the event, wildfires today);
 *   null when GDACS links no such model.
 * - reported: impacts GDACS lists under the Sendai framework for the event
 *   (floods: people rescued, houses damaged, ...), latest entries only, as GDACS
 *   words them; an empty list when none are reported.
 *
 * Only gdacs.org is ever requested: the event reference is validated and the
 * linked impact URL must point at the GDACS export API. Answers are cached for
 * 6 hours, failures for 10 minutes (GDACS is often slow).
 */
import { DEFAULT_GDACS_TIMEOUT_MS, GDACS_CACHE_TTL_MS, GDACS_FAILURE_TTL_MS } from "./gdacs.js";

const EVENT_API = "https://www.gdacs.org/gdacsapi/api/events/geteventdata";
const IMPACT_HOST = "www.gdacs.org";
const IMPACT_PATH = "/gdacsapi/api/export/getimpact";

/** GDACS event types DisasterWatch links to (wildfires, floods, cyclones). */
export const IMPACT_EVENT_TYPES = ["WF", "FL", "TC"];

/** "WF", "1033539" -> a validated reference, or null. */
export function parseImpactRef(eventtype, eventid) {
  const type = String(eventtype ?? "").trim().toUpperCase();
  const id = String(eventid ?? "").trim();
  if (!IMPACT_EVENT_TYPES.includes(type) || !/^\d{1,10}$/.test(id)) return null;
  return { eventtype: type, eventid: id };
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Latest Sendai entries of a geteventdata payload, as GDACS words them. */
export function parseReportedImpacts(payload) {
  const list = Array.isArray(payload?.properties?.sendai) ? payload.properties.sendai : [];
  return list
    .filter((x) => x && x.latest !== false)
    .map((x) => ({
      kind: String(x.sendainame ?? "").trim(),
      value: numOrNull(x.sendaivalue),
      region: x.region ? String(x.region) : null,
      country: x.country ? String(x.country) : null,
    }))
    .filter((x) => x.kind && x.value !== null);
}

/** The linked impact model URL, only when it points at the GDACS export API. */
export function impactModelUrl(payload) {
  for (const item of Array.isArray(payload?.properties?.impacts) ? payload.properties.impacts : []) {
    const raw = item?.resource?.impact;
    if (typeof raw !== "string") continue;
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && u.hostname === IMPACT_HOST && u.pathname === IMPACT_PATH && /^\d+$/.test(u.searchParams.get("id") ?? "")) {
        return `https://${IMPACT_HOST}${IMPACT_PATH}?id=${u.searchParams.get("id")}`;
      }
    } catch {
      /* not a URL */
    }
  }
  return null;
}

/** POPAFFECTED from an impact model payload; null when absent. */
export function parsePopulationAffected(model) {
  for (const group of Array.isArray(model?.datums) ? model.datums : []) {
    if (group?.alias !== "POP" && group?.source !== "Population") continue;
    for (const datum of Array.isArray(group.datum) ? group.datum : []) {
      for (const s of Array.isArray(datum?.scalars?.scalar) ? datum.scalars.scalar : []) {
        if (s?.name === "POPAFFECTED") return numOrNull(s.value);
      }
    }
  }
  return null;
}

export function createGdacsImpactClient({
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = Number(process.env.GDACS_TIMEOUT_MS) || DEFAULT_GDACS_TIMEOUT_MS,
  ttlMs = GDACS_CACHE_TTL_MS,
  failureTtlMs = GDACS_FAILURE_TTL_MS,
  now = () => Date.now(),
  disabled = process.env.DISABLE_GDACS === "1",
} = {}) {
  const cache = new Map(); // key -> { value, expiresAt }
  const inflight = new Map();

  async function getJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw Object.assign(new Error(`GDACS ${res.status}`), { status: res.status });
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * -> { populationAffected, reported, fetchedAt } or null when GDACS cannot be reached
   * (or is disabled). Never throws.
   */
  async function getImpact(ref) {
    if (!ref || disabled) return null;
    const key = `${ref.eventtype}:${ref.eventid}`;
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > t) return hit.value;
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      try {
        const payload = await getJson(`${EVENT_API}?eventtype=${ref.eventtype}&eventid=${ref.eventid}`);
        const modelUrl = impactModelUrl(payload);
        let populationAffected = null;
        if (modelUrl) {
          try {
            populationAffected = parsePopulationAffected(await getJson(modelUrl));
          } catch {
            populationAffected = null; // the event answered; only the model failed: population unknown
          }
        }
        const value = { populationAffected, reported: parseReportedImpacts(payload), fetchedAt: new Date(now()).toISOString() };
        cache.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      } catch {
        cache.set(key, { value: null, expiresAt: now() + failureTtlMs });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  return { getImpact, reset: () => cache.clear() };
}

export const gdacsImpactClient = createGdacsImpactClient();
