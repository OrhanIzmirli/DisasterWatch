/**
 * The one-sentence headline above the KPIs, built only from the feed that is
 * already loaded (no AI, no invented numbers). Deterministic for a given feed
 * and clock:
 *
 *   "8 significant events being monitored worldwide — latest high-severity:
 *    Hurricane Simon (peak 135 kts), 7 hours ago."
 *   "No significant events right now — 60 events monitored."
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

/** "M 6.9 earthquake, 76 km NE of Ozernovskiy, Russia" / "Hurricane Simon (peak 135 kts)" / "Wildfire in Australia". */
export function eventLabel(e: HeadlineEvent): string {
  if (e.type === "earthquake" && e.details?.magnitudeLabel && e.details.place) {
    return `M ${e.details.magnitudeLabel} earthquake, ${e.details.place}`;
  }
  const title = eventTitle(e);
  if (e.type === "storm" && typeof e.details?.peakKts === "number") {
    return `${title} (peak ${Math.round(e.details.peakKts)} kts)`;
  }
  return title;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function headlineText({ status, significant, total, items, stale = false, dataAge = null, now = new Date() }: HeadlineInput): string {
  if (status === "loading") return "Loading the latest events from NASA EONET and USGS…";
  if (status === "error") return "Live sources are not responding right now, so there is no summary to show.";

  const staleNote = stale ? ` Showing the last successful update${dataAge ? ` (${dataAge})` : ""}.` : "";

  if (total === 0) return `No events reported by NASA EONET or USGS in the last 7 days.${staleNote}`;

  if (significant === 0) return `No significant events right now — ${plural(total, "event")} monitored.${staleNote}`;

  const head = `${plural(significant, "significant event")} being monitored worldwide`;
  const lead = leadEvent(items, now);
  if (!lead) return `${head}.${staleNote}`;
  const when = eventRelativeTime(lead, now);
  return `${head} — latest ${lead.severity}-severity: ${eventLabel(lead)}${when ? `, ${when}` : ""}.${staleNote}`;
}
