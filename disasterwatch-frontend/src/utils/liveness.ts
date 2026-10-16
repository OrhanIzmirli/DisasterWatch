/**
 * Which map markers pulse: the newest event on the map, plus up to three
 * significant (high or medium) events that occurred in the last 24 hours,
 * highest severity first, then newest. Nothing pulses when the feed has
 * nothing recent, and nothing pulses at all when the visitor asked for
 * reduced motion.
 */
import { eventOccurredAt, type EventTextSource } from "./eventText";

type Severity = "high" | "medium" | "low" | "unrated";

export type PulseCandidate = EventTextSource & { id: number; severity: Severity };

export const PULSE_SIGNIFICANT_MAX = 3;
export const PULSE_WINDOW_MS = 24 * 60 * 60 * 1000;

const EMPTY: ReadonlySet<number> = new Set();

export function pulseIds(markers: PulseCandidate[], { now = new Date(), reducedMotion = false }: { now?: Date; reducedMotion?: boolean } = {}): ReadonlySet<number> {
  if (reducedMotion || markers.length === 0) return EMPTY;
  const time = (m: PulseCandidate) => eventOccurredAt(m, now)?.getTime() ?? Number.NEGATIVE_INFINITY;
  const ids = new Set<number>();

  const newest = markers.reduce((best, m) => (time(m) > time(best) || (time(m) === time(best) && m.id < best.id) ? m : best));
  if (Number.isFinite(time(newest))) ids.add(newest.id);

  const recentSignificant = markers
    .filter((m) => (m.severity === "high" || m.severity === "medium") && now.getTime() - time(m) <= PULSE_WINDOW_MS)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === "high" ? -1 : 1) || time(b) - time(a) || a.id - b.id)
    .slice(0, PULSE_SIGNIFICANT_MAX);
  for (const m of recentSignificant) ids.add(m.id);
  return ids;
}
