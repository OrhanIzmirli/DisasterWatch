type Quake = { timeMinutesAgo?: number | null; details?: { magnitude?: number | null } | null };

const magnitudeOf = (q: Quake) => {
  const m = q.details?.magnitude;
  return typeof m === "number" && Number.isFinite(m) ? m : Number.NEGATIVE_INFINITY;
};
const ageOf = (q: Quake) => (typeof q.timeMinutesAgo === "number" && Number.isFinite(q.timeMinutesAgo) ? q.timeMinutesAgo : Number.MAX_SAFE_INTEGER);

/**
 * The `cap` strongest earthquakes for the map: highest magnitude first, the
 * newer one first on equal magnitude (the same rule as the backend's
 * strongestFirst); a quake without a magnitude or age sorts last.
 * The input is not changed.
 */
export function strongestEarthquakes<T extends Quake>(quakes: readonly T[], cap: number): T[] {
  return quakes
    .slice()
    .sort((a, b) => magnitudeOf(b) - magnitudeOf(a) || ageOf(a) - ageOf(b))
    .slice(0, Math.max(0, cap));
}
