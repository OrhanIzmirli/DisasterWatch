// backend/src/services/nasa.service.js
import { gdacsClient } from "./gdacs.js";

const NASA_EONET_URL =
  "https://eonet.gsfc.nasa.gov/api/v3/events?status=all&days=30&limit=2000";

export async function fetchNasaEvents() {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(NASA_EONET_URL, { signal: controller.signal });

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
 * keeps fetchNasaEventsRated: it records an event once and must wait.
 */
export async function fetchNasaEventsFast({ gdacs = gdacsClient, fetchEvents = fetchNasaEvents, log = console } = {}) {
  const [events] = await Promise.all([fetchEvents(), gdacs.ensureLoaded()]);
  const missing = gdacs.attach(events);
  if (missing > 0) log.info?.(`[feed] ${missing} GDACS lookup(s) continue in the background`);
  // also when nothing is missing: answers older than the TTL are refreshed (known ones are cache hits)
  gdacs.enrich(events).catch((err) => log.warn(`[feed] background GDACS lookups failed: ${err?.message || err}`));
  return events;
}
