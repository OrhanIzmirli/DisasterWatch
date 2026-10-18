/**
 * Which named storms are current, for the news relevance rule that drops
 * articles about other (past) storms. Two sources, united:
 *
 *  - NASA EONET: storms that are open or were closed in the last 14 days
 *    (open and closed events of the last 30 days carry their `closed` date);
 *  - GDACS: tropical cyclones that are current or ended in the last 14 days
 *    (its event list covers basins EONET lists late or not at all).
 *
 * Both lists come from the sources themselves, so they survive a restart:
 * after one the first refresh simply asks again. EONET's answer is cached for
 * an hour (its open storms also reach the rule fresh through the feed on every
 * refresh); GDACS's for 15 minutes, one news refresh, so a cyclone GDACS has
 * just started is known by the next refresh. When a source cannot be reached
 * its last answer is used for up to 6 hours. When one source is unknown the other alone decides; when both are
 * unknown names() resolves to null and the rule is skipped rather than guessed.
 *
 *   createStormContext({ fetchEvents, fetchCyclones, now, log }).names() -> Promise<Set<string> | null>
 */
import { fetchNasaEvents } from "./nasa.service.js";
import { gdacsClient } from "./gdacs.js";
import { stormNamesIn } from "./newsRelevance.js";

export const RECENTLY_CLOSED_MS = 14 * 24 * 3600 * 1000;
export const STORM_CACHE_MS = 60 * 60 * 1000;
export const CYCLONE_CACHE_MS = 15 * 60 * 1000;
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

/** Names of GDACS tropical cyclones that are current or ended within `recentMs` of `at`. */
export function currentCycloneNames(cyclones, at = new Date(), recentMs = RECENTLY_CLOSED_MS) {
  const names = new Set();
  for (const c of cyclones ?? []) {
    const ended = c.endedAt ? new Date(c.endedAt).getTime() : NaN;
    if (c.current || (Number.isFinite(ended) && at.getTime() - ended <= recentMs)) names.add(c.name);
  }
  return names;
}

/** EONET's full event list (any category); no events at all is a broken answer, not "no storms". */
async function eonetStormNames(fetchEvents, at) {
  const events = await fetchEvents();
  if (!Array.isArray(events) || events.length === 0) throw new Error("EONET returned no events");
  return currentStormNames(events, at);
}

async function gdacsCycloneNames(fetchCyclones, at) {
  return currentCycloneNames(await fetchCyclones({ from: new Date(at.getTime() - RECENTLY_CLOSED_MS), to: at }), at);
}

export function createStormContext({
  fetchEvents = fetchNasaEvents,
  fetchCyclones = (range) => gdacsClient.listTropicalCyclones(range),
  now = () => new Date(),
  log = console,
} = {}) {
  /** One source with its own cache: its names, or null when unknown. */
  function source(label, load, cacheMs) {
    let cached = null; // { names, at }
    return async (at) => {
      if (cached && at.getTime() - cached.at.getTime() < cacheMs) return cached.names;
      try {
        cached = { names: await load(at), at };
        return cached.names;
      } catch (err) {
        if (cached && at.getTime() - cached.at.getTime() < STORM_STALE_MAX_MS) {
          log.warn(`[news] storm list: ${label} failed (${err?.message || err}); using its list from ${cached.at.toISOString()}`);
          return cached.names;
        }
        log.warn(`[news] storm list: ${label} failed (${err?.message || err}); no ${label} list`);
        return null;
      }
    };
  }

  const eonet = source("EONET", (at) => eonetStormNames(fetchEvents, at), STORM_CACHE_MS);
  const gdacs = source("GDACS", (at) => gdacsCycloneNames(fetchCyclones, at), CYCLONE_CACHE_MS);

  async function names() {
    const at = now();
    const lists = (await Promise.all([eonet(at), gdacs(at)])).filter(Boolean);
    if (!lists.length) {
      log.warn("[news] storm list: neither EONET nor GDACS known; the past-storm rule is skipped");
      return null;
    }
    return new Set(lists.flatMap((l) => [...l]));
  }

  return { names };
}
