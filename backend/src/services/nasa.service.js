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
export async function fetchNasaEventsRated({ gdacs = gdacsClient } = {}) {
  return gdacs.enrich(await fetchNasaEvents());
}
