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
