/**
 * Rich, source-faithful details for a feed item. Everything here comes from
 * the NASA EONET / USGS payloads the backend already fetches — no extra
 * requests, no guessed values. A field the source does not provide is null.
 */
import { assessSeverity, assessEonetEvent, toHectares, toKnots } from "./severity.js";
import { formatMagnitude } from "./magnitude.js";

/** "Wildfire in Tanzania 1032766" -> "Wildfire in Tanzania"; "Flood in Nepal 1104225" -> "Flood in Nepal" */
export function cleanTitle(title) {
  return String(title ?? "")
    .replace(/\s+\d{4,}\s*$/u, "") // trailing numeric source id
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Place name from an EONET title: "Wildfire in Tanzania 1032766" -> "Tanzania",
 * "Tropical Storm Priscilla" -> "Tropical Storm Priscilla" (no "in": keep the clean title).
 */
export function placeFromEonetTitle(title) {
  const clean = cleanTitle(title);
  const m = clean.match(/\s+in\s+(.+)$/i);
  return m ? m[1].trim() : clean;
}

function toIso(value) {
  if (value === null || value === undefined || value === "") return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null; // Number(null) is 0
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const PAGER_LEVELS = new Set(["green", "yellow", "orange", "red"]);

/**
 * Nearest named place from a USGS place string: "100 km SSE of Palekastro, Greece" ->
 * { name: "Palekastro, Greece", distanceKm: 100, direction: "SSE" }. USGS writes this
 * from its own gazetteer of populated places; strings without a distance ("Fiji region",
 * "south of the Kermadec Islands") name a region, not a place, and give null.
 */
export function nearestPlaceFromUsgs(place) {
  const m = String(place ?? "").trim().match(/^(\d+(?:\.\d+)?)\s*km\s+([NSEW]{1,3})\s+of\s+(.+)$/);
  if (!m) return null;
  const distanceKm = Number(m[1]);
  return Number.isFinite(distanceKm) ? { name: m[3].trim(), distanceKm, direction: m[2] } : null;
}

/** At most this many timeline points per event (storm advisories can run to hundreds). */
export const TIMELINE_MAX_POINTS = 40;

/**
 * How a storm or wildfire developed, from EONET's geometry series: one point per
 * dated entry, oldest first, with the measured value in the unit the severity rule
 * uses (storms: wind in kts; wildfires: burned area in ha) or null when that entry
 * carries none. Long series keep the first and last entry and evenly spaced ones
 * between. Floods (no measurement in EONET) and single-entry series give null.
 */
export function buildEonetTimeline(geometry, type) {
  if (type !== "storm" && type !== "wildfire") return null;
  const points = (Array.isArray(geometry) ? geometry : [])
    .map((g) => {
      const at = toIso(g?.date);
      if (!at) return null;
      const value = type === "storm" ? toKnots(g?.magnitudeValue, g?.magnitudeUnit) : toHectares(g?.magnitudeValue, g?.magnitudeUnit);
      const point = g?.type === "Point" && Array.isArray(g.coordinates) ? g.coordinates : null;
      const lng = numOrNull(point?.[0]);
      const lat = numOrNull(point?.[1]);
      return { at, value, unit: type === "storm" ? "kts" : "ha", lat, lng };
    })
    .filter(Boolean)
    .sort((a, b) => a.at.localeCompare(b.at));
  if (points.length < 2) return null;
  if (points.length <= TIMELINE_MAX_POINTS) return points;
  const last = points.length - 1;
  const picked = new Set(Array.from({ length: TIMELINE_MAX_POINTS }, (_, i) => Math.round((i * last) / (TIMELINE_MAX_POINTS - 1))));
  return [...picked].sort((a, b) => a - b).map((i) => points[i]);
}

/** USGS GeoJSON feature -> details. */
export function buildUsgsDetails(feature) {
  const p = feature?.properties ?? {};
  const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const magnitude = numOrNull(p.mag);
  const magnitudeLabel = formatMagnitude(magnitude);
  const { severity, reason } = assessSeverity({ type: "earthquake", magnitude });
  const alert = typeof p.alert === "string" && PAGER_LEVELS.has(p.alert.toLowerCase()) ? p.alert.toLowerCase() : null;

  // The title is rebuilt from our own formatter rather than copied from
  // USGS: the USGS title string rounds the magnitude its own way, which made
  // the title say "M 6.1" while every other field said "M 6.0".
  const place = p.place ? String(p.place) : null;
  const title =
    magnitudeLabel !== null ? `M ${magnitudeLabel} - ${place ?? "Unknown location"}` : cleanTitle(p.title) || place || "";

  return {
    eventId: feature?.id ? `usgs:${feature.id}` : null,
    source: "usgs",
    category: "Earthquake",
    cleanTitle: title,
    place,
    occurredAt: toIso(numOrNull(p.time)),
    updatedAt: toIso(numOrNull(p.updated)),
    status: p.status ? String(p.status) : null, // "reviewed" | "automatic"
    sources: p.url ? [{ name: "USGS event page", url: String(p.url) }] : [],
    magnitude,
    magnitudeLabel, // display text for every surface ("6.1"); null when not reported
    magType: p.magType ? String(p.magType) : null,
    depthKm: coords.length >= 3 ? numOrNull(coords[2]) : null,
    pagerAlert: alert, // USGS PAGER: green | yellow | orange | red | null
    tsunami: p.tsunami === 1 || p.tsunami === true ? true : p.tsunami === 0 || p.tsunami === false ? false : null,
    feltReports: numOrNull(p.felt),
    magnitudeValue: null,
    magnitudeUnit: null,
    areaHa: null,
    peakKts: null,
    currentKts: null,
    gdacsLevel: null,
    gdacsScore: null,
    severity,
    severityReason: reason,
    severitySource: "Severity rule applied to the USGS magnitude",
    nearestPlace: nearestPlaceFromUsgs(place), // { name, distanceKm, direction } | null (region-only places)
    affectedCountries: null, // GDACS-only (wildfires, floods)
    timeline: null, // EONET-only (storms, wildfires)
  };
}

/**
 * NASA EONET v3 event -> details. `type` is the feed type already derived
 * from the category (wildfire | storm | flood); `pickedGeometry` is the
 * geometry entry the normalizer chose for the coordinates (optional).
 */
export function buildEonetDetails(event, type, pickedGeometry = null) {
  const geometry = Array.isArray(event?.geometry) ? event.geometry : [];
  const category = event?.categories?.[0]?.title ?? null;

  const dates = geometry.map((g) => toIso(g?.date)).filter(Boolean).sort();

  // Latest geometry entry that carries a magnitude (EONET updates these over
  // time); the burned area is normalised to hectares in severity.js.
  const { severity, reason, magnitudeValue, magnitudeUnit, areaHa, peakKts, currentKts, gdacsLevel, gdacsScore } = assessEonetEvent(event, type);
  const severitySource =
    gdacsLevel
      ? "Impact level assigned by GDACS (gdacs.org)"
      : severity === "unrated"
      ? type === "flood"
        ? "GDACS impact level unavailable; EONET reports no flood magnitude"
        : "EONET reports no intensity this rule can rate"
      : type === "wildfire"
      ? "Severity rule applied to the burned area reported by EONET (no GDACS level for this fire)"
      : "Severity rule applied to the peak advisory wind reported by EONET";

  const sources = [];
  if (event?.link) sources.push({ name: "NASA EONET", url: String(event.link) });
  for (const s of Array.isArray(event?.sources) ? event.sources : []) {
    if (s?.url) sources.push({ name: s.id ? String(s.id) : "Source", url: String(s.url) });
  }

  return {
    eventId: event?.id ? `nasa:${event.id}` : null,
    source: "nasa",
    category,
    cleanTitle: cleanTitle(event?.title),
    place: placeFromEonetTitle(event?.title) || null,
    occurredAt: toIso(pickedGeometry?.date) ?? dates[0] ?? null,
    updatedAt: dates.length ? dates[dates.length - 1] : null,
    status: event?.closed ? "closed" : "open",
    sources,
    magnitude: null,
    magnitudeLabel: null,
    magType: null,
    depthKm: null,
    pagerAlert: null,
    tsunami: null,
    feltReports: null,
    magnitudeValue, // as reported by the source (original unit)
    magnitudeUnit,
    areaHa, // wildfires: burned area normalised to hectares (acres × 0.40469); null otherwise
    peakKts, // storms: highest advisory wind of the series (the rated value); null otherwise
    currentKts, // storms: latest advisory wind
    gdacsLevel, // "green" | "orange" | "red" when GDACS rates this event, else null
    gdacsScore,
    severity,
    severityReason: reason,
    severitySource,
    nearestPlace: null, // USGS-only
    // ISO 3166-1 alpha-2 codes GDACS lists for the event; null when GDACS has no answer for it (unknown, not "none")
    affectedCountries: Array.isArray(event?.gdacsPlace?.countries) && event.gdacsPlace.countries.length ? [...event.gdacsPlace.countries] : null,
    timeline: buildEonetTimeline(geometry, type), // [{ at, value, unit, lat, lng }] oldest first | null
  };
}
