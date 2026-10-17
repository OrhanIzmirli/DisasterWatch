/**
 * GDACS media news (Europe Media Monitor articles that GDACS attaches to
 * each of its events) as a news provider. No key:
 *   https://www.gdacs.org/gdacsapi/api/emm/getemmnewsbykey?eventtype=FL&eventid=1104231
 *
 * Unlike GDELT and The Guardian this provider does not search: for every
 * feed event that links to a GDACS report (the same events the severity
 * client already looks up, src/services/gdacs.js) it fetches that event's
 * media list. Each article therefore arrives already linked to its feed
 * event, and it inherits where GDACS places the event (affected countries
 * and point, from the cached severity lookup: no extra request).
 *
 * Only the headline and the link are kept (GDACS sends no article text,
 * just "Article content is not available"); the panel links out. Requests
 * are spaced, bounded per refresh, and go through a backoff gate; an event
 * GDACS has no media for (404 or an empty list) is not a failure.
 */
import { createThrottle } from "../gdelt.js";
import { createBackoffGate } from "../backoff.js";
import { gdacsClient as defaultGdacsClient, parseGdacsRef } from "../gdacs.js";
import { ProviderError } from "./errors.js";

export const GDACS_NEWS_ENDPOINT = "https://www.gdacs.org/gdacsapi/api/emm/getemmnewsbykey";
export const GDACS_NEWS_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
/** Kept as long as GDELT's: the panel covers the last 72 h. */
export const GDACS_NEWS_RETENTION_MS = 72 * 60 * 60 * 1000;
/** At most this many events (most severe, then newest) are asked per refresh. */
export const GDACS_NEWS_MAX_EVENTS = 25;
/** At most this many articles per event (the list is newest first). */
export const GDACS_NEWS_PER_EVENT = 8;
export const GDACS_NEWS_MIN_GAP_MS = 500;
const DEFAULT_TIMEOUT_MS = 8000;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2, unrated: 3 };

/** { eventtype, eventid } of a feed event that links to a GDACS report, else null. */
export function gdacsRefOfFeedEvent(ev) {
  return parseGdacsRef({ sources: ev?.details?.sources ?? ev?.sources ?? [] });
}

/** EMM pubdate "2026-10-15T22:49:00" carries no zone; GDACS publishes UTC. */
function utcIso(pubdate) {
  const s = String(pubdate ?? "").trim();
  if (!s) return null;
  const d = new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * EMM item -> article { title, url, domain, publishedAt, image: null, provider: "gdacs" },
 * or null without a usable headline and http(s) link. The headline is kept
 * as sent, except GDACS's doubled apostrophes ("Libya''s") are undone.
 */
export function normalizeEmmArticle(r) {
  const title = String(r?.title ?? "").replace(/''/g, "'").replace(/\s+/g, " ").trim();
  const link = String(r?.link ?? "").trim();
  if (!title || !/^https?:\/\//i.test(link)) return null;
  let domain = "";
  try {
    domain = new URL(link).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
  return { title, url: link, domain, publishedAt: utcIso(r.pubdate), image: null, provider: "gdacs" };
}

export function buildGdacsNewsUrl(ref) {
  return `${GDACS_NEWS_ENDPOINT}?eventtype=${encodeURIComponent(ref.eventtype)}&eventid=${encodeURIComponent(ref.eventid)}`;
}

async function gdacsNewsRequest(url, { fetchImpl, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err?.name === "AbortError") throw new ProviderError("gdacs", `GDACS media timed out after ${timeoutMs} ms`, "timeout");
    throw new ProviderError("gdacs", `GDACS media network error: ${err?.message || err}`, "network");
  } finally {
    clearTimeout(timer);
  }
  if (res.status === 404 || res.status === 204) return [];
  if (res.status === 429) throw new ProviderError("gdacs", "GDACS media rate limit (429)", "rate-limit", 429);
  if (!res.ok) throw new ProviderError("gdacs", `GDACS media HTTP ${res.status}`, "http", res.status);
  const text = await res.text().catch(() => "");
  if (!text.trim()) return [];
  try {
    const data = JSON.parse(text);
    if (!Array.isArray(data)) throw new Error("not a list");
    return data;
  } catch {
    throw new ProviderError("gdacs", "GDACS media returned a non-JSON body: " + text.slice(0, 80), "non-json", res.status);
  }
}

export function createGdacsNewsProvider({
  fetchImpl = (...args) => fetch(...args),
  gdacs = defaultGdacsClient,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  throttle = createThrottle({ minGapMs: GDACS_NEWS_MIN_GAP_MS }),
  backoff = createBackoffGate({ name: "GDACS media", maxMs: 10 * 60_000 }),
  maxEvents = GDACS_NEWS_MAX_EVENTS,
  perEvent = GDACS_NEWS_PER_EVENT,
} = {}) {
  /**
   * Media articles for the feed events that link to GDACS. Never throws.
   * -> { articles: [{ ...article, event, gdacsPlace }], attempted, failures, lastFailure, lastFailureKind }
   */
  async function searchEvents(events) {
    const withRef = (Array.isArray(events) ? events : [])
      .map((ev) => ({ ev, ref: gdacsRefOfFeedEvent(ev) }))
      .filter((x) => x.ref)
      .sort((a, b) => (SEVERITY_RANK[a.ev.severity] ?? 9) - (SEVERITY_RANK[b.ev.severity] ?? 9) || (a.ev.timeMinutesAgo ?? 1e9) - (b.ev.timeMinutesAgo ?? 1e9))
      .slice(0, maxEvents);

    const articles = [];
    let failures = 0;
    let lastFailure = null;
    let lastFailureKind = null;
    for (const { ev, ref } of withRef) {
      try {
        const raw = await backoff.run(() => throttle(() => gdacsNewsRequest(buildGdacsNewsUrl(ref), { fetchImpl, timeoutMs })));
        const list = raw.map(normalizeEmmArticle).filter(Boolean).slice(0, perEvent);
        if (!list.length) continue;
        const place = await gdacs.getPlace(ref);
        for (const a of list) articles.push({ ...a, event: ev, gdacsPlace: place });
      } catch (err) {
        failures += 1;
        lastFailure = err?.message || String(err);
        lastFailureKind = err?.kind ?? "error";
      }
    }
    return { articles, attempted: withRef.length, failures, lastFailure, lastFailureKind };
  }

  return {
    name: "gdacs",
    label: "GDACS",
    refreshIntervalMs: GDACS_NEWS_REFRESH_INTERVAL_MS,
    retentionMs: GDACS_NEWS_RETENTION_MS,
    searchEvents,
    backoff,
  };
}
