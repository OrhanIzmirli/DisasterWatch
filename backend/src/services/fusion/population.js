/**
 * Population near an event, for the exposure term of the priority score.
 *
 * Reads data/population.json (GeoNames cities5000, CC BY 4.0, written at
 * build time by scripts/fetch-population.mjs) into a 1-degree grid and sums
 * the population of the places within a radius. Places under ~5,000 people
 * are not in the table, so sparsely settled areas read low: the figure is a
 * rough indicator of how many people live near the event, not an impact
 * estimate. Without the table, exposure is null ("unknown").
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { distanceKm } from "../sources/firms.js";

const DEFAULT_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "data", "population.json");
const KM_PER_DEG = 111.32;

/** Builds the grid index from [[lat, lng, population]]. */
export function createPopulationIndex(places) {
  const grid = new Map();
  for (const [lat, lng, pop] of places) {
    const key = `${Math.floor(lat)},${Math.floor(lng)}`;
    (grid.get(key) ?? grid.set(key, []).get(key)).push([lat, lng, pop]);
  }

  const memo = new Map(); // events rarely move: the same question is answered once

  /** -> { population, places } within radiusKm of the point (the antimeridian is handled). */
  function near(lat, lng, radiusKm) {
    const key = `${lat.toFixed(3)},${lng.toFixed(3)},${radiusKm}`;
    const hit = memo.get(key);
    if (hit) return hit;
    if (memo.size > 20_000) memo.clear();
    const answer = sum(lat, lng, radiusKm);
    memo.set(key, answer);
    return answer;
  }

  function sum(lat, lng, radiusKm) {
    const dLat = Math.ceil(radiusKm / KM_PER_DEG);
    const dLng = Math.min(180, Math.ceil(radiusKm / (KM_PER_DEG * Math.max(0.01, Math.cos((Math.min(89, Math.abs(lat) + dLat) * Math.PI) / 180)))));
    let population = 0;
    let count = 0;
    const seen = new Set();
    for (let y = Math.floor(lat) - dLat; y <= Math.floor(lat) + dLat; y++) {
      for (let x = Math.floor(lng) - dLng; x <= Math.floor(lng) + dLng; x++) {
        const wrapped = ((((x + 180) % 360) + 360) % 360) - 180;
        const key = `${y},${wrapped}`;
        if (seen.has(key)) continue;
        seen.add(key);
        for (const [plat, plng, pop] of grid.get(key) ?? []) {
          if (distanceKm(lat, lng, plat, plng) <= radiusKm) {
            population += pop;
            count++;
          }
        }
      }
    }
    return { population, places: count };
  }

  return { near, size: places.length };
}

/** The index from data/population.json, or null when the file is missing or broken (exposure unknown). */
export function loadPopulationIndex(file = DEFAULT_FILE, log = console) {
  try {
    const { places } = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!Array.isArray(places) || places.length === 0) throw new Error("no places");
    return createPopulationIndex(places);
  } catch (err) {
    log.warn(`[fusion] population table not available (${err.code || err.message}); exposure is unknown`);
    return null;
  }
}

let shared;
/** Process-wide index, loaded on first use. */
export function populationIndex() {
  if (shared === undefined) shared = loadPopulationIndex();
  return shared;
}
