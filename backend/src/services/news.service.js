/**
 * News service: a background job refreshes a cache of disaster news from
 * GDELT every 15 minutes; user requests only ever read the cache.
 *
 *  - the ~10 most important feed events (high severity first, then newest)
 *    each get a targeted search ("earthquake Kushiro Japan"), linked to the
 *    event so the UI can show "Show on map";
 *  - one general search provides disaster news not tied to an event;
 *  - GDELT calls are throttled (>= 5 s apart) and time-limited (8 s);
 *  - when a refresh fails, the previous cache is served with stale: true;
 *    when there is no cache at all, getNews() throws NewsUnavailableError.
 *
 * Everything external is injectable for tests.
 */
import { createGdeltClient } from "./gdelt.js";
import { findArticlesForEvent, normalizeArticle, dedupeArticles, GENERAL_QUERY } from "./newsLinking.js";
import { fetchNasaEvents } from "./nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";
import { cleanTitle } from "../utils/eventDetails.js";
import { fetchUsgsEarthquakes, normalizeUsgsEarthquakes } from "./usgs.service.js";

export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const TOP_EVENTS = 10;
export const GENERAL_LIMIT = 15;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

export class NewsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NewsUnavailableError";
  }
}

/** Current feed events, same normalisation as GET /disasters. */
export async function loadFeedEvents({ fetchNasa = fetchNasaEvents, fetchUsgs = fetchUsgsEarthquakes } = {}) {
  const [nasa, usgs] = await Promise.all([
    fetchNasa().then(normalizeNasaEvents).catch(() => []),
    fetchUsgs()
      .then((f) => normalizeUsgsEarthquakes(f, { minMag: 4.5, limit: 300 }))
      .catch(() => []),
  ]);
  return [...nasa, ...usgs];
}

/** High severity first, then most recent; first `limit` events. */
export function pickTopEvents(events, limit = TOP_EVENTS) {
  return [...events]
    .sort((a, b) => {
      const s = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
      return s !== 0 ? s : (a.timeMinutesAgo ?? 1e9) - (b.timeMinutesAgo ?? 1e9);
    })
    .slice(0, limit);
}

/** Event label shown on a news card; never the raw source title with its numeric id. */
function eventLabel(ev) {
  return ev.details?.cleanTitle || cleanTitle(ev.location);
}

function relatedEventOf(ev) {
  return {
    id: ev.id,
    type: ev.type,
    severity: ev.severity,
    location: eventLabel(ev),
    lat: ev.lat,
    lng: ev.lng,
  };
}

export function createNewsService({
  gdelt = createGdeltClient(),
  loadEvents = loadFeedEvents,
  now = () => new Date(),
  log = console,
  topEvents = TOP_EVENTS,
} = {}) {
  let cache = null; // { items, updatedAt }
  let stale = false;
  let lastError = null;
  let refreshing = null;

  /**
   * One refresh pass. Resolves to the new cache on success; on failure keeps
   * the old cache (marked stale) and returns null.
   */
  async function refresh() {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const startedAt = now();
      try {
        const events = await loadEvents();
        const top = pickTopEvents(events, topEvents);

        const linked = [];
        let failures = 0;
        let lastFailure = null;
        for (const ev of top) {
          try {
            const articles = await findArticlesForEvent(
              {
                type: ev.type,
                locationText: eventLabel(ev),
                occurredAt: ev.details?.occurredAt ?? null,
              },
              { searchArticles: (o) => gdelt.searchArticles(o), maxRecords: 8 }
            );
            for (const a of articles) linked.push({ ...a, relatedEvent: relatedEventOf(ev) });
          } catch (err) {
            failures += 1;
            lastFailure = err?.message || String(err);
            log.warn(`[news] event search failed (${ev.type} ${ev.location}): ${lastFailure}`);
          }
        }

        let general = [];
        try {
          const raw = await gdelt.searchArticles({ query: `${GENERAL_QUERY} sourcelang:english`, timespan: "72h", maxRecords: GENERAL_LIMIT });
          general = raw.map(normalizeArticle).filter(Boolean).map((a) => ({ ...a, relatedEvent: null }));
        } catch (err) {
          failures += 1;
          lastFailure = err?.message || String(err);
          log.warn(`[news] general search failed: ${lastFailure}`);
        }

        const items = dedupeArticles([...linked, ...general]);
        const attempted = top.length + 1;

        // A refresh that produced nothing (GDELT answering {} or failing
        // everywhere) must not wipe a good cache.
        if (items.length === 0) {
          throw new Error(
            failures === attempted
              ? `all ${attempted} GDELT searches failed (last: ${lastFailure})`
              : "GDELT returned no articles"
          );
        }

        cache = { items, updatedAt: startedAt.toISOString() };
        stale = false;
        lastError = null;
        log.log(`[news] refreshed: ${items.length} articles (${linked.length} linked to ${top.length} events, ${failures} search failure(s))`);
        return cache;
      } catch (err) {
        stale = cache !== null;
        lastError = err?.message || String(err);
        log.error(`[news] refresh failed: ${lastError}${cache ? " (serving stale cache)" : " (no cache yet)"}`);
        return null;
      } finally {
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /**
   * Cached news. Filters: type (relatedEvent.type) and eventId
   * (relatedEvent.id). Throws NewsUnavailableError when nothing is cached.
   */
  function getNews({ type = null, eventId = null, limit = 50 } = {}) {
    if (!cache) {
      throw new NewsUnavailableError(lastError ? `News unavailable: ${lastError}` : "News is still loading, try again shortly");
    }
    let items = cache.items;
    if (type) items = items.filter((a) => a.relatedEvent?.type === type);
    if (eventId !== null && eventId !== undefined) items = items.filter((a) => a.relatedEvent?.id === eventId);
    return { items: items.slice(0, limit), updatedAt: cache.updatedAt, stale, lastError };
  }

  function status() {
    return { cached: cache !== null, updatedAt: cache?.updatedAt ?? null, stale, lastError, articles: cache?.items.length ?? 0 };
  }

  /** Refresh now and then every intervalMs. Never throws. */
  function start({ intervalMs = REFRESH_INTERVAL_MS } = {}) {
    refresh();
    const timer = setInterval(refresh, intervalMs);
    timer.unref?.();
    return { stop: () => clearInterval(timer) };
  }

  return { refresh, getNews, status, start };
}

/** Process-wide instance used by the route and index.js. */
export const newsService = createNewsService();
