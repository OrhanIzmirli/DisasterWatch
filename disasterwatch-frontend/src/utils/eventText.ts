/**
 * Display text for feed events, shared by every surface that shows one
 * (feed rows, Today's events, map tooltip, detail drawer, news card tags).
 *
 * Live items carry `details` from the backend (clean title, occurredAt);
 * items without them (cache fallback, older payloads, the offline fallback
 * list) still get a clean title and a relative time instead of the raw
 * source string ("Flood in Nepal 1104225", "1104 min ago").
 */
import { relativeTime } from "./formatDate";

export type EventTextSource = {
  location: string;
  timeMinutesAgo?: number;
  details?: {
    cleanTitle?: string | null;
    occurredAt?: string | null;
  } | null;
};

/** "Wildfire in Tanzania 1032766" -> "Wildfire in Tanzania" (trailing numeric source id dropped). */
export function cleanTitle(title?: string | null): string {
  return String(title ?? "")
    .replace(/\s+\d{4,}\s*$/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The backend's clean title, else the raw location cleaned the same way. */
export function eventTitle(item: EventTextSource): string {
  return item.details?.cleanTitle || cleanTitle(item.location);
}

/** When the event happened: the source timestamp, else derived from the feed's minutes-ago counter. */
export function eventOccurredAt(item: EventTextSource, now: Date = new Date()): Date | null {
  const iso = item.details?.occurredAt;
  if (iso) {
    const d = new Date(iso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  if (typeof item.timeMinutesAgo === "number" && Number.isFinite(item.timeMinutesAgo)) {
    return new Date(now.getTime() - Math.max(0, item.timeMinutesAgo) * 60_000);
  }
  return null;
}

/** "just now", "15 minutes ago", "4 hours ago", "2 days ago" — never "240 min ago". */
export function eventRelativeTime(item: EventTextSource, now: Date = new Date()): string | null {
  return relativeTime(eventOccurredAt(item, now), now);
}
