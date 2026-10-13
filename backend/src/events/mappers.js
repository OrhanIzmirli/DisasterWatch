/**
 * Map raw NASA EONET events and USGS GeoJSON features to the disaster event
 * contract. Works from the raw payloads (not the public-feed normalizers) so
 * the stable source ids are preserved: "nasa:EONET_1234", "usgs:us7000abcd".
 */
import {
  mapCategoryToType,
  severityFromType,
  pickBestLatLngFromGeometryArray,
} from "../utils/normalizeDisasters.js";
import { severityFromMag } from "../services/usgs.service.js";
import { disasterEventSchema } from "./contract.js";

const ID_CHARS = /[^A-Za-z0-9_.-]/g;

function cleanId(raw) {
  return String(raw ?? "").replace(ID_CHARS, "");
}

function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * A handful of EONET flood polygons come with [lat, lng] instead of
 * [lng, lat]. When the pair is only valid the other way round, swap it.
 */
function fixSwappedCoords([lng, lat]) {
  const ok = (la, lo) => Math.abs(la) <= 90 && Math.abs(lo) <= 180;
  if (!ok(lat, lng) && ok(lng, lat)) return [lat, lng];
  return [lng, lat];
}

/** Returns only the events that satisfy the contract; invalid ones are dropped and counted. */
function validateAll(candidates) {
  const events = [];
  let dropped = 0;
  for (const c of candidates) {
    const parsed = disasterEventSchema.safeParse(c);
    if (parsed.success) events.push(parsed.data);
    else dropped++;
  }
  return { events, dropped };
}

export function nasaEventsToContract(rawEvents) {
  const candidates = [];
  for (const ev of Array.isArray(rawEvents) ? rawEvents : []) {
    const type = mapCategoryToType(ev?.categories?.[0]?.title);
    const id = cleanId(ev?.id);
    if (!type || !id) continue;

    const best = pickBestLatLngFromGeometryArray(ev?.geometry);
    if (!best?.coords) continue;
    const [lng, lat] = fixSwappedCoords(best.coords);

    const occurredAt = toIso(best.date || ev?.updated || ev?.created);
    if (!occurredAt) continue;

    candidates.push({
      v: 1,
      eventId: `nasa:${id}`,
      source: "nasa",
      type,
      severity: severityFromType(type),
      title: String(ev?.title || "Unnamed event").slice(0, 200),
      lat,
      lng,
      occurredAt,
    });
  }
  return validateAll(candidates);
}

export function usgsFeaturesToContract(features, { minMag = 4.5 } = {}) {
  const candidates = [];
  for (const f of Array.isArray(features) ? features : []) {
    const id = cleanId(f?.id);
    const mag = Number(f?.properties?.mag);
    const coords = f?.geometry?.coordinates;
    if (!id || !Number.isFinite(mag) || mag < minMag || !Array.isArray(coords)) continue;

    const occurredAt = toIso(Number(f?.properties?.time));
    if (!occurredAt) continue;

    const place = String(f?.properties?.place || "Unknown location");
    candidates.push({
      v: 1,
      eventId: `usgs:${id}`,
      source: "usgs",
      type: "earthquake",
      severity: severityFromMag(mag),
      title: `M${mag.toFixed(1)} earthquake, ${place}`.slice(0, 200),
      lat: Number(coords[1]),
      lng: Number(coords[0]),
      occurredAt,
    });
  }
  return validateAll(candidates);
}
