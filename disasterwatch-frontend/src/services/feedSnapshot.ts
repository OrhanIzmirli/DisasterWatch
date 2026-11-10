/**
 * The last good feed, kept so the dashboard can show real data at once while
 * the backend (free plan, asleep after 15 idle minutes) wakes up:
 *
 *  - "saved":    this browser's copy of the last live answer (localStorage);
 *  - "snapshot": the copy the scheduled wake-up publishes (.github/workflows/wake.yml,
 *                served by the site at SNAPSHOT_URL). Asked for only when the live
 *                request has not answered within SNAPSHOT_DELAY_MS, or failed with
 *                nothing on screen, so an awake backend costs no extra request.
 *
 * Both carry the backend's own `updatedAt`, so every "ago" label stays honest, and
 * the page calls neither of them live (DashboardPage: origin). The live answer
 * replaces them as soon as it arrives. A copy is used only when it is complete
 * (no failed source, not stale) and at most SAVED_FEED_MAX_AGE_MS old.
 * Nothing personal is stored: the feed is the same public data for everyone.
 */
import { readSeverityRules, getCachedFeed, setCachedFeed, type CachedFeed, type FeedOrigin, type FeedSources, type FeedSourcesUpdatedAt } from "./feedCache";

export const SAVED_FEED_KEY = "dw.feed.v1";
export const SAVED_FEED_MAX_AGE_MS = 48 * 3600_000;
export const SNAPSHOT_URL = "/snapshot/feed.json";
export const SNAPSHOT_DELAY_MS = 1500;

/** Narrows the backend's `sources` field; anything unexpected counts as "not reported". */
export const readSources = (raw: unknown): FeedSources | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const ok = (v: unknown): v is "ok" | "stale" | "error" => v === "ok" || v === "stale" || v === "error";
  return ok(r.nasa) && ok(r.usgs) ? { nasa: r.nasa, usgs: r.usgs } : null;
};

/** Narrows the backend's `sourcesUpdatedAt` field (ISO strings or null per source). */
export const readSourcesUpdatedAt = (raw: unknown): FeedSourcesUpdatedAt | null => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const t = (v: unknown) => (typeof v === "string" && !Number.isNaN(new Date(v).getTime()) ? v : null);
  return { nasa: t(r.nasa), usgs: t(r.usgs) };
};

/** ISO string or null; used for the backend's `updatedAt`. */
export const readIso = (raw: unknown): string | null => (typeof raw === "string" && !Number.isNaN(new Date(raw).getTime()) ? raw : null);

/** A GET /api/disasters body -> cache entry, or null when it holds no item list. */
export function feedFromResponse<T>(data: unknown, origin: FeedOrigin, fetchedAt = Date.now()): CachedFeed<T> | null {
  if (!data || typeof data !== "object") return null;
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.items)) return null;
  return {
    items: d.items as T[],
    origin,
    fetchedAt,
    updatedAt: readIso(d.updatedAt),
    stale: Boolean(d.stale),
    sources: readSources(d.sources),
    sourcesUpdatedAt: readSourcesUpdatedAt(d.sourcesUpdatedAt),
    severityRules: readSeverityRules(d.severityRules),
    counts: d.counts ?? null,
  };
}

/** A copy worth showing: complete, not stale, dated, and recent. */
function usable<T>(feed: CachedFeed<T> | null, now: number): feed is CachedFeed<T> {
  if (!feed || feed.items.length === 0 || feed.stale || !feed.updatedAt) return false;
  if (feed.sources && (feed.sources.nasa !== "ok" || feed.sources.usgs !== "ok")) return false;
  const at = Date.parse(feed.updatedAt);
  return now - at <= SAVED_FEED_MAX_AGE_MS && at <= now + 5 * 60_000;
}

/** Keeps a live answer for the next visit (only a complete one; storage errors are ignored). */
export function saveFeed(data: unknown, now = Date.now()): void {
  if (!usable(feedFromResponse(data, "live"), now)) return;
  try {
    localStorage.setItem(SAVED_FEED_KEY, JSON.stringify(data));
  } catch {
    /* private mode or full storage: the next visit just starts empty */
  }
}

/** This browser's copy of the last live answer, or null. Never counts as fresh (fetchedAt 0). */
export function readSavedFeed<T>(now = Date.now()): CachedFeed<T> | null {
  try {
    const raw = localStorage.getItem(SAVED_FEED_KEY);
    const feed = raw ? feedFromResponse<T>(JSON.parse(raw), "saved", 0) : null;
    return usable(feed, now) ? feed : null;
  } catch {
    return null;
  }
}

/** The published snapshot, or null (missing, not JSON, too old, or the request failed). */
export async function fetchSnapshot<T>(signal?: AbortSignal, now = Date.now()): Promise<CachedFeed<T> | null> {
  try {
    const res = await fetch(SNAPSHOT_URL, { signal, headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    // the file may come as text/plain; the site's HTML fallback simply fails to parse
    const feed = feedFromResponse<T>(JSON.parse(await res.text()), "snapshot", 0);
    return usable(feed, now) ? feed : null;
  } catch {
    return null;
  }
}

/** True when `copy` would show newer data than `current` (or anything at all when nothing is shown). */
export function isNewer<T>(copy: CachedFeed<T>, current: CachedFeed<T> | null): boolean {
  if (!current || current.items.length === 0 || !current.updatedAt) return true;
  return Date.parse(copy.updatedAt ?? "") > Date.parse(current.updatedAt);
}

/** Puts a cache entry into the tab's feed cache. */
export function cacheFeed<T>(feed: CachedFeed<T>): void {
  setCachedFeed(feed.items, feed);
}

/**
 * Before the dashboard's first render: when the tab holds no feed yet, the saved copy
 * (if any) becomes the starting point, so a returning visitor sees data immediately.
 */
export function primeFromSaved(): void {
  if (getCachedFeed()) return;
  const saved = readSavedFeed();
  if (saved) cacheFeed(saved);
}
