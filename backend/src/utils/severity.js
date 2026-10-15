/**
 * Severity rules — the single place that decides how a disaster is rated
 * and the sentence that explains it. The explanation is generated from the
 * same thresholds that produce the rating, so the two cannot drift apart.
 *
 * Rules (calibrated 2026-10-15, see README "Severity"):
 *   earthquake: rounded magnitude ≥ 6.0 → high, 5.0–5.9 → medium, < 5.0 → low
 *   wildfire:   GDACS impact level is primary (Red → high, Orange → medium,
 *               Green → low). Without a level (US/IRWIN fires, GDACS down):
 *               burned area in hectares ≥ 10,000 → high, 7,000–9,999 → medium,
 *               < 7,000 → low (acres × 0.40469; 10,000 ha ≈ the top decile and
 *               7,000 ha ≈ the third quartile of 90 days of EONET fires).
 *   flood:      GDACS impact level; without one → "unrated" (EONET reports
 *               no flood magnitude).
 *   storm:      Saffir-Simpson on the PEAK advisory wind of the event (max
 *               magnitudeValue over the geometry series): ≥ 96 kts → high
 *               (category 3+), 64–95 → medium (category 1–2), < 64 → low.
 *               The current wind is reported next to the peak.
 *   no value / unknown unit / other types → "unrated"
 *
 * Manual (admin) entries never go through this module: they keep the
 * severity the admin chose (low | medium | high).
 */

import { formatMagnitude, roundMagnitude } from "./magnitude.js";
import { GDACS_LEVEL_SEVERITY } from "../services/gdacs.js";

export const EARTHQUAKE_HIGH_MAG = 6.0;
export const EARTHQUAKE_MEDIUM_MAG = 5.0;

export const STORM_HIGH_KTS = 96;
export const STORM_MEDIUM_KTS = 64;

export const WILDFIRE_HIGH_HA = 10_000;
export const WILDFIRE_MEDIUM_HA = 7_000;

/** 1 acre = 0.40469 ha. */
export const ACRES_TO_HA = 0.40469;

export const UNRATED = "unrated";
export const UNRATED_REASON = "Not rated: the source reports no intensity for this event";

const fmt = formatMagnitude;
const fmtInt = (n) => Math.round(n).toLocaleString("en-US");
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

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

/** Saffir-Simpson label for a wind in knots. */
export function saffirSimpson(kts) {
  if (kts >= 137) return "Saffir-Simpson category 5";
  if (kts >= 113) return "Saffir-Simpson category 4";
  if (kts >= 96) return "Saffir-Simpson category 3";
  if (kts >= 83) return "Saffir-Simpson category 2";
  if (kts >= 64) return "Saffir-Simpson category 1";
  if (kts >= 34) return "tropical storm, below hurricane strength";
  return "tropical depression, below hurricane strength";
}

const unrated = () => ({ severity: UNRATED, reason: UNRATED_REASON });

function fromGdacs(level, detail) {
  const severity = GDACS_LEVEL_SEVERITY[level];
  const suffix = detail ? ` (${detail})` : "";
  return { severity, reason: `${cap(severity)}: GDACS impact level ${cap(level)}${suffix}` };
}

/**
 * @param {{ type: string, magnitude?: number|null, magnitudeValue?: number|null, magnitudeUnit?: string|null,
 *           areaHa?: number|null, peakKts?: number|null, currentKts?: number|null, gdacsLevel?: string|null }} input
 *   - earthquake: `magnitude` (USGS)
 *   - wildfire: `gdacsLevel` ("green" | "orange" | "red") first, else `areaHa` or `magnitudeValue` + `magnitudeUnit`
 *   - flood: `gdacsLevel` only
 *   - storm: `peakKts` (max over the advisory series) and `currentKts` (latest), or `magnitudeValue` + `magnitudeUnit`
 * @returns {{ severity: "low"|"medium"|"high"|"unrated", reason: string }}
 */
export function assessSeverity({
  type,
  magnitude = null,
  magnitudeValue = null,
  magnitudeUnit = null,
  areaHa = null,
  peakKts = null,
  currentKts = null,
  gdacsLevel = null,
}) {
  const level = gdacsLevel ? String(gdacsLevel).toLowerCase() : null;
  const hasLevel = level !== null && level in GDACS_LEVEL_SEVERITY;

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
    const peak = numOrNull(peakKts) ?? toKnots(magnitudeValue, magnitudeUnit);
    if (peak === null) return unrated();
    const current = numOrNull(currentKts) ?? toKnots(magnitudeValue, magnitudeUnit) ?? peak;
    const nowText = `, now ${fmtInt(current)} kts`;
    if (peak >= STORM_HIGH_KTS) {
      return { severity: "high", reason: `High: peak wind ${fmtInt(peak)} kts (${saffirSimpson(peak)}, ≥ ${STORM_HIGH_KTS} kts)${nowText}` };
    }
    if (peak >= STORM_MEDIUM_KTS) {
      return { severity: "medium", reason: `Medium: peak wind ${fmtInt(peak)} kts (${saffirSimpson(peak)}, ${STORM_MEDIUM_KTS}–${STORM_HIGH_KTS - 1} kts)${nowText}` };
    }
    return { severity: "low", reason: `Low: peak wind ${fmtInt(peak)} kts (${saffirSimpson(peak)}, < ${STORM_MEDIUM_KTS} kts)${nowText}` };
  }

  if (type === "wildfire") {
    const ha = areaHa !== null && areaHa !== undefined ? numOrNull(areaHa) : toHectares(magnitudeValue, magnitudeUnit);
    if (hasLevel) return fromGdacs(level, ha !== null ? `${fmtInt(ha)} ha burned` : null);
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

  if (type === "flood") {
    return hasLevel ? fromGdacs(level, null) : unrated();
  }

  // every other type: no rule
  return unrated();
}

/** Backwards-compatible helper used by the USGS normalizer and the event mapper. */
export function severityFromMag(mag) {
  return assessSeverity({ type: "earthquake", magnitude: mag }).severity;
}

/**
 * Severity for an EONET event: the GDACS level attached by services/gdacs.js
 * (`event.gdacs`) when present, otherwise the event's own measurement. Storms
 * use the peak of the advisory series and report the latest value as well.
 * Returns the rating, the reason, the raw measurement, the normalised burned
 * area, the wind pair and the GDACS level, so the feed details and the Kafka
 * mapper agree.
 */
export function assessEonetEvent(event, type) {
  const geometry = Array.isArray(event?.geometry) ? event.geometry : [];
  const withMagnitude = geometry.filter((g) => g && g.magnitudeValue !== null && g.magnitudeValue !== undefined);
  const latest = withMagnitude.at(-1) ?? null;
  const magnitudeValue = latest ? numOrNull(latest.magnitudeValue) : null;
  const magnitudeUnit = latest?.magnitudeUnit ? String(latest.magnitudeUnit) : null;
  const areaHa = type === "wildfire" ? toHectares(magnitudeValue, magnitudeUnit) : null;

  let peakKts = null;
  let currentKts = null;
  if (type === "storm") {
    const winds = withMagnitude.map((g) => toKnots(g.magnitudeValue, g.magnitudeUnit)).filter((v) => v !== null);
    if (winds.length) {
      peakKts = Math.max(...winds);
      currentKts = toKnots(magnitudeValue, magnitudeUnit) ?? winds.at(-1);
    }
  }

  const gdacsLevel = event?.gdacs?.level && event.gdacs.level in GDACS_LEVEL_SEVERITY ? event.gdacs.level : null;
  const gdacsScore = gdacsLevel ? (numOrNull(event.gdacs.score) ?? null) : null;

  const { severity, reason } = assessSeverity({ type, magnitudeValue, magnitudeUnit, areaHa, peakKts, currentKts, gdacsLevel });
  return { severity, reason, magnitudeValue, magnitudeUnit, areaHa, peakKts, currentKts, gdacsLevel, gdacsScore };
}
