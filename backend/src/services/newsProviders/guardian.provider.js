/**
 * The Guardian Open Platform as the fallback news provider.
 *
 * Developer key: 1 request/s, 500 requests/day, non-commercial use. The
 * provider therefore spaces requests >= 1.1 s apart, backs off on failures
 * and asks the service for a 30-minute refresh interval (<= 4 requests per
 * refresh, i.e. <= 200 requests/day while GDELT stays down).
 *
 * Relevance: the query matches the headline and standfirst only
 * (query-fields=headline,trailText), only regular articles are requested
 * (type=article: no live blogs, galleries, interactives) and the standfirst
 * is returned (show-fields=trailText) so the service can confirm an article
 * really is about a disaster before showing it.
 *
 * Licence obligations handled here and in the UI:
 *  - headline is passed through untouched (webTitle, no trimming/rewriting);
 *  - the link to the original article is kept (webUrl);
 *  - no images (the developer key has no image rights): image is null;
 *  - retentionMs = 24 h: the service drops Guardian rows after that;
 *  - the news panel shows the "Powered by The Guardian" logo next to them.
 *
 * Keyword tags are requested (show-tags=keyword) only to place the article
 * for the region filter: they are turned into country/region codes
 * (src/services/newsLocation.js) and not kept.
 */
import { createThrottle } from "../gdelt.js";
import { createBackoffGate } from "../backoff.js";
import { GENERAL_TERMS, placeTokens } from "../newsLinking.js";
import { ProviderError } from "./errors.js";
import { guardianTagPlace } from "../newsLocation.js";

export const GUARDIAN_ENDPOINT = "https://content.guardianapis.com/search";
export const GUARDIAN_REFRESH_INTERVAL_MS = 30 * 60 * 1000;
export const GUARDIAN_RETENTION_MS = 24 * 60 * 60 * 1000;
export const GUARDIAN_MIN_GAP_MS = 1100;
export const GUARDIAN_DOMAIN = "theguardian.com";
const DEFAULT_TIMEOUT_MS = 8000;

function orGroup(terms) {
  return `(${terms.map((t) => (t.includes(" ") ? `"${t}"` : t)).join(" OR ")})`;
}

/** "(earthquake OR quake OR tremor) AND (kushiro OR japan OR nepal)" — Guardian boolean syntax. */
export function buildGuardianGroupQuery(group) {
  const words = new Set();
  for (const place of group.places) for (const w of placeTokens(place)) words.add(w);
  const places = [...words];
  return places.length ? `${orGroup(group.terms)} AND ${orGroup(places)}` : orGroup(group.terms);
}

export const GUARDIAN_GENERAL_QUERY = orGroup(GENERAL_TERMS);

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

export const GUARDIAN_QUERY_FIELDS = "headline,trailText";

/**
 * Content search URL: regular articles only (no live blogs, galleries or
 * interactives), the query matched on headline + standfirst only, newest
 * first, last `days` days; the standfirst is returned for the relevance check.
 */
export function buildGuardianUrl({ q, apiKey, pageSize = 20, fromDate, now = new Date(), days = 3 }) {
  const from = fromDate ?? isoDate(new Date(now.getTime() - days * 24 * 3600 * 1000));
  const params = new URLSearchParams({
    q,
    "query-fields": GUARDIAN_QUERY_FIELDS,
    type: "article",
    "show-fields": "trailText",
    "show-tags": "keyword",
    "order-by": "newest",
    "from-date": from,
    "page-size": String(pageSize),
    "api-key": apiKey,
  });
  return `${GUARDIAN_ENDPOINT}?${params.toString()}`;
}

export async function guardianRequest(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err?.name === "AbortError") throw new ProviderError("guardian", `The Guardian timed out after ${timeoutMs} ms`, "timeout");
    throw new ProviderError("guardian", `The Guardian network error: ${err?.message || err}`, "network");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text().catch(() => "");
  if (res.status === 429) throw new ProviderError("guardian", "The Guardian rate limit (429): daily or per-second quota reached", "rate-limit", 429);
  if (res.status === 401 || res.status === 403) throw new ProviderError("guardian", `The Guardian rejected the API key (HTTP ${res.status})`, "auth", res.status);
  if (!res.ok) throw new ProviderError("guardian", `The Guardian HTTP ${res.status}`, "http", res.status);
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== "object" || !data.response) throw new Error("unexpected shape");
    return data.response;
  } catch {
    throw new ProviderError("guardian", "The Guardian returned a non-JSON body: " + text.slice(0, 80), "non-json", res.status);
  }
}

/** Live blogs are rolling coverage, not disaster reporting: the API is asked for articles only, this is the local guard. */
const LIVE_BLOG_TITLE = /[–—-]\s*(as it happened|[a-z ]*live)\s*$/i;

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };

function stripHtml(s) {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&(#?\w+);/g, (m, e) => ENTITIES[e] ?? m)
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Guardian result -> article. The headline and link are kept exactly as
 * supplied; no image. Returns null for anything that is not a regular
 * article (type liveblog/gallery/interactive, "– as it happened" titles,
 * /live/ urls). `summary` (the standfirst, plain text) only serves the
 * relevance check and is never cached. `tagPlace` (countries/regions from
 * the keyword tags) only serves the location and is never cached either.
 */
export function normalizeGuardianResult(r) {
  const url = typeof r?.webUrl === "string" ? r.webUrl : "";
  const title = typeof r?.webTitle === "string" ? r.webTitle : "";
  if (!url || !title) return null;
  if (r.type && r.type !== "article") return null;
  if (LIVE_BLOG_TITLE.test(title) || /\/live\//.test(url)) return null;
  const d = new Date(r.webPublicationDate ?? "");
  return {
    title,
    url,
    domain: GUARDIAN_DOMAIN,
    publishedAt: Number.isNaN(d.getTime()) ? null : d.toISOString(),
    image: null,
    provider: "guardian",
    summary: stripHtml(r.fields?.trailText) || null,
    tagPlace: guardianTagPlace(r.tags),
  };
}

export function createGuardianProvider({
  apiKey,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  throttle = createThrottle({ minGapMs: GUARDIAN_MIN_GAP_MS }),
  backoff = createBackoffGate({ name: "The Guardian" }),
  now = () => new Date(),
} = {}) {
  if (!apiKey) throw new Error("createGuardianProvider: apiKey is required");

  async function search(q, pageSize) {
    const url = buildGuardianUrl({ q, apiKey, pageSize, now: now() });
    const response = await backoff.run(() => throttle(() => guardianRequest(url, { fetchImpl, timeoutMs })));
    const results = Array.isArray(response?.results) ? response.results : [];
    return results.map(normalizeGuardianResult).filter(Boolean);
  }

  return {
    name: "guardian",
    label: "The Guardian",
    refreshIntervalMs: GUARDIAN_REFRESH_INTERVAL_MS,
    retentionMs: GUARDIAN_RETENTION_MS,
    buildGroupQuery: buildGuardianGroupQuery,
    searchGroup: (group, { maxRecords = 20 } = {}) => search(buildGuardianGroupQuery(group), maxRecords),
    searchGeneral: ({ maxRecords = 15 } = {}) => search(GUARDIAN_GENERAL_QUERY, maxRecords),
    backoff,
  };
}
