/**
 * Confirming sources of the multi-source fusion, process-wide. They are fetched
 * lazily (when the feed asks for them), never on a timer: a sleeping free
 * instance sends nothing. FIRMS is looked up per wildfire (firms.js) and is
 * off until FIRMS_MAP_KEY is set. See docs/sources.md.
 */
import { createSourceCache } from "./sourceCache.js";
import { createEmscFetcher, EMSC_TTL_MS } from "./emsc.js";
import { createNhcFetcher, NHC_TTL_MS } from "./nhc.js";
import { createFirmsLookup } from "./firms.js";

/**
 * DISABLE_FUSION_SOURCES=1 switches every confirming source off (operations escape hatch);
 * they are also off under NODE_ENV=test, so no test reaches a real source.
 */
const disabled = process.env.DISABLE_FUSION_SOURCES === "1" || process.env.NODE_ENV === "test";

export function createConfirmingSources({ fetchImpl, now, log, enabled = !disabled, firmsMapKey = process.env.FIRMS_MAP_KEY } = {}) {
  return {
    emsc: createSourceCache({ name: "EMSC", fetch: createEmscFetcher({ fetchImpl, now }), ttlMs: EMSC_TTL_MS, enabled, now, log }),
    nhc: createSourceCache({ name: "NHC", fetch: createNhcFetcher({ fetchImpl }), ttlMs: NHC_TTL_MS, enabled, now, log }),
    // per wildfire, in the background (peek/refresh); off without FIRMS_MAP_KEY
    firms: createFirmsLookup({ mapKey: enabled ? firmsMapKey : undefined, fetchImpl, now, log }),
  };
}

export const confirmingSources = createConfirmingSources();

/** { emsc: {...}, nhc: {...} } for /health. */
export function confirmingSourcesStatus(sources = confirmingSources) {
  return Object.fromEntries(Object.entries(sources).map(([key, s]) => [key, s.status()]));
}
