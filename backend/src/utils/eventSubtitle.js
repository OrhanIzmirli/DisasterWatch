/**
 * Feed events that share a title ("Wildfire in Australia" x 14) are separate
 * events; a subtitle built from data we already have tells them apart:
 *
 *   "≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct"
 *
 * approximate coordinates, the burnt area when the source reports one, and
 * the start date (UTC). Only events whose title repeats in the feed get one;
 * the title itself is never changed.
 */

const titleOf = (e) => e?.details?.cleanTitle || e?.title || e?.location || "";

const coordinate = (value, positive, negative) => `${Math.abs(value).toFixed(1)}°${value < 0 ? negative : positive}`;

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

export function eventSubtitle(e) {
  const parts = [];
  if (Number.isFinite(e?.lat) && Number.isFinite(e?.lng)) parts.push(`≈ ${coordinate(e.lat, "N", "S")} ${coordinate(e.lng, "E", "W")}`);
  const area = e?.details?.areaHa;
  if (typeof area === "number" && Number.isFinite(area) && area > 0) parts.push(`${Math.round(area).toLocaleString("en-GB")} ha`);
  const started = e?.details?.occurredAt ? new Date(e.details.occurredAt) : null;
  if (started && !Number.isNaN(started.getTime())) parts.push(`since ${DATE.format(started)}`);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * `items` with a `subtitle` on each event whose title occurs more than once
 * in `all` (the whole feed window, so a repeat cut off by the page limit
 * still counts).
 */
export function withSubtitles(items, all = items) {
  const counts = new Map();
  for (const e of all) counts.set(titleOf(e), (counts.get(titleOf(e)) ?? 0) + 1);
  return items.map((e) => {
    if ((counts.get(titleOf(e)) ?? 0) < 2) return e;
    const subtitle = eventSubtitle(e);
    return subtitle ? { ...e, subtitle } : e;
  });
}
