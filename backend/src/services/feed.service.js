/**
 * Public disaster feed (NASA EONET + USGS) with a short in-memory cache.
 *
 *  - a fresh cache answers without calling the sources;
 *  - a live fetch replaces the cache (an empty live result is an empty feed,
 *    it is never padded with invented items);
 *  - when the sources fail, the previous cache is served with stale: true;
 *    with no cache at all the feed is unavailable (503) — there is no
 *    seeded or demo item anywhere in this path.
 *
 * Fetchers and the clock are injectable for tests.
 */
import { fetchNasaEvents } from "./nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";
import { fetchUsgsEarthquakes, normalizeUsgsEarthquakes } from "./usgs.service.js";

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

export function createFeedService({ fetchNasa = fetchNasaEvents, fetchUsgs = fetchUsgsEarthquakes, now = Date.now, log = console } = {}) {
  let cache = null; // { items, updatedAt }

  async function fetchLive({ minutesWindow, limit, minMag }) {
    const nasaNormalized = normalizeNasaEvents(await fetchNasa())
      .filter((e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow)
      .slice(0, Math.ceil(limit * 0.6)); // up to 60 % of the limit from NASA

    const quakesNormalized = normalizeUsgsEarthquakes(await fetchUsgs(), { minMag, limit: Math.ceil(limit * 0.6) }).filter(
      (e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow
    );

    return [...nasaNormalized, ...quakesNormalized].slice(0, limit).map((e) => ({
      ...e,
      meta: sanitizeText(e.meta),
      description: sanitizeText(e.description),
      location: sanitizeText(e.location),
      title: sanitizeText(e.title),
    }));
  }

  /**
   * -> { items, count, source, stale, updatedAt, params }
   * Throws FeedUnavailableError when the sources fail and nothing is cached.
   */
  async function getFeed({ forceLive = false, minutesWindow = 7 * 24 * 60, limit = 50, minMag = 4.5, cacheMs = 5 * 60 * 1000 } = {}) {
    const params = { minutesWindow, limit, minMag, cacheMs };
    if (!forceLive && cache && now() - cache.updatedAt < cacheMs) {
      return { items: cache.items, count: cache.items.length, source: "CACHE", stale: false, updatedAt: new Date(cache.updatedAt).toISOString(), params };
    }
    try {
      const items = await fetchLive({ minutesWindow, limit, minMag });
      cache = { items, updatedAt: now() };
      return { items, count: items.length, source: "NASA + USGS", stale: false, updatedAt: new Date(cache.updatedAt).toISOString(), params };
    } catch (err) {
      const reason = err?.message || String(err);
      if (cache) {
        log.error(`[feed] live fetch failed, serving the previous feed as stale: ${reason}`);
        return { items: cache.items, count: cache.items.length, source: "CACHE-FALLBACK", stale: true, updatedAt: new Date(cache.updatedAt).toISOString(), params };
      }
      log.error(`[feed] live fetch failed and nothing is cached: ${reason}`);
      throw new FeedUnavailableError(`Disaster feed unavailable: ${reason}`);
    }
  }

  function status() {
    return { cached: cache !== null, items: cache?.items.length ?? 0, updatedAt: cache ? new Date(cache.updatedAt).toISOString() : null };
  }

  return { getFeed, status };
}

/** Process-wide instance used by the route. */
export const feedService = createFeedService();
