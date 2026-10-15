// backend/src/utils/normalizeDisasters.js
import { buildEonetDetails, cleanTitle } from "./eventDetails.js";
import { countryFromPlace } from "./country.js";

function toId(str) {
  // Stable numeric id from string
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) >>> 0;
  return h;
}

function minutesAgo(isoDate) {
  const t = new Date(isoDate).getTime();
  if (!Number.isFinite(t)) return 999999;
  return Math.max(0, Math.floor((Date.now() - t) / 60000));
}

export function mapCategoryToType(catTitle) {
  // EONET v3 category titles
  if (catTitle === "Wildfires") return "wildfire";
  if (catTitle === "Severe Storms") return "storm";
  if (catTitle === "Floods") return "flood";
  // Earthquakes usually not in EONET -> will come from USGS
  return null;
}

// Severity rules live in ./severity.js (single source of truth).
// here so existing imports keep working.

/**
 * EONET geometry notes:
 * - Often: { type:"Point", coordinates:[lng,lat] }
 * - Sometimes: Polygon/MultiPolygon => coordinates nested arrays
 * We try to extract a usable [lng,lat] from any geometry type.
 */

function isFiniteNumber(n) {
  return Number.isFinite(n);
}

function pickPointFromCoordinates(coords) {
  // returns [lng, lat] or null
  if (!coords) return null;

  // Point: [lng, lat]
  if (Array.isArray(coords) && coords.length >= 2 && typeof coords[0] === "number") {
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (isFiniteNumber(lat) && isFiniteNumber(lng)) return [lng, lat];
    return null;
  }

  // Polygon: [ [ [lng,lat], [lng,lat], ... ] ]
  // MultiPolygon: [ [ [ [lng,lat], ... ] ] ]
  // We go deep until we find the first valid [lng,lat]
  if (Array.isArray(coords)) {
    for (const c of coords) {
      const found = pickPointFromCoordinates(c);
      if (found) return found;
    }
  }

  return null;
}

function centroidOfRing(ring) {
  // ring: [ [lng,lat], [lng,lat], ... ]
  // simple average centroid (stable + fast)
  if (!Array.isArray(ring) || ring.length === 0) return null;

  let sumLng = 0;
  let sumLat = 0;
  let count = 0;

  for (const p of ring) {
    if (!Array.isArray(p) || p.length < 2) continue;
    const lng = Number(p[0]);
    const lat = Number(p[1]);
    if (!isFiniteNumber(lng) || !isFiniteNumber(lat)) continue;
    sumLng += lng;
    sumLat += lat;
    count++;
  }

  if (count === 0) return null;
  return [sumLng / count, sumLat / count];
}

export function pickBestLatLngFromGeometryArray(geometryArr) {
  // geometryArr: EONET ev.geometry array
  // we try from last to first, because last is most recent
  const geom = Array.isArray(geometryArr) ? geometryArr : [];
  for (let i = geom.length - 1; i >= 0; i--) {
    const g = geom[i];
    const coords = g?.coordinates;

    // 1) Polygon ([[ [lng,lat], ... ]]) or MultiPolygon ([[[ [lng,lat], ... ]]]):
    //    place the marker at the centroid of the outer ring, never at its
    //    first vertex (GDACS flood polygons are large; the first vertex can
    //    sit kilometres from the affected area's centre).
    if (Array.isArray(coords) && Array.isArray(coords[0]) && Array.isArray(coords[0][0])) {
      const ring = Array.isArray(coords[0][0][0]) ? coords[0][0] : coords[0]; // MultiPolygon -> first polygon's outer ring
      const cent = centroidOfRing(ring);
      if (cent) return { coords: cent, date: g?.date, geometry: g };
    }

    // 2) Point (or anything else with a usable [lng,lat] inside)
    const p = pickPointFromCoordinates(coords);
    if (p) return { coords: p, date: g?.date, geometry: g };
  }

  return null;
}

export function normalizeNasaEvents(events) {
  const arr = Array.isArray(events) ? events : [];
  const out = [];

  for (const ev of arr) {
    const catTitle = ev?.categories?.[0]?.title;
    const type = mapCategoryToType(catTitle);
    if (!type) continue;

    // Find best coordinates from geometry (handles Flood polygons too)
    const best = pickBestLatLngFromGeometryArray(ev?.geometry);
    const coords = best?.coords;

    const lng = Array.isArray(coords) ? Number(coords[0]) : null;
    const lat = Array.isArray(coords) ? Number(coords[1]) : null;
    if (!isFiniteNumber(lat) || !isFiniteNumber(lng)) continue;

    const when = best?.date || ev?.updated || ev?.created;
    const mins = minutesAgo(when);

    const location = ev?.title || "Unknown location";
    // Rated from the EONET measurement (wind speed, burned area); unrated when there is none
    const details = buildEonetDetails(ev, type, best?.geometry ?? null);
    const sev = details.severity;

    // Build a more descriptive meta line
    const meta = `${catTitle} • ${mins} min ago`;

    out.push({
      id: toId(String(ev?.id ?? location)),
      type,
      location,
      meta,
      severity: sev,
      timeMinutesAgo: mins,
      // EONET has no description; the title fallback drops the trailing source id
      description: ev?.description || cleanTitle(ev?.title),
      lat,
      lng,
      // Rich, source-faithful fields (new; everything above is unchanged)
      details,
    });
    // Country from the source place name only (null when it cannot be derived)
    const last = out[out.length - 1];
    last.country = countryFromPlace(last.details?.place ?? cleanTitle(location));
  }

  return out;
}
