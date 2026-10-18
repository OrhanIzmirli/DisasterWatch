/**
 * GDELT DOC 2.0 as a news provider (primary).
 *
 * One request per search-plan group: the group's hazard words and all of
 * its places are OR-ed into a single GDELT query, so a refresh costs at most
 * MAX_EVENT_QUERIES + 1 requests instead of one per event. GDELT's query
 * language has no nesting: terms outside parentheses are AND-ed, "OR" only
 * works inside one pair of parentheses, phrases are quoted.
 */
import { createGdeltClient } from "../gdelt.js";
import { GENERAL_QUERY, normalizeArticle, placeTokens, withUrlDate } from "../newsLinking.js";

export const GDELT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
/** Articles are searched over the last 72 h, so they are kept at most that long. */
export const GDELT_RETENTION_MS = 72 * 60 * 60 * 1000;
/**
 * GDELT answers most requests with 429 whatever our own pace (measured
 * 2026-10-16: 2 of 12 requests answered, 45-60 s apart, from a residential
 * IP), and the first 429 closes the backoff gate for the rest of a refresh.
 * So each refresh spends its one realistic chance on a single broad request:
 * no per-type group searches, one general search with more records, linked
 * to the feed events on our side.
 */
export const GDELT_GROUP_SEARCHES = 0;
export const GDELT_GENERAL_RECORDS = 75;

function orGroup(terms) {
  const quoted = terms.map((t) => (t.includes(" ") ? `"${t}"` : t));
  return quoted.length === 1 ? quoted[0] : `(${quoted.join(" OR ")})`;
}

/** Place words of every event in the group, OR-ed: (kushiro OR japan OR nepal). */
export function placeTermsOf(group) {
  const words = new Set();
  for (const place of group.places) for (const w of placeTokens(place)) words.add(w);
  return [...words];
}

/** "(earthquake OR quake OR tremor) (kushiro OR japan OR kokopo OR papua OR guinea) sourcelang:english" */
export function buildGdeltGroupQuery(group) {
  const places = placeTermsOf(group);
  const placePart = places.length ? ` ${orGroup(places)}` : "";
  return `${orGroup(group.terms)}${placePart} sourcelang:english`;
}

export function createGdeltProvider({ client = createGdeltClient(), timespan = "72h" } = {}) {
  // publishedAt: the URL's publication day when it is earlier than GDELT's seen date (see withUrlDate)
  const normalize = (raw) => raw.map(normalizeArticle).filter(Boolean).map((a) => ({ ...withUrlDate(a), provider: "gdelt" }));
  return {
    name: "gdelt",
    label: "GDELT",
    refreshIntervalMs: GDELT_REFRESH_INTERVAL_MS,
    /** Not licence-limited; kept for the 72 h search window (or until GDELT succeeds again). */
    retentionMs: GDELT_RETENTION_MS,
    maxGroupSearches: GDELT_GROUP_SEARCHES,
    buildGroupQuery: buildGdeltGroupQuery,
    async searchGroup(group, { maxRecords = 25 } = {}) {
      return normalize(await client.searchArticles({ query: buildGdeltGroupQuery(group), timespan, maxRecords }));
    },
    async searchGeneral({ maxRecords = 15 } = {}) {
      const records = Math.max(maxRecords, GDELT_GENERAL_RECORDS);
      return normalize(await client.searchArticles({ query: `${GENERAL_QUERY} sourcelang:english`, timespan, maxRecords: records }));
    },
  };
}
