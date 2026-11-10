/**
 * The dashboard feed response (GET /disasters), computed when the data changes
 * instead of on every request.
 *
 * A request used to normalise every event of the window, attach the fusion
 * scores and serialise about 250 KB of JSON, each time. Now:
 *
 *  - getFeed() returns the same result object while the source data, the
 *    parameters and the minute are unchanged (feed.service.js);
 *  - the scores are attached once per feed result and fusion result
 *    (fusion/feed.js, createFeedAnnotator);
 *  - the JSON body and its ETag are produced once per scored result (here),
 *    so a request only sends a ready string, or a 304 when the browser
 *    already holds it.
 *
 * The warmer (startFeedWarmer) runs once a minute while the process is up:
 * it refreshes the sources ahead of their cache expiry (feedService.prefetch)
 * and builds the dashboard's response right away, so the work happens when
 * data arrives and a request never waits for NASA, USGS or the scoring. It
 * also starts at boot: a service woken by the scheduled wake-up or a first
 * visitor begins fetching before the first feed request comes in.
 */
import crypto from "node:crypto";
import { feedService as defaultFeed, FEED_PARAM_LIMITS, FeedUnavailableError } from "./feed.service.js";
import { createFeedAnnotator } from "./fusion/feed.js";

/** What the dashboard asks for (/api/disasters?limit=200); the warmer keeps exactly this one ready. */
export const DASHBOARD_PARAMS = Object.freeze({
  minutesWindow: FEED_PARAM_LIMITS.minutes.fallback,
  limit: FEED_PARAM_LIMITS.limit.max,
  minMag: FEED_PARAM_LIMITS.minMag.fallback,
});

export const WARM_INTERVAL_MS = 60 * 1000;

/**
 * -> { get(params) -> { body, etag, feed } }
 * body: the JSON text of the scored feed; etag: a strong validator of that text.
 * Throws what getFeed throws (FeedUnavailableError when nothing can be served).
 */
export function createFeedView({ feedService = defaultFeed, annotate = createFeedAnnotator({ feedService }) } = {}) {
  const serialised = new WeakMap(); // scored feed -> { body, etag }

  async function get(params = DASHBOARD_PARAMS) {
    const feed = await annotate(await feedService.getFeed(params));
    let out = serialised.get(feed);
    if (!out) {
      const body = JSON.stringify(feed);
      out = { body, etag: `"${crypto.createHash("sha1").update(body).digest("base64url")}"` };
      serialised.set(feed, out);
    }
    return { ...out, feed };
  }

  return { get };
}

/** Process-wide view used by the route and the warmer. */
export const feedView = createFeedView();

/**
 * Starts the warmer: now, then every `intervalMs`. Each tick refreshes the sources that
 * are close to expiry and rebuilds the dashboard response if anything changed. Never
 * throws; a tick that finds no data at all (both sources down at boot) just waits for
 * the next one. -> { stop, tick }
 */
export function startFeedWarmer({ feedService = defaultFeed, view = feedView, intervalMs = WARM_INTERVAL_MS, params = DASHBOARD_PARAMS, log = console } = {}) {
  let running = null;
  const tick = () => {
    if (running) return running; // a slow tick (cold upstreams) is not stacked
    running = (async () => {
      try {
        await feedService.prefetch();
        await view.get(params);
      } catch (err) {
        if (!(err instanceof FeedUnavailableError)) log.error("[feed] warm-up failed:", err?.message || err);
      } finally {
        running = null;
      }
    })();
    return running;
  };
  tick();
  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  return { stop: () => clearInterval(timer), tick };
}
