/**
 * Module-level cache of the last /api/disasters result.
 *
 * The dashboard route unmounts when the user visits Alerts, Account or
 * Admin, so coming back (or following "Show on map" from the news panel on
 * one of those pages) used to start from the fallback rows and wait for a
 * fresh fetch before the map could fly anywhere. The cache survives route
 * changes for the life of the tab: the dashboard renders the last known
 * feed immediately and only re-fetches when it is older than FEED_FRESH_MS.
 */

/**
 * Per-source status reported by the backend: "ok" (answered), "stale" (down,
 * but its recent data is still served) or "error" (down, items dropped).
 */
export type FeedSourceStatus = "ok" | "stale" | "error";
export type FeedSources = { nasa: FeedSourceStatus; usgs: FeedSourceStatus };
/** ISO time of the data served per source (null when that source contributed nothing). */
export type FeedSourcesUpdatedAt = { nasa: string | null; usgs: string | null };

export type CachedFeed<T> = {
  items: T[];
  /** When the browser received it (drives the re-fetch decision only). */
  fetchedAt: number;
  /** When the data was fetched from the sources, as reported by the backend (ISO); drives every "ago" label. */
  updatedAt: string | null;
  /** The backend served older data because both sources failed. */
  stale: boolean;
  /** Which source answered; null when the backend did not say. */
  sources: FeedSources | null;
  sourcesUpdatedAt: FeedSourcesUpdatedAt | null;
};

export const FEED_FRESH_MS = 2 * 60_000;

let cached: CachedFeed<unknown> | null = null;

export function getCachedFeed<T>(): CachedFeed<T> | null {
  return cached as CachedFeed<T> | null;
}

export function setCachedFeed<T>(
  items: T[],
  {
    stale = false,
    sources = null as FeedSources | null,
    sourcesUpdatedAt = null as FeedSourcesUpdatedAt | null,
    updatedAt = null as string | null,
    fetchedAt = Date.now(),
  } = {}
) {
  cached = { items, fetchedAt, updatedAt, stale, sources, sourcesUpdatedAt };
}

/** True when the cache exists and is younger than FEED_FRESH_MS. */
export function isFeedFresh(now = Date.now()) {
  return cached !== null && now - cached.fetchedAt < FEED_FRESH_MS;
}
