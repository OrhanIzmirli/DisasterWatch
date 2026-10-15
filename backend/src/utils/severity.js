/**
 * Severity rules — the single place that decides how a disaster is rated
 * and the sentence that explains it. The explanation is generated from the
 * same thresholds that produce the rating, so the two cannot drift apart.
 *
 * Rules:
 *   earthquake: rounded magnitude ≥ 6.0 → high, 5.0–5.9 → medium, < 5.0 → low
 *   storm (EONET wind speed in kts): ≥ 96 → high (Saffir-Simpson category 3+),
 *               64–95 → medium (hurricane), < 64 → low (tropical storm)
 *   wildfire (EONET burned area, normalised to hectares): ≥ 40,000 ha → high,
 *               4,000–39,999 ha → medium, < 4,000 ha → low
 *   no value, an unknown unit, floods, anything else → "unrated"
 *               ("Not rated: the source reports no intensity for this event")
 *
 * Manual (admin) entries never go through this module: they keep the
 * severity the admin chose (low | medium | high).
 */

import { formatMagnitude, roundMagnitude } from "./magnitude.js";

export const EARTHQUAKE_HIGH_MAG = 6.0;
export const EARTHQUAKE_MEDIUM_MAG = 5.0;

export const STORM_HIGH_KTS = 96;
export const STORM_MEDIUM_KTS = 64;

export const WILDFIRE_HIGH_HA = 40_000;
export const WILDFIRE_MEDIUM_HA = 4_000;

/** 1 acre = 0.40469 ha (so 100,000 acres ≈ 40,469 ha, 10,000 acres ≈ 4,047 ha). */
export const ACRES_TO_HA = 0.40469;

export const UNRATED = "unrated";
export const UNRATED_REASON = "Not rated: the source reports no intensity for this event";

const fmt = formatMagnitude;
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");

function numOrNull(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * Burned area in hectares — the one place that converts units.
 * EONET reports GDACS fires in "hectare" and US (IRWIN) fires in "acres".
 * Returns null for a missing value or an unknown unit.
 */
export function toHectares(value, unit) {
  const n = numOrNull(value);
  if (n === null || n < 0) return null;
  const u = String(unit ?? "").trim().toLowerCase();
  if (u === "hectare" || u === "hectares" || u === "ha") return n;
  if (u === "acre" || u === "acres") return n * ACRES_TO_HA;
  return null;
}

/** Wind speed in knots; null for a missing value or a unit other than kts. */
export function toKnots(value, unit) {
  const n = numOrNull(value);
  if (n === null || n < 0) return null;
  const u = String(unit ?? "").trim().toLowerCase();
  return u === "kts" || u === "kt" || u === "knots" ? n : null;
}

const unrated = () => ({ severity: UNRATED, reason: UNRATED_REASON });

/**
 * @param {{ type: string, magnitude?: number|null, magnitudeValue?: number|null, magnitudeUnit?: string|null, areaHa?: number|null }} input
 *   - earthquake: `magnitude` (USGS)
 *   - storm: `magnitudeValue` + `magnitudeUnit` ("kts") from EONET
 *   - wildfire: `areaHa` (already normalised), or `magnitudeValue` + `magnitudeUnit` ("hectare" | "acres")
 * @returns {{ severity: "low"|"medium"|"high"|"unrated", reason: string }}
 */
export function assessSeverity({ type, magnitude = null, magnitudeValue = null, magnitudeUnit = null, areaHa = null }) {
  if (type === "earthquake") {
    // The rating and the explanation both work from the ROUNDED magnitude (the
    // one every surface displays, see magnitude.js): a quake shown as "M 6.0"
    // is rated high, never "medium (5.0–5.9)". Raw 5.95 -> 6.0 -> high.
    const mag = roundMagnitude(magnitude);
    if (mag === null) {
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

  if (type === "storm") {
    const kts = toKnots(magnitudeValue, magnitudeUnit);
    if (kts === null) return unrated();
    const shown = fmtInt(kts);
    if (kts >= STORM_HIGH_KTS) {
      return { severity: "high", reason: `High: ${shown} kts sustained wind (≥ ${STORM_HIGH_KTS} kts, Saffir-Simpson category 3 or stronger)` };
    }
    if (kts >= STORM_MEDIUM_KTS) {
      return { severity: "medium", reason: `Medium: ${shown} kts sustained wind (${STORM_MEDIUM_KTS}–${STORM_HIGH_KTS - 1} kts, hurricane strength)` };
    }
    return { severity: "low", reason: `Low: ${shown} kts sustained wind (< ${STORM_MEDIUM_KTS} kts, tropical storm)` };
  }

  if (type === "wildfire") {
    const ha = areaHa !== null && areaHa !== undefined ? numOrNull(areaHa) : toHectares(magnitudeValue, magnitudeUnit);
    if (ha === null) return unrated();
    const shown = fmtInt(ha);
    if (ha >= WILDFIRE_HIGH_HA) {
      return { severity: "high", reason: `High: ${shown} ha burned (≥ ${fmtInt(WILDFIRE_HIGH_HA)} ha)` };
    }
    if (ha >= WILDFIRE_MEDIUM_HA) {
      return { severity: "medium", reason: `Medium: ${shown} ha burned (${fmtInt(WILDFIRE_MEDIUM_HA)}–${fmtInt(WILDFIRE_HIGH_HA - 1)} ha)` };
    }
    return { severity: "low", reason: `Low: ${shown} ha burned (< ${fmtInt(WILDFIRE_MEDIUM_HA)} ha)` };
  }

  // floods and every other type: EONET reports no intensity we can rate
  return unrated();
}

/** Backwards-compatible helper used by the USGS normalizer and the event mapper. */
export function severityFromMag(mag) {
  return assessSeverity({ type: "earthquake", magnitude: mag }).severity;
}

/**
 * Severity for an EONET event from its latest geometry entry that carries a
 * magnitude. Returns the rating, the reason, the raw measurement and the
 * normalised burned area so callers (feed details, Kafka mapper) agree.
 */
export function assessEonetEvent(event, type) {
  const geometry = Array.isArray(event?.geometry) ? event.geometry : [];
  const withMagnitude = [...geometry].reverse().find((g) => g && g.magnitudeValue !== null && g.magnitudeValue !== undefined);
  const magnitudeValue = withMagnitude ? numOrNull(withMagnitude.magnitudeValue) : null;
  const magnitudeUnit = withMagnitude?.magnitudeUnit ? String(withMagnitude.magnitudeUnit) : null;
  const areaHa = type === "wildfire" ? toHectares(magnitudeValue, magnitudeUnit) : null;
  const { severity, reason } = assessSeverity({ type, magnitudeValue, magnitudeUnit, areaHa });
  return { severity, reason, magnitudeValue, magnitudeUnit, areaHa };
}
