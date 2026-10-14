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
import { GENERAL_QUERY, normalizeArticle, placeTokens } from "../newsLinking.js";

export const GDELT_REFRESH_INTERVAL_MS = 15 * 60 * 1000;

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
  const normalize = (raw) => raw.map(normalizeArticle).filter(Boolean).map((a) => ({ ...a, provider: "gdelt" }));
  return {
    name: "gdelt",
    label: "GDELT",
    refreshIntervalMs: GDELT_REFRESH_INTERVAL_MS,
    /** GDELT content is not licence-limited; rows stay until the next successful refresh. */
    retentionMs: null,
    buildGroupQuery: buildGdeltGroupQuery,
    async searchGroup(group, { maxRecords = 25 } = {}) {
      return normalize(await client.searchArticles({ query: buildGdeltGroupQuery(group), timespan, maxRecords }));
    },
    async searchGeneral({ maxRecords = 15 } = {}) {
      return normalize(await client.searchArticles({ query: `${GENERAL_QUERY} sourcelang:english`, timespan, maxRecords }));
    },
  };
}
