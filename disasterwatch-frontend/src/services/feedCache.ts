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

/**
 * The rating thresholds the backend serves with the feed (backend/src/utils/severity.js):
 * for each measured quantity the lower bound of "medium" and "high" and the display step.
 */
export type SeverityThreshold = { basis: string; unit: string; medium: number; high: number; step: number };
export type SeverityRules = {
  earthquake: SeverityThreshold;
  wildfire: SeverityThreshold;
  storm: SeverityThreshold;
  gdacs: { levels: Record<string, "low" | "medium" | "high">; appliesTo: string[] };
};

/** Accepts the served rules only when every part has the expected shape. */
export function readSeverityRules(raw: unknown): SeverityRules | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const threshold = (v: unknown): v is SeverityThreshold => {
    const t = v as Record<string, unknown> | null;
    return Boolean(t) && [t!.medium, t!.high, t!.step].every((n) => typeof n === "number" && Number.isFinite(n));
  };
  const gdacs = r.gdacs as { levels?: unknown } | undefined;
  if (!threshold(r.earthquake) || !threshold(r.wildfire) || !threshold(r.storm)) return null;
  if (!gdacs || !gdacs.levels || typeof gdacs.levels !== "object") return null;
  return raw as SeverityRules;
}

/**
 * Where the items on screen came from: "live" (this page's request to the backend),
 * "saved" (this browser's copy of the last live answer) or "snapshot" (the copy the
 * scheduled wake-up publishes). Only "live" data is called live on the page.
 */
export type FeedOrigin = "live" | "saved" | "snapshot";

export type CachedFeed<T> = {
  items: T[];
  origin: FeedOrigin;
  /** The backend's whole-window counts (KPIs); null when not sent. */
  counts: unknown;
  /** When the browser received it (drives the re-fetch decision only). */
  fetchedAt: number;
  /** When the data was fetched from the sources, as reported by the backend (ISO); drives every "ago" label. */
  updatedAt: string | null;
  /** The backend served older data because both sources failed. */
  stale: boolean;
  /** Which source answered; null when the backend did not say. */
  sources: FeedSources | null;
  sourcesUpdatedAt: FeedSourcesUpdatedAt | null;
  /** Rating thresholds served with this feed; null from an older backend. */
  severityRules: SeverityRules | null;
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
    severityRules = null as SeverityRules | null,
    fetchedAt = Date.now(),
    origin = "live" as FeedOrigin,
    counts = null as unknown,
  } = {}
) {
  cached = { items, fetchedAt, updatedAt, stale, sources, sourcesUpdatedAt, severityRules, origin, counts };
}

/** True when the cache exists and is younger than FEED_FRESH_MS. */
export function isFeedFresh(now = Date.now()) {
  return cached !== null && now - cached.fetchedAt < FEED_FRESH_MS;
}
