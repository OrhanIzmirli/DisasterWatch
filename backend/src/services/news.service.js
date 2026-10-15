/**
 * News service: a background job refreshes a cache of disaster news; user
 * requests only ever read the cache.
 *
 *  - the ~10 most important feed events (high severity first, then newest)
 *    are folded into at most 3 combined searches (one per hazard type, the
 *    events' places OR-ed together) plus one general disaster search, so a
 *    refresh costs at most 4 provider requests; articles are linked to their
 *    event on our side (src/services/newsLinking.js), which powers
 *    "Show on map" in the news panel;
 *  - providers are tried in order (src/services/newsProviders): GDELT first;
 *    when it yields nothing (429, timeouts, backoff) the same plan runs on
 *    The Guardian if GUARDIAN_API_KEY is set. The provider that served the
 *    cache sets the next refresh interval (GDELT 15 min, Guardian 30 min);
 *  - every successful refresh is written to the NewsCache table and loaded
 *    back on start-up, so a restart serves the previous articles at once;
 *  - Guardian articles expire 24 h after they were fetched (licence);
 *  - when a refresh fails, the previous cache is served with stale: true;
 *    when there is no cache at all, getNews() throws NewsUnavailableError.
 *
 * Everything external is injectable for tests.
 */
import { buildSearchPlan, dedupeArticles, linkArticlesToEvents, mentionsDisaster, MAX_EVENT_QUERIES } from "./newsLinking.js";
import { createNewsProviders } from "./newsProviders/index.js";
import { fetchNasaEventsRated } from "./nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";
import { cleanTitle } from "../utils/eventDetails.js";
import { fetchUsgsEarthquakes, normalizeUsgsEarthquakes } from "./usgs.service.js";

export const REFRESH_INTERVAL_MS = 15 * 60 * 1000;
export const TOP_EVENTS = 10;
export const GENERAL_LIMIT = 15;
export const GROUP_LIMIT = 25;
/** Hard cap on provider requests per refresh (3 event groups + 1 general). */
export const MAX_REQUESTS_PER_REFRESH = MAX_EVENT_QUERIES + 1;
const EVENT_WINDOW_MS = 24 * 3600 * 1000;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2, unrated: 3 };

export class NewsUnavailableError extends Error {
  constructor(message) {
    super(message);
    this.name = "NewsUnavailableError";
  }
}

/** Current feed events, same normalisation as GET /disasters. */
export async function loadFeedEvents({ fetchNasa = fetchNasaEventsRated, fetchUsgs = fetchUsgsEarthquakes } = {}) {
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

/** An article published more than 24 h before its event cannot be about it. */
function withinEventWindow(article, ev) {
  const occurred = ev.details?.occurredAt ? new Date(ev.details.occurredAt).getTime() : NaN;
  if (!Number.isFinite(occurred) || !article.publishedAt) return true;
  return new Date(article.publishedAt).getTime() >= occurred - EVENT_WINDOW_MS;
}

function attachEvent(article, ev) {
  // `summary` (the provider's standfirst) only serves the relevance check; it is neither cached nor served.
  const { event, summary, ...rest } = article;
  const linked = ev && withinEventWindow(rest, ev) ? ev : null;
  return { ...rest, relatedEvent: linked ? relatedEventOf(linked) : null };
}

/**
 * Runs the search plan on one provider. Never throws: returns what the
 * provider produced plus the failure count, so the caller can decide whether
 * to fall back. Request budget: plan.length + 1 <= MAX_REQUESTS_PER_REFRESH.
 */
async function runPlan(provider, plan, top, log) {
  const linked = [];
  let general = [];
  let failures = 0;
  let lastFailure = null;
  let requests = 0;

  for (const group of plan) {
    requests += 1;
    try {
      const articles = await provider.searchGroup(group, { maxRecords: GROUP_LIMIT });
      const assigned = linkArticlesToEvents(articles, group.events, { single: group.events.length === 1 });
      for (const a of assigned) linked.push(attachEvent(a, a.event));
    } catch (err) {
      failures += 1;
      lastFailure = err?.message || String(err);
      log.warn(`[news] ${provider.label} ${group.type} search failed (${group.places.join(", ")}): ${lastFailure}`);
    }
  }

  requests += 1;
  try {
    const articles = await provider.searchGeneral({ maxRecords: GENERAL_LIMIT });
    // The provider matched the query somewhere in the article; the headline or standfirst must name a hazard.
    const relevant = articles.filter(mentionsDisaster);
    if (relevant.length < articles.length) {
      log.log(`[news] ${provider.label} general search: ${articles.length - relevant.length} of ${articles.length} articles dropped (no hazard word in headline/standfirst)`);
    }
    general = linkArticlesToEvents(relevant, top, { requireHazard: true }).map((a) => attachEvent(a, a.event));
  } catch (err) {
    failures += 1;
    lastFailure = err?.message || String(err);
    log.warn(`[news] ${provider.label} general search failed: ${lastFailure}`);
  }

  // Linked articles first (plan order), then the rest; duplicates dropped.
  const items = dedupeArticles([
    ...linked.filter((a) => a.relatedEvent),
    ...general.filter((a) => a.relatedEvent),
    ...linked.filter((a) => !a.relatedEvent),
    ...general.filter((a) => !a.relatedEvent),
  ]);
  return { items, failures, attempted: requests, lastFailure, linkedCount: items.filter((a) => a.relatedEvent).length };
}

export function createNewsService({
  providers = null,
  store = null,
  loadEvents = loadFeedEvents,
  now = () => new Date(),
  log = console,
  topEvents = TOP_EVENTS,
} = {}) {
  let cache = null; // { items, updatedAt, provider }
  let lastRefreshFailed = false;
  let refreshedOnce = false; // a refresh attempt completed in this process
  let lastError = null;
  let refreshing = null;
  let providerList = providers;
  let storeImpl = store;

  async function getProviders() {
    if (!providerList) providerList = createNewsProviders({ log });
    return providerList;
  }

  async function getStore() {
    if (!storeImpl) {
      const { createPrismaNewsStore } = await import("./newsStore.js");
      storeImpl = createPrismaNewsStore();
    }
    return storeImpl;
  }

  function providerByName(name) {
    return (providerList ?? []).find((p) => p.name === name) ?? null;
  }

  function liveItems(items, at) {
    const t = at.getTime();
    return items.filter((a) => !a.expiresAt || new Date(a.expiresAt).getTime() > t);
  }

  /** Loads the last persisted refresh (after a restart). Never throws. */
  async function restore() {
    try {
      const saved = await (await getStore()).load(now());
      if (saved && saved.items.length) {
        cache = { items: saved.items, updatedAt: saved.fetchedAt, provider: saved.items[0]?.provider ?? null };
        log.log(`[news] restored ${saved.items.length} cached articles from the database (fetched ${saved.fetchedAt})`);
      }
    } catch (err) {
      log.warn(`[news] could not load the persisted cache: ${err?.message || err}`);
    }
    return cache;
  }

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
        const top = pickTopEvents(events, topEvents).map((ev) => ({ ...ev, locationText: eventLabel(ev) }));
        const plan = buildSearchPlan(top, { maxQueries: MAX_EVENT_QUERIES });

        const outcomes = [];
        let served = null;
        for (const provider of await getProviders()) {
          const result = await runPlan(provider, plan, top, log);
          outcomes.push({ provider, ...result });
          if (result.items.length > 0) {
            served = { provider, ...result };
            break;
          }
          log.warn(`[news] ${provider.label} produced no articles (${result.failures}/${result.attempted} searches failed)${provider === providerList.at(-1) ? "" : ", trying the next provider"}`);
        }

        // A refresh that produced nothing anywhere must not wipe a good cache.
        if (!served) {
          const detail = outcomes
            .map((o) => `${o.provider.label}: ${o.failures === o.attempted ? `all ${o.attempted} searches failed (last: ${o.lastFailure})` : "no articles"}`)
            .join("; ");
          throw new Error(detail);
        }

        const expiresAt = served.provider.retentionMs ? new Date(startedAt.getTime() + served.provider.retentionMs).toISOString() : null;
        const items = served.items.map((a) => ({ ...a, expiresAt }));
        cache = { items, updatedAt: startedAt.toISOString(), provider: served.provider.name };
        lastRefreshFailed = false;
        lastError = null;
        log.log(
          `[news] refreshed via ${served.provider.label}: ${items.length} articles (${served.linkedCount} linked to ${top.length} events, ${served.attempted} request(s), ${served.failures} failure(s))`
        );
        try {
          await (await getStore()).save(items, startedAt);
        } catch (err) {
          log.warn(`[news] could not persist the cache: ${err?.message || err}`);
        }
        return cache;
      } catch (err) {
        lastRefreshFailed = true;
        lastError = err?.message || String(err);
        log.error(`[news] refresh failed: ${lastError}${cache ? " (serving stale cache)" : " (no cache yet)"}`);
        return null;
      } finally {
        refreshedOnce = true;
        refreshing = null;
      }
    })();
    return refreshing;
  }

  /** Stale: the last refresh failed, or nothing has been refreshed yet and the restored cache is older than one interval. */
  function isStale(at) {
    if (!cache) return false;
    if (lastRefreshFailed) return true;
    if (!refreshedOnce) return at.getTime() - new Date(cache.updatedAt).getTime() > nextIntervalMs();
    return false;
  }

  /**
   * Cached news. Filters: type (relatedEvent.type) and eventId
   * (relatedEvent.id). Throws NewsUnavailableError when nothing is cached.
   */
  function getNews({ type = null, eventId = null, limit = 50 } = {}) {
    const at = now();
    const live = cache ? liveItems(cache.items, at) : [];
    if (!cache || live.length === 0) {
      throw new NewsUnavailableError(lastError ? `News unavailable: ${lastError}` : "News is still loading, try again shortly");
    }
    let items = live;
    if (type) items = items.filter((a) => a.relatedEvent?.type === type);
    if (eventId !== null && eventId !== undefined) items = items.filter((a) => a.relatedEvent?.id === eventId);
    const provider = providerByName(cache.provider);
    return {
      items: items.slice(0, limit).map(({ expiresAt, ...a }) => a),
      updatedAt: cache.updatedAt,
      stale: isStale(at),
      lastError,
      provider: cache.provider,
      source: provider?.label ?? (cache.provider === "guardian" ? "The Guardian" : "GDELT"),
    };
  }

  /** Interval until the next refresh: set by the provider that served the cache. */
  function nextIntervalMs() {
    const p = providerByName(cache?.provider);
    return p?.refreshIntervalMs ?? REFRESH_INTERVAL_MS;
  }

  function status() {
    const at = now();
    return {
      cached: cache !== null,
      updatedAt: cache?.updatedAt ?? null,
      stale: isStale(at),
      lastError,
      articles: cache ? liveItems(cache.items, at).length : 0,
      provider: cache?.provider ?? null,
      nextIntervalMs: nextIntervalMs(),
    };
  }

  /** Restore from the database, refresh now, then keep refreshing at the serving provider's interval. Never throws. */
  function start() {
    let timer = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        await refresh();
        schedule();
      }, nextIntervalMs());
      timer.unref?.();
    };
    (async () => {
      await restore();
      await refresh();
      schedule();
    })();
    return {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  return { refresh, restore, getNews, status, start, nextIntervalMs };
}

/** Process-wide instance used by the route and index.js. */
export const newsService = createNewsService();
