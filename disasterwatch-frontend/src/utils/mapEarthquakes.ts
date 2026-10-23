type Quake = { timeMinutesAgo: number; details?: { magnitude?: number | null } | null };

const magnitudeOf = (q: Quake) => {
  const m = q.details?.magnitude;
  return typeof m === "number" && Number.isFinite(m) ? m : Number.NEGATIVE_INFINITY;
};

/**
 * The `cap` strongest earthquakes for the map: highest magnitude first, the
 * newer one first on equal magnitude; a quake without a magnitude comes last.
 * The input is not changed.
 */
export function strongestEarthquakes<T extends Quake>(quakes: readonly T[], cap: number): T[] {
  return quakes
    .slice()
    .sort((a, b) => magnitudeOf(b) - magnitudeOf(a) || a.timeMinutesAgo - b.timeMinutesAgo)
    .slice(0, Math.max(0, cap));
}
