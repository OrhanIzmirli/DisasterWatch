/**
 * Multi-source fusion: brings the confirming sources up to date and matches
 * them to the primary events (match.js). Never makes a request slower than
 * SOURCE_WAIT_MS: a source that has not answered by then is reported as
 * "pending" and joins on a later request; FIRMS is refreshed in the background
 * and only what it already knows is used.
 */
import { confirmingSources as defaultSources } from "../sources/index.js";
import { matchSources } from "./match.js";

export const SOURCE_WAIT_MS = 1500;
/** Wildfires whose last observation is older than this are not looked up in FIRMS (its window is 48 h). */
export const FIRMS_LOOKUP_MAX_AGE_MS = 72 * 3600_000;

const pending = { status: "pending", data: null, fetchedAt: null };

function within(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve) => (timer = setTimeout(() => resolve(pending), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * @param {object} [o]
 * @param {{ emsc, nhc, firms }} [o.sources] confirming sources (sources/index.js)
 */
export function createFusion({ sources = defaultSources, now = () => Date.now(), waitMs = SOURCE_WAIT_MS } = {}) {
  let last = null;

  /**
   * @param {object[]} events public v1 events (api/v1/events.js)
   * -> { matches: Map<eventId, { sources, ambiguous }>, status: { emsc, nhc, firms } }
   */
  async function fuse(events) {
    const [emsc, nhc] = await Promise.all([within(sources.emsc.get(), waitMs), within(sources.nhc.get(), waitMs)]);
    const t = now();
    const fires = events.filter((e) => e.type === "wildfire" && t - Date.parse(e.occurredAt) <= FIRMS_LOOKUP_MAX_AGE_MS);
    let firms = null;
    if (sources.firms.enabled) {
      sources.firms.refresh(fires).catch(() => {}); // background; failures are logged and backed off inside
      firms = sources.firms.peek(fires);
    }
    const firmsKey = firms ? [...firms].map(([id, v]) => `${id}:${v.count}:${v.fetchedAt}`).join("|") : "off";
    const status = { emsc: emsc.status, nhc: nhc.status, firms: firms ? (firms.size ? "ok" : "pending") : "off" };

    if (last && last.events === events && last.emsc === emsc.data && last.nhc === nhc.data && last.firmsKey === firmsKey) return { matches: last.matches, status };
    const matches = matchSources(events, { emsc: emsc.data, nhc: nhc.data, firms });
    last = { events, emsc: emsc.data, nhc: nhc.data, firmsKey, matches };
    return { matches, status };
  }

  return { fuse };
}

export const fusion = createFusion();
