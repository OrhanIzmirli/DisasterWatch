/**
 * Confidence and priority scores (backend docs/scoring.md): types, bands for
 * the map encoding and the filters, and the words the event drawer uses to
 * explain them. The scores themselves are computed by the backend only.
 */

/** Compact scores on every dashboard feed item (GET /disasters). */
export type FeedScores = { confidence: number; priority: number; confirmations: number } | null;

export type ConfidenceComponent = { term: "primary" | "confirmation" | "cap" | "staleness"; source?: string; role?: "confirming" | "listed"; points: number; reason: string };
export type PriorityComponent = { term: "severity" | "exposure" | "confidence"; value: number | null; weight: number; basis: string };
export type SourceMatch = {
  source: "usgs" | "eonet" | "emsc" | "nhc" | "firms" | "gdacs";
  role: "primary" | "confirming" | "listed";
  sourceEventId: string | null;
  url: string | null;
  matchedBy: "rule" | "name" | "proximity" | "reference" | null;
  distanceKm: number | null;
  timeDeltaSec: number | null;
  agency?: string | null;
  magnitude?: number;
  windKts?: number | null;
  classification?: string | null;
  detections?: number;
  level?: string;
};
/** The "why" of one event, from GET /api/v1/disasters/{id}. */
export type ScoreExplanation = {
  sources: SourceMatch[];
  ambiguousSources: string[];
  confidence: { score: number; components: ConfidenceComponent[] } | null;
  priority: { score: number; components: PriorityComponent[]; exposure: { population: number; radiusKm: number } | null } | null;
};

export type Band = "high" | "medium" | "low";

/** Confidence: 70+ high (solid outline), 40-69 medium (dashed), below 40 low (dotted). */
export const confidenceBand = (score: number): Band => (score >= 70 ? "high" : score >= 40 ? "medium" : "low");
/** Priority: 60+ high (large marker), 30-59 medium, below 30 low (small). */
export const priorityBand = (score: number): Band => (score >= 60 ? "high" : score >= 30 ? "medium" : "low");

export const BAND_LABELS: Record<Band, string> = { high: "high", medium: "medium", low: "low" };

/** Filter steps offered in the feed toolbar (the band boundaries). */
export const CONFIDENCE_STEPS = [0, 40, 70] as const;
export const PRIORITY_STEPS = [0, 30, 60] as const;

/** Events without scores never pass a minimum above 0 (the API does the same). */
export function passesScores(scores: FeedScores | undefined, minConfidence: number, minPriority: number) {
  if (minConfidence === 0 && minPriority === 0) return true;
  if (!scores) return false;
  return scores.confidence >= minConfidence && scores.priority >= minPriority;
}

export const SOURCE_NAMES: Record<SourceMatch["source"], string> = {
  usgs: "USGS",
  eonet: "NASA EONET",
  emsc: "EMSC",
  nhc: "NOAA National Hurricane Center",
  firms: "NASA FIRMS",
  gdacs: "GDACS",
};

const ROLE_TEXT: Record<SourceMatch["role"], string> = {
  primary: "Source of this event",
  confirming: "Confirms it independently",
  listed: "Lists it, not independently",
};

/** One line on how a source was matched: "Same name · 120 km and 3 h apart", "7 satellite detections", ... */
export function matchDescription(s: SourceMatch): string {
  if (s.role === "primary") return ROLE_TEXT.primary;
  const parts: string[] = [ROLE_TEXT[s.role]];
  if (s.matchedBy === "reference") parts.push("linked by the event itself");
  if (s.matchedBy === "name") parts.push("same storm name");
  if (s.source === "firms" && s.detections) parts.push(`${s.detections} satellite fire detection${s.detections === 1 ? "" : "s"} within 10 km`);
  const apart: string[] = [];
  if (s.timeDeltaSec !== null && s.matchedBy !== "proximity") apart.push(duration(Math.abs(s.timeDeltaSec)));
  if (s.distanceKm !== null) apart.push(`${s.distanceKm.toLocaleString("en-GB")} km`);
  if (apart.length) parts.push(`${apart.join(" and ")} apart`);
  if (s.agency) parts.push(`solution by ${s.agency}`);
  if (s.level) parts.push(`${s.level} alert`);
  if (s.classification) parts.push(s.classification);
  return parts.join(" · ");
}

function duration(sec: number) {
  if (sec < 120) return `${Math.round(sec)} s`;
  if (sec < 7200) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

/** Feed event id ("usgs:…", "nasa:EONET_…") -> public API id. */
export function apiIdOf(eventId: string | undefined | null): string | null {
  if (!eventId) return null;
  if (eventId.startsWith("usgs:")) return eventId;
  if (eventId.startsWith("nasa:")) return `eonet:${eventId.slice(5)}`;
  return null;
}
