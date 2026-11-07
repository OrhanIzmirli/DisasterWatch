/**
 * Plain-language context for the event drawer, derived only from data the
 * feed already carries. Nothing here rates an event: the severity comes from
 * the backend (backend/src/utils/severity.js, the single source of truth), and
 * the scale below is drawn from the thresholds the backend serves with the feed
 * (`severityRules`); the frontend keeps no copy of them.
 */
import type { DrawerEvent } from "../components/EventDetailDrawer";
import type { SeverityRules } from "../services/feedCache";
import { eventRelativeTime } from "./eventText";

type Severity = DrawerEvent["severity"];
type RatedSeverity = Exclude<Severity, "unrated">;

const fmt = (n: number, digits = 0) =>
  n.toLocaleString("en-GB", { minimumFractionDigits: digits, maximumFractionDigits: digits });

/** USGS magnitude classes (earthquake.usgs.gov, "Earthquake Magnitude Classes"). */
export function quakeClass(mag: number): { label: string; meaning: string } {
  if (mag >= 8) return { label: "Great", meaning: "can destroy communities near the epicentre" };
  if (mag >= 7) return { label: "Major", meaning: "can cause serious damage over large areas" };
  if (mag >= 6) return { label: "Strong", meaning: "can be destructive in populated areas" };
  if (mag >= 5) return { label: "Moderate", meaning: "felt widely; damage to weak buildings is possible" };
  if (mag >= 4) return { label: "Light", meaning: "often felt, rarely causes damage" };
  return { label: "Minor", meaning: "usually not felt or only slightly" };
}

/** Standard focal-depth classes used by USGS. Shallow quakes are felt more strongly at the surface. */
export function depthClass(km: number): { label: string; meaning: string } {
  if (km < 70) return { label: "Shallow", meaning: "shaking at the surface is strongest for shallow quakes" };
  if (km < 300) return { label: "Intermediate depth", meaning: "shaking is spread over a wider, weaker area" };
  return { label: "Deep", meaning: "deep quakes are rarely damaging at the surface" };
}

/** Saffir-Simpson category name for a sustained wind in knots. */
export function stormCategory(kts: number): string {
  if (kts >= 137) return "Category 5 hurricane";
  if (kts >= 113) return "Category 4 hurricane";
  if (kts >= 96) return "Category 3 hurricane";
  if (kts >= 83) return "Category 2 hurricane";
  if (kts >= 64) return "Category 1 hurricane";
  if (kts >= 34) return "Tropical storm";
  return "Tropical depression";
}

/** GDACS alert levels describe expected humanitarian impact (gdacs.org). */
export const GDACS_MEANING: Record<"green" | "orange" | "red", string> = {
  green: "little humanitarian impact expected",
  orange: "moderate impact expected; national response may be needed",
  red: "severe impact expected; international assistance may be needed",
};

export type ScaleStep = { level: RatedSeverity; label: string; range: string };

export type SeverityScale = {
  /** What the rating is measured on, in plain words. */
  basis: string;
  steps: ScaleStep[];
  /** The event's level, or null when the source gives nothing to rate. */
  current: RatedSeverity | null;
};

/** The three steps of the rule that rated this event, for a small visual scale. */
export function severityScale(event: DrawerEvent, rules: SeverityRules | null): SeverityScale {
  const d = event.details;
  const current = event.severity === "unrated" ? null : event.severity;
  // Without the served rules (an old cached feed, a failed request) the levels are
  // shown without their ranges rather than with numbers the frontend would have to guess.
  const steps = (ranges: [string, string, string] | null): ScaleStep[] => [
    { level: "low", label: "Low", range: ranges?.[0] ?? "" },
    { level: "medium", label: "Medium", range: ranges?.[1] ?? "" },
    { level: "high", label: "High", range: ranges?.[2] ?? "" },
  ];
  const decimals = (step: number) => (step < 1 ? Math.max(0, -Math.floor(Math.log10(step))) : 0);

  if (event.type === "earthquake") {
    const t = rules?.earthquake;
    const n = (v: number) => fmt(v, t ? decimals(t.step) : 1);
    return {
      basis: "USGS magnitude",
      current,
      steps: steps(t ? [`below M ${n(t.medium)}`, `M ${n(t.medium)}–${n(t.high - t.step)}`, `M ${n(t.high)} and above`] : null),
    };
  }
  const gdacsRanges = (): [string, string, string] | null => {
    if (!rules) return null;
    const levelFor = (severity: RatedSeverity) =>
      Object.entries(rules.gdacs.levels).find(([, s]) => s === severity)?.[0] ?? null;
    const name = (severity: RatedSeverity) => {
      const level = levelFor(severity);
      return level ? `GDACS ${level.charAt(0).toUpperCase()}${level.slice(1)}` : "";
    };
    return [name("low"), name("medium"), name("high")];
  };
  if (d?.gdacsLevel) return { basis: "GDACS impact level", current, steps: steps(gdacsRanges()) };
  if (event.type === "storm") {
    const t = rules?.storm;
    const cat = (kts: number) => stormCategory(kts).replace(/ hurricane$/, "").replace("Category ", "Cat ");
    return {
      basis: "Peak wind (Saffir-Simpson)",
      current,
      steps: steps(
        t
          ? [
              `below ${fmt(t.medium)} kts`,
              `${fmt(t.medium)}–${fmt(t.high - t.step)} kts (${cat(t.medium)}–${cat(t.high - t.step).replace("Cat ", "")})`,
              `${fmt(t.high)} kts and above (${cat(t.high)}+)`,
            ]
          : null
      ),
    };
  }
  if (event.type === "wildfire") {
    const t = rules?.wildfire;
    return {
      basis: "Burned area (NASA EONET)",
      current,
      steps: steps(t ? [`below ${fmt(t.medium)} ha`, `${fmt(t.medium)}–${fmt(t.high - t.step)} ha`, `${fmt(t.high)} ha and above`] : null),
    };
  }
  // floods without a GDACS level: nothing to measure
  return { basis: "GDACS impact level", current, steps: steps(gdacsRanges()) };
}

const TYPE_NOUN: Record<DrawerEvent["type"], string> = {
  earthquake: "earthquake",
  flood: "flood",
  wildfire: "wildfire",
  storm: "storm",
};

/** One sentence that says what happened, where and when, from the event's own fields. */
export function summarySentence(event: DrawerEvent, now: Date = new Date()): string {
  const d = event.details;
  const when = eventRelativeTime(event, now);
  // Only the source's own place: EONET titles without a place ("Hurricane Simon") must not
  // turn into "in Hurricane Simon". USGS places ("100 km SSE of Palekastro, Greece") carry their preposition.
  const place = d?.place ?? null;
  const where = place ? (event.type === "earthquake" ? place : `in ${place}`) : null;
  const sentence = (...parts: (string | null)[]) => parts.filter(Boolean).join(", ") + ".";

  if (event.type === "earthquake" && d?.magnitudeLabel) {
    const depth = d.depthKm !== null && d.depthKm !== undefined ? ` at ${fmt(d.depthKm)} km depth` : "";
    return sentence(`A magnitude ${d.magnitudeLabel} earthquake${depth}`, where, when);
  }
  if (event.type === "wildfire" && d?.areaHa !== null && d?.areaHa !== undefined) {
    const area = `A wildfire of about ${fmt(Math.round(d.areaHa / 100) * 100)} hectares (${fmt(d.areaHa / 100, 1)} km²)`;
    return sentence(where ? `${area} ${where}` : area, when ? `first reported ${when}` : null);
  }
  if (event.type === "storm" && d?.peakKts !== null && d?.peakKts !== undefined) {
    const latest = d.currentKts ?? d.peakKts;
    const peak = `A storm${where ? ` ${where}` : ""} that peaked at ${fmt(d.peakKts)} kts (${stormCategory(d.peakKts).toLowerCase()})`;
    const weakened = latest < d.peakKts ? ` and has weakened to ${fmt(latest)} kts` : "";
    return sentence(`${peak}${weakened}`, when);
  }
  return sentence(where ? `A ${TYPE_NOUN[event.type]} reported ${where}` : `A ${TYPE_NOUN[event.type]} reported`, when);
}

/** "Open: the source still tracks it" or how long it was tracked before the source closed it. */
export function lifecycle(event: DrawerEvent): string | null {
  const d = event.details;
  if (!d?.status || event.type === "earthquake") return null;
  const start = d.occurredAt ? new Date(d.occurredAt).getTime() : NaN;
  const end = d.updatedAt ? new Date(d.updatedAt).getTime() : NaN;
  const days = Number.isFinite(start) && Number.isFinite(end) && end > start ? Math.round((end - start) / 86_400_000) : null;
  const span = days !== null && days >= 1 ? ` after ${days} day${days === 1 ? "" : "s"}` : "";
  if (/closed/i.test(d.status)) return `Closed: the source stopped tracking it${span}.`;
  if (/open/i.test(d.status)) return `Open: the source is still tracking it${days !== null && days >= 1 ? ` (${days} day${days === 1 ? "" : "s"} so far)` : ""}.`;
  return null;
}

/** Great-circle distance in km. */
export function distanceKm(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const R = 6371;
  const rad = (x: number) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export type NearbyEvent<T> = { event: T; distanceKm: number };

/** Other feed events within `radiusKm`, nearest first. */
export function nearbyEvents<T extends { id: number; lat: number; lng: number }>(
  event: { id: number; lat: number; lng: number },
  all: readonly T[],
  radiusKm = 500,
  max = 5
): NearbyEvent<T>[] {
  return all
    .filter((e) => e.id !== event.id)
    .map((e) => ({ event: e, distanceKm: distanceKm(event, e) }))
    .filter((n) => n.distanceKm <= radiusKm)
    .sort((a, b) => a.distanceKm - b.distanceKm)
    .slice(0, max);
}
