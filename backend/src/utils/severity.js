/**
 * Severity rules — the single place that decides how a disaster is rated
 * and the sentence that explains it. The explanation is generated from the
 * same thresholds that produce the rating, so the two cannot drift apart.
 *
 * Rules (unchanged from the original normalizers, so the public feed keeps
 * its values):
 *   earthquake: magnitude ≥ 6.0 → high, 5.0–5.9 → medium, < 5.0 → low
 *   wildfire:   always high   (EONET gives no intensity we trust yet)
 *   storm:      always medium
 *   flood:      always medium
 *   anything else: low
 */

import { formatMagnitude } from "./magnitude.js";

export const EARTHQUAKE_HIGH_MAG = 6.0;
export const EARTHQUAKE_MEDIUM_MAG = 5.0;

const FIXED_BY_TYPE = {
  wildfire: ["high", "High: wildfires are always rated high (no intensity data from the source)"],
  storm: ["medium", "Medium: severe storms are always rated medium"],
  flood: ["medium", "Medium: floods are always rated medium"],
};

// Displayed numbers use the shared magnitude formatter so the explanation
// shows exactly what the title, feed row and tooltip show. The comparisons
// below stay on the raw value.
const fmt = formatMagnitude;

/**
 * @param {{ type: string, magnitude?: number|null }} input
 * @returns {{ severity: "low"|"medium"|"high", reason: string }}
 */
export function assessSeverity({ type, magnitude = null }) {
  if (type === "earthquake") {
    // null / undefined / "" mean "not reported" (Number(null) would be 0)
    const mag = magnitude === null || magnitude === undefined || magnitude === "" ? NaN : Number(magnitude);
    if (!Number.isFinite(mag)) {
      return { severity: "low", reason: "Low: magnitude not reported by source" };
    }
    if (mag >= EARTHQUAKE_HIGH_MAG) {
      return { severity: "high", reason: `High: magnitude ${fmt(mag)} (≥ ${fmt(EARTHQUAKE_HIGH_MAG)})` };
    }
    if (mag >= EARTHQUAKE_MEDIUM_MAG) {
      return {
        severity: "medium",
        reason: `Medium: magnitude ${fmt(mag)} (${fmt(EARTHQUAKE_MEDIUM_MAG)}–${(EARTHQUAKE_HIGH_MAG - 0.1).toFixed(1)})`,
      };
    }
    return { severity: "low", reason: `Low: magnitude ${fmt(mag)} (< ${fmt(EARTHQUAKE_MEDIUM_MAG)})` };
  }

  const fixed = FIXED_BY_TYPE[type];
  if (fixed) return { severity: fixed[0], reason: fixed[1] };

  return { severity: "low", reason: "Low: no severity rule for this event type" };
}

/** Backwards-compatible helpers used by the normalizers. */
export function severityFromMag(mag) {
  return assessSeverity({ type: "earthquake", magnitude: mag }).severity;
}

export function severityFromType(type) {
  return assessSeverity({ type }).severity;
}
