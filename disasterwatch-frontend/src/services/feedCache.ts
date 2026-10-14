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

export type CachedFeed<T> = { items: T[]; fetchedAt: number };

export const FEED_FRESH_MS = 2 * 60_000;

let cached: CachedFeed<unknown> | null = null;

export function getCachedFeed<T>(): CachedFeed<T> | null {
  return cached as CachedFeed<T> | null;
}

export function setCachedFeed<T>(items: T[], fetchedAt = Date.now()) {
  cached = { items, fetchedAt };
}

/** True when the cache exists and is younger than FEED_FRESH_MS. */
export function isFeedFresh(now = Date.now()) {
  return cached !== null && now - cached.fetchedAt < FEED_FRESH_MS;
}

/** Minutes since the cached feed was fetched (0 without a cache). */
export function cachedFeedAgeMinutes(now = Date.now()) {
  return cached ? Math.floor((now - cached.fetchedAt) / 60_000) : 0;
}
