/**
 * Public disaster feed (NASA EONET + USGS) with a short in-memory cache.
 *
 *  - each source is cached on its own for FEED_CACHE_MS; a request served
 *    inside that window never calls NASA or USGS (callers cannot shorten
 *    or bypass the cache: there is no query parameter for it);
 *  - each source has at most one upstream fetch in flight: concurrent
 *    requests during a refresh await the same promise;
 *  - the two sources are fetched independently (Promise.allSettled). When a
 *    source fails but its last good data is at most SOURCE_STALE_MAX_MS old,
 *    that data is still served with sources.<name> = "stale"; older data is
 *    dropped (sources.<name> = "error", partial: true). A failed source is
 *    retried at most once per SOURCE_RETRY_MS, or once per
 *    COLD_START_RETRY_MS while it has never returned data (a cold start
 *    during a network blip must not answer 503 for a whole minute);
 *  - when both sources fail, whatever older data exists is served with
 *    stale: true; with nothing cached at all the feed is unavailable (503).
 *    There is no seeded or demo item anywhere in this path, and an empty
 *    live result is an empty feed, never padded with invented items;
 *  - upstream error details stay in the server log and in status() (for
 *    logs/admin); the public response never carries them.
 *
 * Fetchers and the clock are injectable for tests.
 */
import { fetchNasaEventsRated } from "./nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";
import { fetchUsgsEarthquakes, normalizeUsgsEarthquakes } from "./usgs.service.js";

/** Server-side cache lifetime per source; not configurable by callers. */
export const FEED_CACHE_MS = 5 * 60 * 1000;
/** A source that just failed is not retried before this much time has passed. */
export const SOURCE_RETRY_MS = 60 * 1000;
/** Shorter retry delay for a source that has never returned data yet (cold start). */
export const COLD_START_RETRY_MS = 10 * 1000;
/** A failed source keeps serving its last good data while it is at most this old. */
export const SOURCE_STALE_MAX_MS = 60 * 60 * 1000;

/** Message of the public 503; the per-source reasons are logged, never sent. */
export const FEED_UNAVAILABLE_MESSAGE = "Live disaster sources are not responding";

/** Accepted ranges for the public query parameters (values outside are clamped). */
export const FEED_PARAM_LIMITS = {
  limit: { min: 1, max: 200, fallback: 50 },
  minutes: { min: 60, max: 30 * 24 * 60, fallback: 7 * 24 * 60 },
  minMag: { min: 0, max: 10, fallback: 4.5 },
};

export class FeedUnavailableError extends Error {
  constructor(message = FEED_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "FeedUnavailableError";
  }
}

function sanitizeText(s) {
  if (!s) return s;
  // Clean up characters that render incorrectly in PowerShell
  return String(s).replace(/•/g, " - ").replace(/\s+/g, " ").trim();
}

const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

export function createFeedService({
  fetchNasa = fetchNasaEventsRated, // EONET events with their GDACS impact level attached
  fetchUsgs = fetchUsgsEarthquakes,
  now = () => Date.now(), // read through the global so fake timers in tests apply
  log = console,
  cacheMs = FEED_CACHE_MS,
  retryMs = SOURCE_RETRY_MS,
  coldStartRetryMs = COLD_START_RETRY_MS,
  staleMaxMs = SOURCE_STALE_MAX_MS,
} = {}) {
  // Raw source payloads, cached per source
  const sources = {
    nasa: { fetch: fetchNasa, data: null, updatedAt: 0, failedAt: 0, lastError: null, inflight: null },
    usgs: { fetch: fetchUsgs, data: null, updatedAt: 0, failedAt: 0, lastError: null, inflight: null },
  };

  const isFresh = (s, t) => s.data !== null && t - s.updatedAt < cacheMs;
  // a source with no data at all retries sooner; one with data keeps the normal back-off
  const inRetryBackoff = (s, t) => s.failedAt !== 0 && t - s.failedAt < (s.data === null ? coldStartRetryMs : retryMs);

  /** One upstream fetch per source at a time; every concurrent caller awaits the same promise. */
  function fetchOnce(name, t) {
    const s = sources[name];
    if (s.inflight) return s.inflight;
    s.inflight = Promise.allSettled([s.fetch()])
      .then(([outcome]) => {
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
      })
      .finally(() => {
        s.inflight = null;
      });
    return s.inflight;
  }

  /**
   * Brings a source up to date. Returns one of
   *   "cache" (fresh data already held), "live" (fetched now),
   *   "error" (fetch failed now), "backoff" (failed recently, not retried).
   */
  async function refresh(name, t) {
    const s = sources[name];
    if (isFresh(s, t)) return "cache";
    if (inRetryBackoff(s, t)) return "backoff";
    return fetchOnce(name, t);
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
   * -> { items, count, source, stale, partial, sources, sourcesUpdatedAt, updatedAt, params }
   *   sources:          { nasa, usgs } each "ok" (fresh or fetched now), "stale" (failed,
   *                     last good data still served) or "error" (failed, nothing served)
   *   sourcesUpdatedAt: { nasa, usgs } ISO time of the data served per source, null when none
   *   partial:          true when a source contributed nothing
   *   stale:            true when neither source answered and older data is served
   *   source:           "CACHE" | "NASA + USGS" | "NASA" | "USGS" | "CACHE-FALLBACK"
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
    const states = { nasa: nasaState, usgs: usgsState };
    const ok = (name) => states[name] === "cache" || states[name] === "live";
    const liveNow = nasaState === "live" || usgsState === "live";
    const anyOk = ok("nasa") || ok("usgs");

    // Per-source verdict: what is served and under which label
    const verdict = (name) => {
      const s = sources[name];
      if (ok(name)) return { status: "ok", data: s.data };
      if (s.data === null) return { status: "error", data: null };
      // failed: recent data is still served; with no source answering at all, any older data is
      if (anyOk && t - s.updatedAt > staleMaxMs) return { status: "error", data: null };
      return { status: "stale", data: s.data };
    };
    const v = { nasa: verdict("nasa"), usgs: verdict("usgs") };
    const served = { nasa: v.nasa.data, usgs: v.usgs.data };

    if (served.nasa === null && served.usgs === null) {
      log.error(`[feed] both sources failed and nothing is cached (NASA: ${sources.nasa.lastError}; USGS: ${sources.usgs.lastError})`);
      throw new FeedUnavailableError();
    }

    for (const name of ["nasa", "usgs"]) {
      if (v[name].status === "stale") log.warn(`[feed] ${name} unreachable (${sources[name].lastError}); serving its data from ${iso(sources[name].updatedAt)}`);
      if (v[name].status === "error" && sources[name].lastError) log.warn(`[feed] ${name} unavailable (${sources[name].lastError}); its items are dropped`);
    }

    const items = buildItems(served, params);
    const partial = served.nasa === null || served.usgs === null;
    const status = { nasa: v.nasa.status, usgs: v.usgs.status };
    const sourcesUpdatedAt = {
      nasa: served.nasa !== null ? iso(sources.nasa.updatedAt) : null,
      usgs: served.usgs !== null ? iso(sources.usgs.updatedAt) : null,
    };
    const updatedAt = Math.max(served.nasa !== null ? sources.nasa.updatedAt : 0, served.usgs !== null ? sources.usgs.updatedAt : 0);
    const label = served.nasa !== null && served.usgs !== null ? "NASA + USGS" : served.nasa !== null ? "NASA" : "USGS";

    return {
      items,
      count: items.length,
      source: !anyOk ? "CACHE-FALLBACK" : liveNow ? label : "CACHE",
      stale: !anyOk,
      partial,
      sources: status,
      sourcesUpdatedAt,
      updatedAt: iso(updatedAt),
      params,
    };
  }

  /** Per-source state for logs/admin (includes the last upstream error; never exposed on the public route). */
  function status() {
    const entry = (s) => ({ cached: s.data !== null, updatedAt: iso(s.updatedAt), lastError: s.lastError });
    return { nasa: entry(sources.nasa), usgs: entry(sources.usgs) };
  }

  /** Forgets every cached payload (tests only). */
  function reset() {
    for (const s of Object.values(sources)) {
      s.data = null;
      s.updatedAt = 0;
      s.failedAt = 0;
      s.lastError = null;
      s.inflight = null;
    }
  }

  return { getFeed, status, reset };
}

/** Process-wide instance used by the route. */
export const feedService = createFeedService();
