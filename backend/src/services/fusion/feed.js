/**
 * Scores for the dashboard feed (GET /disasters).
 *
 * Each feed item gets a compact `scores` field, { confidence, priority,
 * confirmations } or null, so the map and the list can size, outline, filter
 * and sort by them without making the feed much larger. The terms behind a
 * score ("why") are fetched by the event drawer from the public API
 * (GET /api/v1/disasters/{id}), which carries them in full.
 *
 * The scores come from the same fusion and the same public events as API v1
 * (shared event cache), so the dashboard and the API never disagree.
 */
import { feedService as defaultFeed } from "../feed.service.js";
import { sharedEventsFor } from "../../api/v1/events.js";
import { fusion as defaultFusion } from "./index.js";
import { SCORE_VERSION } from "./scores.js";

/** Feed item -> public v1 id ("usgs:us7000abcd", "eonet:EONET_1234"), or null. */
export function v1IdOf(item) {
  const id = item?.details?.eventId;
  if (typeof id !== "string") return null;
  if (id.startsWith("usgs:")) return id;
  if (id.startsWith("nasa:")) return `eonet:${id.slice(5)}`;
  return null;
}

/**
 * @param {object} feed getFeed() result
 * -> the same feed with items[].scores and top-level scoring { version, status }
 */
export async function annotateFeed(feed, { feedService = defaultFeed, fusion = defaultFusion, eventsFor = sharedEventsFor, now = () => Date.now(), log = console } = {}) {
  try {
    const snap = await feedService.snapshot();
    const { matches, scores, status } = await fusion.fuse(eventsFor(snap.served, now()));
    const items = feed.items.map((item) => {
      const id = v1IdOf(item);
      const sc = id ? scores.get(id) : undefined;
      const confirmations = id ? (matches.get(id)?.sources ?? []).filter((s) => s.role === "confirming").length : 0;
      return { ...item, scores: sc ? { confidence: sc.confidence.score, priority: sc.priority.score, confirmations } : null };
    });
    return { ...feed, items, scoring: { version: SCORE_VERSION, status } };
  } catch (err) {
    log.error("[feed] scores unavailable:", err?.message || err);
    return { ...feed, items: feed.items.map((item) => ({ ...item, scores: null })), scoring: { version: SCORE_VERSION, status: { emsc: "error", nhc: "error", firms: "error" } } };
  }
}
