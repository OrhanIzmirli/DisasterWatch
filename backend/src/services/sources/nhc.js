/**
 * NOAA National Hurricane Center active storms (CurrentStorms.json), used to
 * confirm EONET severe storms in the basins the NHC covers: the Atlantic and the
 * eastern and central Pacific. Western Pacific and Indian Ocean storms have no
 * NHC entry, so their confidence comes from the other sources.
 *
 * Licence: NWS/NOAA information is public domain; it must not be presented as
 * NOAA-endorsed (https://www.weather.gov/disclaimer, read 2026-11-07). No key;
 * NWS asks clients to identify themselves with a User-Agent and to retry no more
 * often than once a minute. The file changes with each advisory (every 3-6 h),
 * so asking every NHC_TTL_MS is plenty.
 */
import { fetchJson } from "./sourceCache.js";

export const NHC_CURRENT_STORMS_URL = "https://www.nhc.noaa.gov/CurrentStorms.json";
export const NHC_TTL_MS = 10 * 60 * 1000;
export const NHC_USER_AGENT = "DisasterWatch/1.0 (+https://disasterwatch-frontend.onrender.com)";

/** NHC classification codes -> words. */
export const NHC_CLASSIFICATIONS = {
  TD: "Tropical Depression",
  STD: "Subtropical Depression",
  SD: "Subtropical Depression",
  TS: "Tropical Storm",
  STS: "Subtropical Storm",
  SS: "Subtropical Storm",
  HU: "Hurricane",
  MH: "Major Hurricane",
  PTC: "Potential Tropical Cyclone",
  PC: "Post-Tropical Cyclone",
};

/** ATCF basin prefix of the storm id ("al142026") -> basin. */
const BASINS = { al: "atlantic", ep: "eastern-pacific", cp: "central-pacific" };

export function basinOf(id) {
  return BASINS[String(id ?? "").slice(0, 2).toLowerCase()] ?? null;
}

export function normalizeNhcStorm(s) {
  const id = typeof s?.id === "string" ? s.id.toLowerCase() : null;
  const lat = Number(s?.latitudeNumeric);
  const lng = Number(s?.longitudeNumeric);
  const time = Date.parse(s?.lastUpdate);
  if (!id || !Number.isFinite(lat) || !Number.isFinite(lng) || !Number.isFinite(time)) return null;
  const code = String(s.classification ?? "").toUpperCase();
  const wind = Number(s.intensity);
  const pressure = Number(s.pressure);
  return {
    source: "nhc",
    sourceId: id,
    type: "storm",
    name: s.name ? String(s.name) : null,
    classification: code || null,
    classificationLabel: NHC_CLASSIFICATIONS[code] ?? (code || null),
    basin: basinOf(id),
    time,
    updatedAt: time,
    lat,
    lng,
    windKts: Number.isFinite(wind) && wind > 0 ? wind : null,
    pressureMb: Number.isFinite(pressure) && pressure > 0 ? pressure : null,
    url: typeof s.publicAdvisory?.url === "string" && s.publicAdvisory.url.startsWith("https://www.nhc.noaa.gov/") ? s.publicAdvisory.url : "https://www.nhc.noaa.gov/",
  };
}

export function normalizeNhc(payload) {
  return (Array.isArray(payload?.activeStorms) ? payload.activeStorms : []).map(normalizeNhcStorm).filter(Boolean);
}

export function createNhcFetcher({ fetchImpl, timeoutMs = 15_000 } = {}) {
  return async function fetchNhc() {
    const payload = await fetchJson(NHC_CURRENT_STORMS_URL, { timeoutMs, fetchImpl, label: "NHC", headers: { "User-Agent": NHC_USER_AGENT, Accept: "application/json" } });
    return normalizeNhc(payload);
  };
}
