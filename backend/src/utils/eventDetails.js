/**
 * Rich, source-faithful details for a feed item. Everything here comes from
 * the NASA EONET / USGS payloads the backend already fetches — no extra
 * requests, no guessed values. A field the source does not provide is null.
 */
import { assessSeverity } from "./severity.js";

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
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

const PAGER_LEVELS = new Set(["green", "yellow", "orange", "red"]);

/** USGS GeoJSON feature -> details. */
export function buildUsgsDetails(feature) {
  const p = feature?.properties ?? {};
  const coords = Array.isArray(feature?.geometry?.coordinates) ? feature.geometry.coordinates : [];
  const magnitude = numOrNull(p.mag);
  const { severity, reason } = assessSeverity({ type: "earthquake", magnitude });
  const alert = typeof p.alert === "string" && PAGER_LEVELS.has(p.alert.toLowerCase()) ? p.alert.toLowerCase() : null;

  return {
    eventId: feature?.id ? `usgs:${feature.id}` : null,
    source: "usgs",
    category: "Earthquake",
    cleanTitle: cleanTitle(p.title) || (magnitude !== null ? `M ${magnitude.toFixed(1)} - ${p.place ?? "Unknown location"}` : String(p.place ?? "")),
    place: p.place ? String(p.place) : null,
    occurredAt: toIso(numOrNull(p.time)),
    updatedAt: toIso(numOrNull(p.updated)),
    status: p.status ? String(p.status) : null, // "reviewed" | "automatic"
    sources: p.url ? [{ name: "USGS event page", url: String(p.url) }] : [],
    magnitude,
    magType: p.magType ? String(p.magType) : null,
    depthKm: coords.length >= 3 ? numOrNull(coords[2]) : null,
    pagerAlert: alert, // USGS PAGER: green | yellow | orange | red | null
    tsunami: p.tsunami === 1 || p.tsunami === true ? true : p.tsunami === 0 || p.tsunami === false ? false : null,
    feltReports: numOrNull(p.felt),
    magnitudeValue: null,
    magnitudeUnit: null,
    severity,
    severityReason: reason,
    severitySource: "Severity rule applied to the USGS magnitude",
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

  // Latest geometry entry that carries a magnitude (EONET updates these over time)
  const withMagnitude = [...geometry].reverse().find((g) => g && g.magnitudeValue !== null && g.magnitudeValue !== undefined);
  const dates = geometry.map((g) => toIso(g?.date)).filter(Boolean).sort();

  const { severity, reason } = assessSeverity({ type });

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
    magType: null,
    depthKm: null,
    pagerAlert: null,
    tsunami: null,
    feltReports: null,
    magnitudeValue: withMagnitude ? numOrNull(withMagnitude.magnitudeValue) : null,
    magnitudeUnit: withMagnitude?.magnitudeUnit ? String(withMagnitude.magnitudeUnit) : null,
    severity,
    severityReason: reason,
    severitySource: "Severity rule applied to the EONET category",
  };
}
