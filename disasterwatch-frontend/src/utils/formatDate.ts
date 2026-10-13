/**
 * Date formatting for the UI. The app is English, so dates use a fixed
 * en-GB locale instead of the browser's, e.g. "13 Oct 2026" and
 * "12 Oct 2026, 10:00". Returns null for missing or invalid input.
 */

const LOCALE = "en-GB";

function parse(value?: string | Date | null): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "13 Oct 2026" */
export function formatDate(value?: string | Date | null): string | null {
  const d = parse(value);
  if (!d) return null;
  return d.toLocaleDateString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** "12 Oct 2026, 10:00" */
export function formatDateTime(value?: string | Date | null): string | null {
  const d = parse(value);
  if (!d) return null;
  return d.toLocaleString(LOCALE, {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const RELATIVE_UNITS: [number, string][] = [
  [60, "minute"],
  [60, "hour"],
  [24, "day"],
  [7, "week"],
];

/**
 * "just now", "15 minutes ago", "3 hours ago", "2 days ago", "1 week ago".
 * Past only (future dates read "just now"). `now` is injectable for tests.
 */
export function relativeTime(value?: string | Date | null, now: Date = new Date()): string | null {
  const d = parse(value);
  if (!d) return null;
  let seconds = Math.max(0, Math.floor((now.getTime() - d.getTime()) / 1000));
  if (seconds < 60) return "just now";
  let unit = "second";
  for (const [factor, name] of RELATIVE_UNITS) {
    if (seconds < factor) break;
    seconds = Math.floor(seconds / factor);
    unit = name;
  }
  // beyond weeks, fall back to the absolute date
  if (unit === "week" && seconds >= 5) return formatDate(d);
  return `${seconds} ${unit}${seconds === 1 ? "" : "s"} ago`;
}
