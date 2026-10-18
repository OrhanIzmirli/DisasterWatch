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
 *  - every provider runs (src/services/newsProviders: GDELT, GDACS media
 *    news, plus The Guardian when GUARDIAN_API_KEY is set) and the panel
 *    shows their articles merged. Each provider keeps its own last good
 *    share: one that fails (429, timeout, backoff) keeps serving what it
 *    fetched before until that expires. Each provider runs at its own
 *    interval (GDELT 15 min, Guardian and GDACS 30 min). GDACS does not
 *    search: it lists the media articles of each feed event that links to
 *    a GDACS report, so its articles arrive linked to their event;
 *  - every article is placed for the region filter (src/services/newsLocation.js:
 *    linked event -> Guardian tags -> GDACS event country), or left
 *    unlocated (listed only under "All regions");
 *  - every article must pass the disaster-news relevance rules
 *    (src/services/newsRelevance.js), whatever search returned it; the
 *    rules and the location check run again on the cached articles each
 *    time the cache is rebuilt (also after a restore from the database);
 *  - GDELT dates are GDELT's crawl time: when the article URL carries an
 *    earlier publication day that day is used, and GDELT articles older
 *    than 72 h are dropped; headlines that only name storms which are
 *    neither in the feed nor closed in EONET in the last 14 days are
 *    dropped as retrospectives (src/services/stormContext.js);
 *  - every successful refresh is written to the NewsCache table and loaded
 *    back on start-up, so a restart serves the previous articles at once;
 *  - Guardian articles expire 24 h after they were fetched (licence);
 *  - stale: true when every provider that still contributes articles failed
 *    its last attempt (or the whole refresh failed), so a fresh Guardian
 *    share is not reported stale just because GDELT was rate-limited;
 *    when there is no cache at all, getNews() throws NewsUnavailableError.
 *
 * Everything external is injectable for tests.
 */
import { buildSearchPlan, dedupeArticles, linkArticlesToEvents, MAX_EVENT_QUERIES, withUrlDate } from "./newsLinking.js";
import { GDELT_RETENTION_MS } from "./newsProviders/gdelt.provider.js";
import { createStormContext } from "./stormContext.js";
import { isDisasterNews, stormNamesIn } from "./newsRelevance.js";
import { withLocation, confirmLocation } from "./newsLocation.js";
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
const PROVIDER_LABELS = { gdelt: "GDELT", guardian: "The Guardian", gdacs: "GDACS" };

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
    country: ev.country ?? null,
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
 * GDELT articles are searched over the last 72 h; one whose publication date
 * (from its URL when that is earlier than GDELT's seen date, see
 * withUrlDate) is older than that is an old page crawled again. Returns a
 * drop verdict, or null to go on with the relevance rules.
 */
function tooOld(article, at) {
  if (article?.provider !== "gdelt" || !article.publishedAt) return null;
  const published = new Date(article.publishedAt).getTime();
  if (!Number.isFinite(published) || at.getTime() - published <= GDELT_RETENTION_MS) return null;
  return { keep: false, marker: true, reason: `published ${article.publishedAt.slice(0, 10)}, older than 72 h` };
}

/**
 * Keeps disaster/hazard news only (src/services/newsRelevance.js) and logs
 * what was dropped and why, so the filter can be audited from the logs.
 */
function relevantOnly(articles, provider, what, log, dropped, rules = {}) {
  const kept = [];
  for (const a of articles) {
    const verdict = tooOld(a, rules.now ?? new Date()) ?? isDisasterNews(a, rules);
    if (verdict.keep) kept.push(a);
    else dropped.push({ title: a.title, url: a.url, provider: provider.name, search: what, reason: verdict.reason });
  }
  if (kept.length < articles.length) {
    log.log(`[news] ${provider.label} ${what}: ${articles.length - kept.length} of ${articles.length} articles dropped as not disaster news`);
  }
  return kept;
}

/**
 * Runs the search plan on one provider. Never throws: returns what the
 * provider produced plus the failure count and the last failure's kind.
 * Request budget: plan.length + 1 <= MAX_REQUESTS_PER_REFRESH.
 */
async function runPlan(provider, plan, top, log, rules = {}) {
  const linked = [];
  let general = [];
  let failures = 0;
  let lastFailure = null;
  let lastFailureKind = null;
  let requests = 0;
  const dropped = [];

  for (const group of plan) {
    requests += 1;
    try {
      const articles = relevantOnly(await provider.searchGroup(group, { maxRecords: GROUP_LIMIT }), provider, `${group.type} search`, log, dropped, rules);
      const assigned = linkArticlesToEvents(articles, group.events, { single: group.events.length === 1 });
      for (const a of assigned) linked.push(attachEvent(a, a.event));
    } catch (err) {
      failures += 1;
      lastFailure = err?.message || String(err);
      lastFailureKind = err?.kind ?? "error";
      log.warn(`[news] ${provider.label} ${group.type} search failed (${group.places.join(", ")}): ${lastFailure}`);
    }
  }

  requests += 1;
  try {
    // The provider matched the query somewhere in the article; the relevance rules decide what is disaster news.
    const relevant = relevantOnly(await provider.searchGeneral({ maxRecords: GENERAL_LIMIT }), provider, "general search", log, dropped, rules);
    general = linkArticlesToEvents(relevant, top, { requireHazard: true }).map((a) => attachEvent(a, a.event));
  } catch (err) {
    failures += 1;
    lastFailure = err?.message || String(err);
    lastFailureKind = err?.kind ?? "error";
    log.warn(`[news] ${provider.label} general search failed: ${lastFailure}`);
  }

  // Linked articles first (plan order), then the rest; duplicates dropped.
  const items = dedupeArticles([
    ...linked.filter((a) => a.relatedEvent),
    ...general.filter((a) => a.relatedEvent),
    ...linked.filter((a) => !a.relatedEvent),
    ...general.filter((a) => !a.relatedEvent),
  ]);
  return { items, failures, attempted: requests, lastFailure, lastFailureKind, dropped, linkedCount: items.filter((a) => a.relatedEvent).length };
}

/**
 * Runs a per-event provider (GDACS media news) over the feed events. Its
 * articles come already linked to their event; the relevance rules still
 * apply. Same result shape as runPlan.
 */
async function runEvents(provider, events, log, rules = {}) {
  const dropped = [];
  const out = await provider.searchEvents(events);
  if (out.failures) log.warn(`[news] ${provider.label}: ${out.failures} of ${out.attempted} event lookups failed (last: ${out.lastFailure})`);
  const relevant = relevantOnly(out.articles, provider, "event media", log, dropped, rules);
  const items = dedupeArticles(relevant.map((a) => attachEvent(a, a.event)));
  return {
    items,
    // nothing to ask is not a failure; every lookup failing is
    failures: out.attempted > 0 && out.failures === out.attempted ? out.failures : 0,
    attempted: out.attempted,
    lastFailure: out.lastFailure,
    lastFailureKind: out.lastFailureKind,
    dropped,
    linkedCount: items.filter((a) => a.relatedEvent).length,
  };
}

export function createNewsService({
  providers = null,
  store = null,
  loadEvents = loadFeedEvents,
  now = () => new Date(),
  log = console,
  topEvents = TOP_EVENTS,
  // the live EONET storm list only goes with the live feed loader (tests that inject events pass their own or none)
  stormContext = loadEvents === loadFeedEvents ? createStormContext({ log }) : null,
} = {}) {
  let cache = null; // { items, updatedAt, provider }
  // Names of current storms (feed + EONET open or closed in the last 14 days); null until known (see stormContext.js)
  let storms = null;
  let lastRefreshFailed = false; // the whole pass failed (feed unreadable, unexpected error)
  let refreshedOnce = false; // a refresh attempt completed in this process
  let lastError = null;
  let refreshing = null;
  let providerList = providers;
  let storeImpl = store;
  /**
   * Per provider: its last good articles (kept until it succeeds again or they
   * expire) and what happened on its last attempt, for /health.
   *   name -> { items, fetchedAt, lastAttemptAt, lastSuccessAt, lastError, lastErrorKind, lastCount, dropped, failedLast }
   */
  const states = new Map();

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

  function stateOf(name) {
    if (!states.has(name)) {
      states.set(name, { items: [], fetchedAt: null, lastAttemptAt: null, lastSuccessAt: null, lastError: null, lastErrorKind: null, lastCount: 0, dropped: 0, failedLast: false });
    }
    return states.get(name);
  }

  function liveItems(items, at) {
    const t = at.getTime();
    return items.filter((a) => !a.expiresAt || new Date(a.expiresAt).getTime() > t);
  }

  const publishedTime = (a) => (a.publishedAt ? new Date(a.publishedAt).getTime() : 0);

  /**
   * Every provider's last good articles in one list: articles linked to a feed
   * event first, then the rest, newest first inside each part; duplicates
   * across providers dropped (first kept).
   */
  function mergedItems(at) {
    const all = [];
    for (const [name, s] of states) {
      if (!s.items.length) continue;
      all.push(...liveItems(s.items, at).map((a) => ({ ...a, provider: a.provider ?? name })));
    }
    const byTime = (a, b) => publishedTime(b) - publishedTime(a);
    return dedupeArticles([...all.filter((a) => a.relatedEvent).sort(byTime), ...all.filter((a) => !a.relatedEvent).sort(byTime)]);
  }

  /**
   * Current rules on cached articles: the relevance filter and the location
   * check run again, so a rule change takes effect on the articles restored
   * from the database instead of after they expire. The standfirst is never
   * cached, so a Guardian article that was kept on its standfirst is only
   * dropped by an explicit marker (section, feature, sports, retrospective).
   */
  function recheck(items, name) {
    const kept = [];
    const at = now();
    for (const cached of items) {
      // rows cached before the URL-date rule still carry GDELT's seen date
      const a = (cached.provider ?? name) === "gdelt" ? withUrlDate({ ...cached, provider: "gdelt" }, at) : cached;
      const verdict = tooOld(a, at) ?? isDisasterNews(a, { now: at, storms });
      if (!verdict.keep && (verdict.marker || (a.provider ?? name) !== "guardian")) continue;
      const location = confirmLocation({ ...a, provider: a.provider ?? name }, a.location ?? null);
      const out = a === cached ? cached : { ...cached, publishedAt: a.publishedAt };
      kept.push(location === out.location ? out : { ...out, location });
    }
    return kept;
  }

  function rebuildCache(at) {
    for (const [name, s] of states) {
      const before = s.items.length;
      s.items = recheck(s.items, name);
      if (s.items.length < before) log.log(`[news] ${PROVIDER_LABELS[name] ?? name}: ${before - s.items.length} cached article(s) dropped by the current relevance rules`);
    }
    const items = mergedItems(at);
    if (!items.length) return null;
    const names = [...states].filter(([, s]) => s.items.length && liveItems(s.items, at).length).map(([n]) => n);
    const updatedAt = names
      .map((n) => states.get(n).fetchedAt)
      .filter(Boolean)
      .sort()
      .at(-1);
    cache = { items, updatedAt, provider: names.join("+") };
    return cache;
  }

  /** Loads the last persisted refresh (after a restart). Never throws. */
  async function restore() {
    try {
      const saved = await (await getStore()).load(now());
      if (saved && saved.items.length) {
        for (const item of saved.items) {
          const s = stateOf(item.provider ?? "unknown");
          s.items.push(item);
          s.fetchedAt = item.fetchedAt ?? saved.fetchedAt;
        }
        rebuildCache(now());
        log.log(`[news] restored ${saved.items.length} cached articles from the database (fetched ${saved.fetchedAt})`);
      }
    } catch (err) {
      log.warn(`[news] could not load the persisted cache: ${err?.message || err}`);
    }
    return cache;
  }

  /** EONET's current storms plus the storms in the feed; null when EONET's list is unavailable. */
  async function currentStorms(events) {
    if (!stormContext) return null;
    let names = null;
    try {
      names = await stormContext.names();
    } catch (err) {
      log.warn(`[news] storm list failed: ${err?.message || err}`);
    }
    if (!names) return null;
    const all = new Set(names);
    // open feed storms only: closed ones are in EONET's list when they closed within 14 days (the feed keeps 30)
    for (const ev of events) if (ev.type === "storm" && ev.details?.status !== "closed") for (const n of stormNamesIn(eventLabel(ev))) all.add(n);
    return all;
  }

  /** A provider is due when it has never been tried, or its own interval has passed since its last attempt. */
  function isDue(provider, at) {
    const last = states.get(provider.name)?.lastAttemptAt;
    return !last || at.getTime() - new Date(last).getTime() >= provider.refreshIntervalMs - 5000;
  }

  /**
   * One refresh pass over every provider (or, with `onlyDue`, only those
   * whose own interval has passed: the background loop uses that so The
   * Guardian keeps its 30-minute budget while GDELT is tried every 15).
   * Each provider that returns articles replaces its own share of the cache;
   * one that fails keeps its previous share. Resolves to the cache, or null
   * when no provider produced anything this time (the old cache is then
   * served with stale: true).
   */
  async function refresh({ onlyDue = false } = {}) {
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const startedAt = now();
      try {
        const events = await loadEvents();
        storms = await currentStorms(events);
        const rules = { now: startedAt, storms };
        const top = pickTopEvents(events, topEvents).map((ev) => ({ ...ev, locationText: eventLabel(ev) }));
        const plan = buildSearchPlan(top, { maxQueries: MAX_EVENT_QUERIES });

        const outcomes = [];
        for (const provider of await getProviders()) {
          if (onlyDue && !isDue(provider, startedAt)) continue;
          const s = stateOf(provider.name);
          s.lastAttemptAt = startedAt.toISOString();
          const groups = Number.isInteger(provider.maxGroupSearches) ? plan.slice(0, provider.maxGroupSearches) : plan;
          const result = provider.searchEvents ? await runEvents(provider, events, log, rules) : await runPlan(provider, groups, top, log, rules);
          outcomes.push({ provider, ...result });
          s.lastCount = result.items.length;
          s.dropped = result.dropped.length;
          if (result.items.length > 0) {
            const expiresAt = provider.retentionMs ? new Date(startedAt.getTime() + provider.retentionMs).toISOString() : null;
            s.items = result.items.map((a) => ({ ...withLocation(a), expiresAt, fetchedAt: startedAt.toISOString() }));
            s.failedLast = false;
            s.fetchedAt = startedAt.toISOString();
            s.lastSuccessAt = startedAt.toISOString();
            s.lastError = result.failures ? result.lastFailure : null;
            s.lastErrorKind = result.failures ? result.lastFailureKind : null;
          } else {
            s.lastError = result.failures ? result.lastFailure : "no articles";
            s.lastErrorKind = result.failures ? result.lastFailureKind : "empty";
            s.failedLast = true; // kept its previous share: that share is now older than this attempt
            log.warn(`[news] ${provider.label} produced no articles (${result.failures}/${result.attempted} searches failed); keeping its previous ${s.items.length} article(s)`);
          }
        }

        const succeeded = outcomes.filter((o) => o.items.length > 0);
        rebuildCache(startedAt);

        lastRefreshFailed = false;
        if (!succeeded.length) {
          if (!outcomes.length) return cache; // nothing was due
          const detail = outcomes
            .map((o) => `${o.provider.label}: ${o.failures === o.attempted ? `all ${o.attempted} searches failed (last: ${o.lastFailure})` : "no articles"}`)
            .join("; ");
          throw Object.assign(new Error(detail), { providersRan: true });
        }

        lastRefreshFailed = false;
        lastError = null;
        log.log(
          `[news] refreshed: ${succeeded.map((o) => `${o.provider.label} ${o.items.length} (${o.linkedCount} linked, ${o.dropped.length} dropped as off-topic)`).join(", ")}` +
            `${outcomes.length > succeeded.length ? `; failed: ${outcomes.filter((o) => !o.items.length).map((o) => o.provider.label).join(", ")}` : ""}; serving ${cache.items.length} articles`
        );
        try {
          await (await getStore()).save(cache.items, startedAt);
        } catch (err) {
          log.warn(`[news] could not persist the cache: ${err?.message || err}`);
        }
        return cache;
      } catch (err) {
        // a pass where providers ran but none produced anything is reflected per provider (failedLast)
        if (!err?.providersRan) lastRefreshFailed = true;
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

  /**
   * Stale: the whole last refresh failed, or every provider that still
   * contributes articles failed its last attempt, or nothing has been
   * refreshed yet and the restored cache is older than one interval.
   */
  function isStale(at) {
    if (!cache) return false;
    if (lastRefreshFailed) return true;
    const contributing = [...states.values()].filter((s) => liveItems(s.items, at).length > 0);
    if (refreshedOnce && contributing.length > 0 && contributing.every((s) => s.failedLast)) return true;
    if (!refreshedOnce) return at.getTime() - new Date(cache.updatedAt).getTime() > nextIntervalMs();
    return false;
  }

  /**
   * Cached news. Filters: type (relatedEvent.type), eventId
   * (relatedEvent.id) and region (location.regions; unlocated articles never
   * match a region, they are listed only without one). Throws
   * NewsUnavailableError when nothing is cached.
   */
  function getNews({ type = null, eventId = null, region = null, limit = 50 } = {}) {
    const at = now();
    const live = cache ? liveItems(cache.items, at) : [];
    if (!cache || live.length === 0) {
      throw new NewsUnavailableError(lastError ? `News unavailable: ${lastError}` : "News is still loading, try again shortly");
    }
    let items = live;
    if (type) items = items.filter((a) => a.relatedEvent?.type === type);
    if (eventId !== null && eventId !== undefined) items = items.filter((a) => a.relatedEvent?.id === eventId);
    if (region) items = items.filter((a) => a.location?.regions?.includes(region));
    const names = cache.provider ? cache.provider.split("+") : [];
    return {
      items: items.slice(0, limit).map(({ expiresAt, fetchedAt, ...a }) => a),
      updatedAt: cache.updatedAt,
      stale: isStale(at),
      lastError,
      provider: cache.provider,
      source: names.map((n) => providerByName(n)?.label ?? PROVIDER_LABELS[n] ?? n).join(" + "),
    };
  }

  /** Background loop interval: the shortest provider interval (each provider still only runs when it is due). */
  function nextIntervalMs() {
    const intervals = (providerList ?? []).map((p) => p.refreshIntervalMs).filter((n) => Number.isFinite(n) && n > 0);
    return intervals.length ? Math.min(...intervals) : REFRESH_INTERVAL_MS;
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
      providers: Object.fromEntries(
        (providerList ?? []).map((p) => {
          const s = states.get(p.name);
          return [
            p.name,
            {
              articles: s ? liveItems(s.items, at).length : 0,
              located: s ? liveItems(s.items, at).filter((a) => a.location).length : 0,
              lastAttemptAt: s?.lastAttemptAt ?? null,
              lastSuccessAt: s?.lastSuccessAt ?? null,
              lastError: s?.lastError ?? null,
              lastErrorKind: s?.lastErrorKind ?? null,
              droppedOffTopic: s?.dropped ?? 0,
            },
          ];
        })
      ),
    };
  }

  /** Restore from the database, refresh now, then keep refreshing (each provider at its own interval). Never throws. */
  function start() {
    let timer = null;
    let stopped = false;
    const schedule = () => {
      if (stopped) return;
      timer = setTimeout(async () => {
        await refresh({ onlyDue: true });
        schedule();
      }, nextIntervalMs());
      timer.unref?.();
    };
    (async () => {
      await getProviders();
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
