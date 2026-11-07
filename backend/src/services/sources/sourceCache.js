/**
 * Cache for one confirming source of the multi-source fusion (EMSC, NHC, FIRMS).
 *
 *  - get() serves the cached data while it is younger than ttlMs; after that the
 *    next caller refreshes it (lazily: a sleeping free instance sends nothing);
 *  - one upstream request at a time: concurrent callers await the same promise;
 *  - the fetcher receives the previous data and its time, so a source can ask
 *    only for what changed (EMSC's updatedafter) and merge;
 *  - a failure keeps serving the last good data while it is at most staleMaxMs
 *    old (status "stale"), then nothing (status "error"); after a failure the
 *    source is not asked again before the backoff gate (backoff.js) reopens;
 *  - disabled sources (no key configured) answer status "off" and never fetch.
 *
 * Confirming sources only add confidence: when one is missing, the primary
 * events (USGS, EONET) are served exactly as before.
 */
import { createBackoffGate, BackoffError } from "../backoff.js";

export const SOURCE_STATES = ["ok", "stale", "error", "off", "empty"];

/**
 * @param {object} o
 * @param {string} o.name
 * @param {(prev: { data: any, fetchedAt: number } | null) => Promise<any>} o.fetch
 * @param {number} o.ttlMs data younger than this is served without asking the source
 * @param {number} [o.staleMaxMs] last good data is served this long after failures
 * @param {boolean} [o.enabled]
 */
export function createSourceCache({ name, fetch, ttlMs, staleMaxMs = 6 * 60 * 60 * 1000, enabled = true, now = () => Date.now(), log = console, backoff } = {}) {
  const gate = backoff ?? createBackoffGate({ name, baseMs: 60_000, maxMs: 30 * 60_000, now });
  let data = null;
  let fetchedAt = 0;
  let lastError = null;
  let lastErrorAt = 0;
  let inflight = null;

  function refresh() {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const next = await gate.run(() => fetch(data === null ? null : { data, fetchedAt }));
        data = next;
        fetchedAt = now();
        lastError = null;
      } catch (err) {
        if (!(err instanceof BackoffError)) {
          lastError = err?.message || String(err);
          lastErrorAt = now();
          log.warn(`[sources] ${name} fetch failed: ${lastError}`);
        }
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  /** -> { status, data, fetchedAt } (data null unless status is "ok" or "stale") */
  async function get() {
    if (!enabled) return { status: "off", data: null, fetchedAt: null };
    if (data === null || now() - fetchedAt >= ttlMs) await refresh();
    if (data === null) return { status: lastError ? "error" : "empty", data: null, fetchedAt: null };
    const age = now() - fetchedAt;
    if (age < ttlMs) return { status: "ok", data, fetchedAt };
    if (age <= staleMaxMs) return { status: "stale", data, fetchedAt };
    return { status: "error", data: null, fetchedAt: null };
  }

  /** Times and counts for /health (no upstream error text: it may carry URLs or keys). */
  function status() {
    return {
      enabled,
      fetchedAt: fetchedAt ? new Date(fetchedAt).toISOString() : null,
      items: Array.isArray(data) ? data.length : null,
      lastErrorAt: lastErrorAt ? new Date(lastErrorAt).toISOString() : null,
      failing: lastError !== null,
    };
  }

  /** Forgets everything (tests only). */
  function reset() {
    data = null;
    fetchedAt = 0;
    lastError = null;
    lastErrorAt = 0;
    inflight = null;
    gate.success();
  }

  return { name, get, status, reset, get enabled() { return enabled; } };
}

/** fetch() with a timeout; throws on a non-2xx answer. */
export async function fetchJson(url, { timeoutMs = 15_000, headers = {}, fetchImpl = globalThis.fetch, label = "source" } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, { headers, signal: controller.signal });
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (err?.name === "AbortError") throw new Error(`${label} timed out after ${timeoutMs} ms`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
