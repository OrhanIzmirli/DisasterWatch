/**
 * Map raw NASA EONET events and USGS GeoJSON features to the disaster event
 * contract. Works from the raw payloads (not the public-feed normalizers) so
 * the stable source ids are preserved: "nasa:EONET_1234", "usgs:us7000abcd".
 */
import { mapCategoryToType, pickBestLatLngFromGeometryArray, resolveEventLocation } from "../utils/normalizeDisasters.js";
import { severityFromMag, assessEonetEvent } from "../utils/severity.js";
import { formatMagnitude } from "../utils/magnitude.js";
import { cleanTitle } from "../utils/eventDetails.js";
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

/**
 * EONET events -> contract events. Also returns `eonetFallback`: the eventIds
 * placed on the EONET geometry only because GDACS could not be reached for an
 * event that links to it (the map would show the GDACS point once reachable),
 * and `approximate`: the eventIds whose location the map marks "approximate"
 * (GDACS and EONET disagree); recorded with the event for the alert e-mails.
 */
export function nasaEventsToContract(rawEvents) {
  const candidates = [];
  const fallback = new Set();
  const approximate = new Set();
  for (const ev of Array.isArray(rawEvents) ? rawEvents : []) {
    const type = mapCategoryToType(ev?.categories?.[0]?.title);
    const id = cleanId(ev?.id);
    if (!type || !id) continue;

    const best = pickBestLatLngFromGeometryArray(ev?.geometry);
    // Same point as the public map marker: the GDACS event point when there is one (fetchNasaEventsRated
    // attaches it as gdacsPlace), else the EONET geometry; like the map, a GDACS point alone is enough.
    // Only the values change; the contract does not.
    const place = resolveEventLocation(best?.coords ? fixSwappedCoords(best.coords) : null, ev?.gdacsPlace);
    if (!place?.coords) continue;
    const [lng, lat] = place.coords;

    const occurredAt = toIso(best?.date || ev?.updated || ev?.created);
    if (!occurredAt) continue;
    if (ev?.gdacsUnreachable && place.source === "eonet") fallback.add(`nasa:${id}`);
    if (place.precision === "approximate") approximate.add(`nasa:${id}`);

    candidates.push({
      v: 1,
      eventId: `nasa:${id}`,
      source: "nasa",
      type,
      severity: assessEonetEvent(ev, type).severity, // same rule as the feed details
      // trailing EONET source id dropped, same as the public feed and news cards
      title: (cleanTitle(ev?.title) || "Unnamed event").slice(0, 200),
      lat,
      lng,
      occurredAt,
    });
  }
  const { events, dropped } = validateAll(candidates);
  const ids = (set) => events.filter((e) => set.has(e.eventId)).map((e) => e.eventId);
  return { events, dropped, eonetFallback: ids(fallback), approximate: ids(approximate) };
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
      severity: severityFromMag(mag), // same rule as the feed: rated on the rounded magnitude
      title: `M${formatMagnitude(mag)} earthquake, ${place}`.slice(0, 200),
      lat: Number(coords[1]),
      lng: Number(coords[0]),
      occurredAt,
    });
  }
  return validateAll(candidates);
}
