/**
 * Magnitude display formatting — the single place that turns a raw USGS
 * magnitude into the "6.1" shown in titles, feed meta lines, tooltips and
 * severity explanations. Severity thresholds are still compared against the
 * raw value (see severity.js); only the displayed text goes through here.
 *
 * Why not `toFixed(1)`: USGS reports many magnitudes with two decimals and
 * rounds its own titles half-up on the decimal value ("M 6.05" -> "M 6.1").
 * `toFixed` rounds the binary double instead, and 6.05 is stored as
 * 6.04999…, so it printed "6.0" while the USGS title said "6.1". The same
 * event then showed two different magnitudes on one screen.
 */

const EPSILON = 1e-9; // lifts x.x5 values stored just below the midpoint

/** Magnitude rounded half away from zero to one decimal; null when not a finite number. */
export function roundMagnitude(mag) {
  if (mag === null || mag === undefined || mag === "") return null;
  const n = Number(mag);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(Math.abs(n) * 10 + EPSILON) / 10;
  return n < 0 ? -rounded : rounded;
}

/** "6.1", "4.5", "6.0" — one decimal, same rounding as USGS titles; null when not reported. */
export function formatMagnitude(mag) {
  const rounded = roundMagnitude(mag);
  return rounded === null ? null : rounded.toFixed(1);
}
