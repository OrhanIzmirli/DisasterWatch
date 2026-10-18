/**
 * GDACS impact levels for EONET events.
 *
 * EONET carries no alert level, but every GDACS-sourced event (wildfires
 * outside the US, floods) links to its GDACS report:
 *   https://www.gdacs.org/report.aspx?eventtype=WF&eventid=1032806
 * GDACS's public API answers for that key with the impact level the source
 * itself assigned (Green / Orange / Red, population- and capacity-based):
 *   https://www.gdacs.org/gdacsapi/api/events/geteventdata?eventtype=WF&eventid=1032806
 *
 * This client:
 *  - caches each level per (eventtype, eventid) for hours (levels change
 *    slowly); a failed lookup is remembered for a short while so a GDACS
 *    outage does not trigger a request per event per refresh;
 *  - fetches in parallel with a bounded concurrency and a short timeout, and
 *    never throws: an unreachable GDACS yields `null` and the severity rules
 *    fall back to the EONET measurement;
 *  - also keeps where GDACS places the event (affected countries as ISO
 *    3166-1 alpha-2 codes, and its point), read from the same answer, for
 *    the news panel's region filter (getPlace);
 *  - lists the tropical cyclones of a date range (listTropicalCyclones),
 *    a second source for the news job's list of current storms;
 *  - is injectable (fetch, clock, timeouts) for tests.
 */

const GDACS_API = "https://www.gdacs.org/gdacsapi/api/events/geteventdata";
const GDACS_EVENT_LIST = "https://www.gdacs.org/gdacsapi/api/events/geteventlist/SEARCH";
/** The event list is a larger answer than one event's data: a longer timeout than DEFAULT_GDACS_TIMEOUT_MS. */
export const GDACS_LIST_TIMEOUT_MS = 15000;
const REPORT_URL = /gdacs\.org\/report\.aspx\?(?:[^#]*&)?eventtype=([A-Z]{2})(?:&[^#]*)?&eventid=(\d+)/i;
const REPORT_URL_SWAPPED = /gdacs\.org\/report\.aspx\?(?:[^#]*&)?eventid=(\d+)(?:&[^#]*)?&eventtype=([A-Z]{2})/i;

export const DEFAULT_GDACS_TIMEOUT_MS = 4000;
export const GDACS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // a level moves slowly: hours
export const GDACS_FAILURE_TTL_MS = 10 * 60 * 1000; // do not hammer GDACS while it is down
export const GDACS_CONCURRENCY = 8;

/** GDACS alert level -> our severity. */
export const GDACS_LEVEL_SEVERITY = { green: "low", orange: "medium", red: "high" };

/**
 * GDACS event list (GeoJSON) -> [{ name, current, endedAt }] for its tropical
 * cyclones. GDACS names them "TRUDY-26" (name plus 2-digit year); the year is
 * dropped ("trudy", "choi-wan"). Throws on a payload without a feature list.
 */
export function parseTropicalCyclones(payload) {
  if (!Array.isArray(payload?.features)) throw new Error("GDACS event list without features");
  const out = [];
  for (const f of payload.features) {
    const p = f?.properties ?? {};
    if (p.eventtype && p.eventtype !== "TC") continue;
    const raw = String(p.eventname || p.name || "").replace(/^tropical cyclone\s+/i, "").trim();
    const name = raw.replace(/-\d{2}$/, "").toLowerCase();
    if (!name) continue;
    const ended = p.todate ? new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(p.todate) ? p.todate : `${p.todate}Z`) : null;
    out.push({ name, current: p.iscurrent === true || p.iscurrent === "true", endedAt: ended && !Number.isNaN(ended.getTime()) ? ended.toISOString() : null });
  }
  return out;
}

/** { eventtype, eventid } from an EONET event's GDACS source link, or null. */
export function parseGdacsRef(event) {
  for (const s of Array.isArray(event?.sources) ? event.sources : []) {
    const url = String(s?.url ?? "");
    let m = url.match(REPORT_URL);
    if (m) return { eventtype: m[1].toUpperCase(), eventid: m[2] };
    m = url.match(REPORT_URL_SWAPPED);
    if (m) return { eventtype: m[2].toUpperCase(), eventid: m[1] };
  }
  return null;
}

export const gdacsKey = (ref) => `${ref.eventtype}:${ref.eventid}`;

/** Normalises the API payload to { level, score, text } or null when it carries no level. */
export function parseGdacsLevel(payload) {
  const p = payload?.properties ?? payload ?? {};
  const level = String(p.alertlevel ?? "").trim().toLowerCase();
  if (!(level in GDACS_LEVEL_SEVERITY)) return null;
  const score = Number(p.alertscore);
  return {
    level,
    score: Number.isFinite(score) ? score : null,
    text: p.severitydata?.severitytext ? String(p.severitydata.severitytext) : null,
  };
}

/** Normalises the API payload to { countries: ["LY"], lat, lng } (where GDACS places the event); countries may be empty. */
export function parseGdacsPlace(payload) {
  const p = payload?.properties ?? payload ?? {};
  const countries = [];
  for (const c of Array.isArray(p.affectedcountries) ? p.affectedcountries : []) {
    const code = String(c?.iso2 ?? "").trim().toUpperCase();
    if (/^[A-Z]{2}$/.test(code) && !countries.includes(code)) countries.push(code);
  }
  const coords = payload?.geometry?.type === "Point" && Array.isArray(payload.geometry.coordinates) ? payload.geometry.coordinates : null;
  const lng = Number(coords?.[0]);
  const lat = Number(coords?.[1]);
  const located = coords && Number.isFinite(lat) && Number.isFinite(lng);
  return { countries, lat: located ? lat : null, lng: located ? lng : null };
}

export function createGdacsClient({
  fetchImpl = (...args) => fetch(...args),
  timeoutMs = Number(process.env.GDACS_TIMEOUT_MS) || DEFAULT_GDACS_TIMEOUT_MS,
  ttlMs = GDACS_CACHE_TTL_MS,
  failureTtlMs = GDACS_FAILURE_TTL_MS,
  concurrency = GDACS_CONCURRENCY,
  now = () => Date.now(),
  log = console,
  disabled = process.env.DISABLE_GDACS === "1",
} = {}) {
  const cache = new Map(); // key -> { value|null, place|null, unreachable?, expiresAt }
  const inflight = new Map(); // key -> Promise
  const stats = { requests: 0, hits: 0, failures: 0, lastError: null, lastFetchAt: null };

  async function request(ref) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${GDACS_API}?eventtype=${encodeURIComponent(ref.eventtype)}&eventid=${encodeURIComponent(ref.eventid)}`;
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw Object.assign(new Error(`GDACS ${res.status}`), { status: res.status });
      const payload = await res.json();
      return { value: parseGdacsLevel(payload), place: parseGdacsPlace(payload) };
    } finally {
      clearTimeout(timer);
    }
  }

  /** Level for one event; null when unknown, unreachable or disabled. Never throws. */
  async function getLevel(ref) {
    if (!ref || disabled) return null;
    const key = gdacsKey(ref);
    const t = now();
    const hit = cache.get(key);
    if (hit && hit.expiresAt > t) {
      stats.hits++;
      return hit.value;
    }
    if (inflight.has(key)) return inflight.get(key);
    const p = (async () => {
      stats.requests++;
      stats.lastFetchAt = t;
      try {
        const { value, place } = await request(ref);
        cache.set(key, { value, place, expiresAt: now() + ttlMs });
        return value;
      } catch (err) {
        stats.failures++;
        stats.lastError = err?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : err?.message || String(err);
        // serve the previous answer while GDACS is down, otherwise remember the failure briefly
        if (hit && !hit.unreachable) {
          cache.set(key, { value: hit.value, place: hit.place ?? null, expiresAt: now() + failureTtlMs });
          return hit.value;
        }
        // `unreachable`: nothing known about this event because GDACS could not be asked (not "GDACS has no point");
        // a 4xx is an answer (GDACS does not know the event), and a repeated failure keeps the mark
        const answered = err?.status >= 400 && err?.status < 500;
        cache.set(key, { value: null, place: null, unreachable: !answered, expiresAt: now() + failureTtlMs });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
  }

  /** Where GDACS places one event ({ countries, lat, lng }), from the same cached answer as its level; null when unknown. Never throws. */
  async function getPlace(ref) {
    if (!ref || disabled) return null;
    await getLevel(ref);
    return cache.get(gdacsKey(ref))?.place ?? null;
  }

  /** Levels for many refs, `concurrency` at a time. Returns a Map key -> level|null. */
  async function getLevels(refs) {
    const out = new Map();
    const queue = [...new Map(refs.filter(Boolean).map((r) => [gdacsKey(r), r])).values()];
    const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length) {
        const ref = queue.shift();
        out.set(gdacsKey(ref), await getLevel(ref));
      }
    });
    await Promise.all(workers);
    return out;
  }

  /**
   * Attaches `event.gdacs = { level, score, text } | null` and
   * `event.gdacsPlace = { countries, lat, lng } | null` (where GDACS places
   * the event, from the same cached answer) to every EONET event that links
   * to GDACS (others are left untouched), and `event.gdacsUnreachable = true`
   * when GDACS could not be reached for it and nothing was cached. Returns the same array. Never
   * throws and never blocks longer than one timeout per batch.
   */
  async function enrich(events) {
    const list = Array.isArray(events) ? events : [];
    if (disabled) return list;
    const refs = list.map((e) => parseGdacsRef(e));
    const before = stats.failures;
    const levels = await getLevels(refs);
    list.forEach((e, i) => {
      if (!refs[i]) return;
      e.gdacs = levels.get(gdacsKey(refs[i])) ?? null;
      const entry = cache.get(gdacsKey(refs[i]));
      e.gdacsPlace = entry?.place ?? null;
      if (entry?.unreachable) e.gdacsUnreachable = true;
      else delete e.gdacsUnreachable;
    });
    if (stats.failures > before) log.warn(`[gdacs] ${stats.failures - before} lookup(s) failed (${stats.lastError}); those events use the EONET measurement`);
    return list;
  }

  function status() {
    return { disabled, cached: cache.size, ...stats };
  }

  function reset() {
    cache.clear();
    inflight.clear();
    Object.assign(stats, { requests: 0, hits: 0, failures: 0, lastError: null, lastFetchAt: null });
  }

  /**
   * Tropical cyclones GDACS lists between `from` and `to` (Dates), every
   * alert level: [{ name, current, endedAt }]. Throws when GDACS is
   * disabled, unreachable or answers something else (the caller decides).
   */
  async function listTropicalCyclones({ from, to }) {
    if (disabled) throw new Error("GDACS disabled");
    const day = (d) => d.toISOString().slice(0, 10);
    const url = `${GDACS_EVENT_LIST}?eventlist=TC&fromDate=${day(from)}&toDate=${day(to)}&alertlevel=green;orange;red`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(timeoutMs, GDACS_LIST_TIMEOUT_MS));
    try {
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      // GDACS answers 204 (no body) when nothing matches
      if (res.status === 204) return [];
      if (!res.ok) throw new Error(`GDACS event list ${res.status}`);
      return parseTropicalCyclones(await res.json());
    } finally {
      clearTimeout(timer);
    }
  }

  return { getLevel, getLevels, getPlace, enrich, listTropicalCyclones, status, reset };
}

/** Process-wide client shared by the feed, the ingestion job and the news job. */
export const gdacsClient = createGdacsClient();
