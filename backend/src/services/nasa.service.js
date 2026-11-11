// backend/src/services/nasa.service.js
import { gdacsClient } from "./gdacs.js";

const NASA_EONET_URL =
  "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=30&limit=2000";

/** Download and parse limit: the answer is about 1.8 MB and the free plan's CPU is small. */
export const EONET_TIMEOUT_MS = 25_000;

async function downloadEonet({ fetchImpl = fetch, timeoutMs = EONET_TIMEOUT_MS } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(NASA_EONET_URL, { signal: controller.signal });

    if (!res.ok) {
      throw new Error(`NASA API request failed: ${res.status}`);
    }

    const data = await res.json();
    return Array.isArray(data?.events) ? data.events : [];
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One EONET download shared by every caller that asks while it runs (the ingestion job,
 * the dashboard feed and the storm list all start together when a sleeping service wakes).
 * Three parallel 1.8 MB downloads on the free plan's CPU used to push one of them past the
 * timeout ("This operation was aborted"), which failed the start-up ingestion. Each caller
 * gets its own copy of the events, because the GDACS rating attaches fields to them.
 */
export function createEonetFetcher({ download = downloadEonet } = {}) {
  let inflight = null;
  return async function fetchEvents() {
    if (!inflight) {
      inflight = download().finally(() => {
        inflight = null;
      });
    }
    return structuredClone(await inflight);
  };
}

export const fetchNasaEvents = createEonetFetcher();

/**
 * EONET events with the GDACS impact level attached (`event.gdacs`) for the
 * events that link to GDACS. The lookups are cached for hours and bounded by
 * a short timeout; when GDACS is unreachable the events are returned without
 * a level and the severity rules fall back to the EONET measurement.
 */
export async function fetchNasaEventsRated({ gdacs = gdacsClient, fetchEvents = fetchNasaEvents } = {}) {
  return gdacs.enrich(await fetchEvents());
}

/**
 * For the public feed: EONET events with the GDACS answers already known
 * (memory, or the durable store after a restart) attached at once; the
 * missing lookups run in the background and are attached to the same
 * array when they answer, so the feed's next request shows them. Until
 * then those events use the EONET measurement and point. The ingestion job
 * fetches the raw events and rates only the ones not yet recorded (it
 * records an event once and must wait for those lookups, jobs/ingest.js).
 */
export async function fetchNasaEventsFast({ gdacs = gdacsClient, fetchEvents = fetchNasaEvents, log = console } = {}) {
  const [events] = await Promise.all([fetchEvents(), gdacs.ensureLoaded()]);
  const missing = gdacs.attach(events);
  if (missing > 0) log.info?.(`[feed] ${missing} GDACS lookup(s) continue in the background`);
  // also when nothing is missing: answers older than the TTL are refreshed (known ones are cache hits)
  gdacs.enrich(events).catch((err) => log.warn(`[feed] background GDACS lookups failed: ${err?.message || err}`));
  return events;
}
