/**
 * Public disaster feed (NASA EONET + USGS) with a short in-memory cache.
 *
 *  - each source is cached on its own for FEED_CACHE_MS; a request served
 *    inside that window never calls NASA or USGS (callers cannot shorten
 *    or bypass the cache: there is no query parameter for it);
 *  - the two sources are fetched independently (Promise.allSettled): when
 *    one fails the other's items are served with `partial: true` and the
 *    per-source status in `sources`; a failed source is retried at most
 *    once per SOURCE_RETRY_MS;
 *  - when both fail, the previous data is served with `stale: true`; with
 *    nothing cached at all the feed is unavailable (503) — there is no
 *    seeded or demo item anywhere in this path;
 *  - an empty live result is an empty feed, never padded with invented items.
 *
 * Fetchers and the clock are injectable for tests.
 */
import { fetchNasaEvents } from "./nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";
import { fetchUsgsEarthquakes, normalizeUsgsEarthquakes } from "./usgs.service.js";

/** Server-side cache lifetime per source; not configurable by callers. */
export const FEED_CACHE_MS = 5 * 60 * 1000;
/** A source that just failed is not retried before this much time has passed. */
export const SOURCE_RETRY_MS = 60 * 1000;

/** Accepted ranges for the public query parameters (values outside are clamped). */
export const FEED_PARAM_LIMITS = {
  limit: { min: 1, max: 200, fallback: 50 },
  minutes: { min: 60, max: 30 * 24 * 60, fallback: 7 * 24 * 60 },
  minMag: { min: 0, max: 10, fallback: 4.5 },
};

export class FeedUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "FeedUnavailableError";
  }
}

function sanitizeText(s) {
  if (!s) return s;
  // Clean up characters that render incorrectly in PowerShell
  return String(s).replace(/•/g, " - ").replace(/\s+/g, " ").trim();
}

export function createFeedService({
  fetchNasa = fetchNasaEvents,
  fetchUsgs = fetchUsgsEarthquakes,
  now = Date.now,
  log = console,
  cacheMs = FEED_CACHE_MS,
  retryMs = SOURCE_RETRY_MS,
} = {}) {
  // Raw source payloads, cached per source: { data, updatedAt, failedAt, lastError }
  const sources = {
    nasa: { fetch: fetchNasa, data: null, updatedAt: 0, failedAt: 0, lastError: null },
    usgs: { fetch: fetchUsgs, data: null, updatedAt: 0, failedAt: 0, lastError: null },
  };

  const isFresh = (s, t) => s.data !== null && t - s.updatedAt < cacheMs;
  const inRetryBackoff = (s, t) => s.failedAt !== 0 && t - s.failedAt < retryMs;

  /**
   * Brings a source up to date. Returns one of
   *   "cache" (fresh data already held), "live" (fetched now),
   *   "error" (fetch failed now), "backoff" (failed recently, not retried).
   */
  async function refresh(name, t) {
    const s = sources[name];
    if (isFresh(s, t)) return "cache";
    if (inRetryBackoff(s, t)) return "backoff";
    const [outcome] = await Promise.allSettled([s.fetch()]);
    if (outcome.status === "fulfilled") {
      s.data = Array.isArray(outcome.value) ? outcome.value : [];
      s.updatedAt = t;
      s.failedAt = 0;
      s.lastError = null;
      return "live";
    }
    s.failedAt = t;
    s.lastError = outcome.reason?.message || String(outcome.reason);
    log.error(`[feed] ${name} fetch failed: ${s.lastError}`);
    return "error";
  }

  /** Normalises the cached raw payloads into feed items for the requested window/limit. */
  function buildItems({ nasa, usgs }, { minutesWindow, limit, minMag }) {
    const both = nasa !== null && usgs !== null;
    const perSource = both ? Math.ceil(limit * 0.6) : limit; // up to 60 % of the limit per source when both answer
    const inWindow = (e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow;

    const nasaItems = nasa ? normalizeNasaEvents(nasa).filter(inWindow).slice(0, perSource) : [];
    const quakes = usgs ? normalizeUsgsEarthquakes(usgs, { minMag, limit: perSource }).filter(inWindow) : [];

    return [...nasaItems, ...quakes].slice(0, limit).map((e) => ({
      ...e,
      meta: sanitizeText(e.meta),
      description: sanitizeText(e.description),
      location: sanitizeText(e.location),
      title: sanitizeText(e.title),
    }));
  }

  /**
   * -> { items, count, source, stale, partial, sources, updatedAt, params }
   *   source:  "CACHE" | "NASA + USGS" | "NASA" | "USGS" | "CACHE-FALLBACK"
   *   partial: true when only one source contributed items
   *   sources: { nasa: "ok" | "error", usgs: "ok" | "error" }
   *   stale:   true when both sources failed and older data is served
   * Throws FeedUnavailableError when both sources fail and nothing is cached.
   */
  async function getFeed({
    minutesWindow = FEED_PARAM_LIMITS.minutes.fallback,
    limit = FEED_PARAM_LIMITS.limit.fallback,
    minMag = FEED_PARAM_LIMITS.minMag.fallback,
  } = {}) {
    const params = { minutesWindow, limit, minMag };
    const t = now();
    const [nasaState, usgsState] = await Promise.all([refresh("nasa", t), refresh("usgs", t)]);
    const ok = { nasa: nasaState === "cache" || nasaState === "live", usgs: usgsState === "cache" || usgsState === "live" };
    const status = { nasa: ok.nasa ? "ok" : "error", usgs: ok.usgs ? "ok" : "error" };
    const liveNow = nasaState === "live" || usgsState === "live";

    if (ok.nasa || ok.usgs) {
      const used = { nasa: ok.nasa ? sources.nasa.data : null, usgs: ok.usgs ? sources.usgs.data : null };
      const items = buildItems(used, params);
      const partial = !(ok.nasa && ok.usgs);
      const updatedAt = Math.max(ok.nasa ? sources.nasa.updatedAt : 0, ok.usgs ? sources.usgs.updatedAt : 0);
      const label = ok.nasa && ok.usgs ? "NASA + USGS" : ok.nasa ? "NASA" : "USGS";
      if (partial) log.warn(`[feed] partial feed: ${ok.nasa ? "USGS" : "NASA"} unavailable (${sources[ok.nasa ? "usgs" : "nasa"].lastError})`);
      return {
        items,
        count: items.length,
        source: liveNow ? label : "CACHE",
        stale: false,
        partial,
        sources: status,
        updatedAt: new Date(updatedAt).toISOString(),
        params,
      };
    }

    // both sources are down: serve whatever older data exists, flagged stale
    const reasons = `NASA: ${sources.nasa.lastError}; USGS: ${sources.usgs.lastError}`;
    if (sources.nasa.data !== null || sources.usgs.data !== null) {
      log.error(`[feed] both sources failed, serving the previous feed as stale (${reasons})`);
      const items = buildItems({ nasa: sources.nasa.data, usgs: sources.usgs.data }, params);
      const updatedAt = Math.max(sources.nasa.updatedAt, sources.usgs.updatedAt);
      return {
        items,
        count: items.length,
        source: "CACHE-FALLBACK",
        stale: true,
        partial: sources.nasa.data === null || sources.usgs.data === null,
        sources: status,
        updatedAt: new Date(updatedAt).toISOString(),
        params,
      };
    }
    log.error(`[feed] both sources failed and nothing is cached (${reasons})`);
    throw new FeedUnavailableError(`Disaster feed unavailable: ${reasons}`);
  }

  function status() {
    const entry = (s) => ({ cached: s.data !== null, updatedAt: s.updatedAt ? new Date(s.updatedAt).toISOString() : null, lastError: s.lastError });
    return { nasa: entry(sources.nasa), usgs: entry(sources.usgs) };
  }

  /** Forgets every cached payload (tests only). */
  function reset() {
    for (const s of Object.values(sources)) {
      s.data = null;
      s.updatedAt = 0;
      s.failedAt = 0;
      s.lastError = null;
    }
  }

  return { getFeed, status, reset };
}

/** Process-wide instance used by the route. */
export const feedService = createFeedService();
