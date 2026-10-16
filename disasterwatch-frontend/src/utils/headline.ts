/**
 * The one-sentence headline above the KPIs, built only from the feed that is
 * already loaded (no AI, no invented numbers). Deterministic for a given feed
 * and clock:
 *
 *   "8 significant events worldwide right now. The most serious: Hurricane
 *    Simon, a Category 4 at its peak — 7 hours ago."
 *   "No major events right now — tracking 60 events worldwide."
 *
 * Peak wind in knots stays in the event drawer; the headline names the
 * Saffir-Simpson category instead.
 *
 * "Significant" is the same high + medium count the KPI card shows, over the
 * whole feed window (every hazard type, whatever filter chip is active).
 */
import { eventOccurredAt, eventRelativeTime, eventTitle } from "./eventText";

type Severity = "high" | "medium" | "low" | "unrated";

export type HeadlineEvent = {
  id: number;
  type: string;
  severity: Severity;
  location: string;
  timeMinutesAgo?: number;
  details?: {
    cleanTitle?: string | null;
    occurredAt?: string | null;
    magnitude?: number | null;
    magnitudeLabel?: string | null;
    place?: string | null;
    peakKts?: number | null;
  } | null;
};

export type HeadlineInput = {
  status: "loading" | "ready" | "error";
  /** High + medium over the whole feed window. */
  significant: number;
  /** Every event in the feed window. */
  total: number;
  /** Loaded feed items (used to name the lead event). */
  items: HeadlineEvent[];
  /** True when the page shows the last successful update instead of live data. */
  stale?: boolean;
  /** "2 hours ago": age of the data as reported by the backend. */
  dataAge?: string | null;
  now?: Date;
};

const SEVERITY_RANK: Record<Severity, number> = { high: 0, medium: 1, low: 2, unrated: 3 };

/** Strength within the same severity and time: earthquake magnitude or storm peak wind. */
const strength = (e: HeadlineEvent) => e.details?.magnitude ?? e.details?.peakKts ?? 0;

/**
 * The event the headline names: the highest severity among significant
 * events, then the newest, then the stronger, then the lowest id.
 */
export function leadEvent(items: HeadlineEvent[], now: Date = new Date()): HeadlineEvent | null {
  const significant = items.filter((e) => e.severity === "high" || e.severity === "medium");
  if (significant.length === 0) return null;
  const time = (e: HeadlineEvent) => eventOccurredAt(e, now)?.getTime() ?? 0;
  return significant.slice().sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || time(b) - time(a) || strength(b) - strength(a) || a.id - b.id
  )[0];
}

/** Saffir-Simpson category from a peak wind in knots (64-82 Cat 1 ... 137+ Cat 5); null below hurricane strength. */
export function saffirSimpsonCategory(kts: number): 1 | 2 | 3 | 4 | 5 | null {
  const k = Math.round(kts);
  if (k >= 137) return 5;
  if (k >= 113) return 4;
  if (k >= 96) return 3;
  if (k >= 83) return 2;
  if (k >= 64) return 1;
  return null;
}

/** "Ozernovskiy, Russia" from USGS "76 km NE of Ozernovskiy, Russia"; other place texts unchanged. */
const nearPlace = (place: string) => place.replace(/^\s*\d+(\.\d+)?\s*km\s+[NSEW]{1,3}\s+of\s+/i, "");

/** "M 6.9 earthquake near Ozernovskiy, Russia" / "Hurricane Simon, a Category 4 at its peak" / "Wildfire in Australia". */
export function eventLabel(e: HeadlineEvent): string {
  if (e.type === "earthquake" && e.details?.magnitudeLabel && e.details.place) {
    return `M ${e.details.magnitudeLabel} earthquake near ${nearPlace(e.details.place)}`;
  }
  const title = eventTitle(e);
  if (e.type === "storm" && typeof e.details?.peakKts === "number") {
    const category = saffirSimpsonCategory(e.details.peakKts);
    if (category) return `${title}, a Category ${category} at its peak`;
  }
  return title;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function headlineText({ status, significant, total, items, stale = false, dataAge = null, now = new Date() }: HeadlineInput): string {
  if (status === "loading") return "Loading the latest events from NASA and USGS…";
  if (status === "error") return "Live sources aren't responding right now.";

  const staleNote = stale ? ` Showing the last update${dataAge ? `, from ${dataAge}` : ""}.` : "";

  if (total === 0) return `No events reported by NASA EONET or USGS in the last 7 days.${staleNote}`;

  if (significant === 0) return `No major events right now — tracking ${plural(total, "event")} worldwide.${staleNote}`;

  const head = `${plural(significant, "significant event")} worldwide right now.`;
  const lead = leadEvent(items, now);
  if (!lead) return `${head}${staleNote}`;
  const when = eventRelativeTime(lead, now);
  return `${head} The most serious: ${eventLabel(lead)}${when ? ` — ${when}` : ""}.${staleNote}`;
}
