/**
 * GDELT DOC 2.0 client.
 *
 * GDELT is slow and strict: it wants at least 5 seconds between requests
 * and answers rate-limit violations with HTTP 429 and a plain-text body
 * (not JSON). Everything here is defensive:
 *  - one request at a time, spaced >= MIN_GAP_MS apart (global throttle);
 *  - AbortController timeout (default 8 s);
 *  - non-JSON or non-2xx responses throw a typed GdeltError;
 *  - after a failure (429 above all) the client backs off exponentially
 *    with jitter (src/services/backoff.js): calls made while the backoff
 *    window is open fail at once with kind "backoff" and send nothing.
 *
 * `fetchImpl`, `now`/`sleep` and the backoff gate are injectable for tests.
 */
import { createBackoffGate } from "./backoff.js";

export const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";
export const MIN_GAP_MS = 5000;
export const DEFAULT_TIMEOUT_MS = Number(process.env.GDELT_TIMEOUT_MS) || 8000;

export class GdeltError extends Error {
  constructor(message, kind, status = null) {
    super(message);
    this.name = "GdeltError";
    this.kind = kind; // "timeout" | "rate-limit" | "http" | "non-json" | "network" | "backoff"
    this.status = status;
  }
}

/** Serialises calls and enforces the minimum gap between them. */
export function createThrottle({ minGapMs = MIN_GAP_MS, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let chain = Promise.resolve();
  let lastStart = null; // no request yet: the first one never waits

  return function throttled(fn) {
    const run = async () => {
      const wait = lastStart === null ? 0 : lastStart + minGapMs - now();
      if (wait > 0) await sleep(wait);
      lastStart = now();
      return fn();
    };
    const result = chain.then(run, run);
    chain = result.catch(() => {});
    return result;
  };
}

/** Builds the DOC API URL for an article-list query. */
export function buildGdeltUrl({ query, timespan = "72h", maxRecords = 25, sort = "DateDesc" }) {
  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    timespan,
    maxrecords: String(maxRecords),
    sort,
  });
  return `${GDELT_ENDPOINT}?${params.toString()}`;
}

/**
 * Performs one request. Returns the parsed JSON object (GDELT answers `{}`
 * when nothing matched). Throws GdeltError on timeout, 429, other HTTP
 * errors, network failure or a non-JSON body.
 */
export async function gdeltRequest(url, { fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetchImpl(url, { signal: controller.signal, headers: { Accept: "application/json" } });
  } catch (err) {
    if (err?.name === "AbortError") throw new GdeltError(`GDELT timed out after ${timeoutMs} ms`, "timeout");
    throw new GdeltError(`GDELT network error: ${err?.message || err}`, "network");
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text().catch(() => "");

  if (res.status === 429) {
    throw new GdeltError("GDELT rate limit (429): " + text.slice(0, 80), "rate-limit", 429);
  }
  if (!res.ok) {
    throw new GdeltError(`GDELT HTTP ${res.status}`, "http", res.status);
  }

  try {
    const data = JSON.parse(text);
    if (data === null || typeof data !== "object") throw new Error("not an object");
    return data;
  } catch {
    throw new GdeltError("GDELT returned a non-JSON body: " + text.slice(0, 80), "non-json", res.status);
  }
}

/**
 * Convenience: throttled, backoff-guarded article search. Returns the raw
 * `articles` array (empty when GDELT answers `{}`).
 */
export function createGdeltClient({
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  throttle = createThrottle(),
  backoff = createBackoffGate({ name: "GDELT" }),
} = {}) {
  return {
    async searchArticles(options) {
      const url = buildGdeltUrl(options);
      // The gate is checked before queueing so a closed window costs no waiting.
      const data = await backoff.run(() => throttle(() => gdeltRequest(url, { fetchImpl, timeoutMs })));
      return Array.isArray(data?.articles) ? data.articles : [];
    },
    backoff,
  };
}
