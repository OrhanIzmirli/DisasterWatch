/**
 * Which named storms are current, for the news relevance rule that drops
 * articles about other (past) storms: storms that are open in EONET or were
 * closed in the last 14 days.
 *
 * The list comes from EONET itself (open and closed events of the last 30
 * days carry their `closed` date), so it survives a restart: after one the
 * first refresh simply asks EONET again. The answer is cached for an hour;
 * when EONET cannot be reached the last answer is used for up to 6 hours,
 * after that (or with nothing cached) names() resolves to null and the rule
 * is skipped rather than guessed.
 *
 *   createStormContext({ fetchEvents, now, log }).names() -> Promise<Set<string> | null>
 */
import { fetchNasaEvents } from "./nasa.service.js";
import { stormNamesIn } from "./newsRelevance.js";

export const RECENTLY_CLOSED_MS = 14 * 24 * 3600 * 1000;
export const STORM_CACHE_MS = 60 * 60 * 1000;
export const STORM_STALE_MAX_MS = 6 * 60 * 60 * 1000;

const isStorm = (event) => (event?.categories ?? []).some((c) => c?.id === "severeStorms");

/** Names of EONET storms that are open or were closed within `recentMs` of `at`. */
export function currentStormNames(events, at = new Date(), recentMs = RECENTLY_CLOSED_MS) {
  const names = new Set();
  for (const event of events ?? []) {
    if (!isStorm(event)) continue;
    if (event.closed) {
      const closed = new Date(event.closed).getTime();
      if (!Number.isFinite(closed) || at.getTime() - closed > recentMs) continue;
    }
    for (const name of stormNamesIn(event.title)) names.add(name);
  }
  return names;
}

export function createStormContext({ fetchEvents = fetchNasaEvents, now = () => new Date(), log = console } = {}) {
  let cached = null; // { names, at }

  async function names() {
    const at = now();
    if (cached && at.getTime() - cached.at.getTime() < STORM_CACHE_MS) return cached.names;
    try {
      cached = { names: currentStormNames(await fetchEvents(), at), at };
      return cached.names;
    } catch (err) {
      if (cached && at.getTime() - cached.at.getTime() < STORM_STALE_MAX_MS) {
        log.warn(`[news] storm list: EONET failed (${err?.message || err}); using the list from ${cached.at.toISOString()}`);
        return cached.names;
      }
      log.warn(`[news] storm list: EONET failed (${err?.message || err}); the past-storm rule is skipped`);
      return null;
    }
  }

  return { names };
}
