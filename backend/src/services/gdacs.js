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
 *  - is injectable (fetch, clock, timeouts) for tests.
 */

const GDACS_API = "https://www.gdacs.org/gdacsapi/api/events/geteventdata";
const REPORT_URL = /gdacs\.org\/report\.aspx\?(?:[^#]*&)?eventtype=([A-Z]{2})(?:&[^#]*)?&eventid=(\d+)/i;
const REPORT_URL_SWAPPED = /gdacs\.org\/report\.aspx\?(?:[^#]*&)?eventid=(\d+)(?:&[^#]*)?&eventtype=([A-Z]{2})/i;

export const DEFAULT_GDACS_TIMEOUT_MS = 4000;
export const GDACS_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // a level moves slowly: hours
export const GDACS_FAILURE_TTL_MS = 10 * 60 * 1000; // do not hammer GDACS while it is down
export const GDACS_CONCURRENCY = 8;

/** GDACS alert level -> our severity. */
export const GDACS_LEVEL_SEVERITY = { green: "low", orange: "medium", red: "high" };

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
  const cache = new Map(); // key -> { value|null, expiresAt }
  const inflight = new Map(); // key -> Promise
  const stats = { requests: 0, hits: 0, failures: 0, lastError: null, lastFetchAt: null };

  async function request(ref) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${GDACS_API}?eventtype=${encodeURIComponent(ref.eventtype)}&eventid=${encodeURIComponent(ref.eventid)}`;
      const res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`GDACS ${res.status}`);
      return parseGdacsLevel(await res.json());
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
        const value = await request(ref);
        cache.set(key, { value, expiresAt: now() + ttlMs });
        return value;
      } catch (err) {
        stats.failures++;
        stats.lastError = err?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : err?.message || String(err);
        // serve the previous level while GDACS is down, otherwise remember the failure briefly
        if (hit) {
          cache.set(key, { value: hit.value, expiresAt: now() + failureTtlMs });
          return hit.value;
        }
        cache.set(key, { value: null, expiresAt: now() + failureTtlMs });
        return null;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, p);
    return p;
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
   * Attaches `event.gdacs = { level, score, text } | null` to every EONET
   * event that links to GDACS (others are left untouched). Returns the same
   * array. Never throws and never blocks longer than one timeout per batch.
   */
  async function enrich(events) {
    const list = Array.isArray(events) ? events : [];
    if (disabled) return list;
    const refs = list.map((e) => parseGdacsRef(e));
    const before = stats.failures;
    const levels = await getLevels(refs);
    list.forEach((e, i) => {
      if (refs[i]) e.gdacs = levels.get(gdacsKey(refs[i])) ?? null;
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

  return { getLevel, getLevels, enrich, status, reset };
}

/** Process-wide client shared by the feed, the ingestion job and the news job. */
export const gdacsClient = createGdacsClient();
