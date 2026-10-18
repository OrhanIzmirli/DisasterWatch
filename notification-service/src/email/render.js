/**
 * Builds the alert digest e-mail (one per user per run): plain text + HTML.
 *
 * Content: per alert the title, type, severity, source, time, location (with
 * the map's "approximate" note when it applies) and a link to the event on
 * the site; below, why the user gets the e-mail (their alert), a link to the
 * alert settings and the unsubscribe link. Only data from our own database:
 * no third-party article text, no images, no tracking pixel. Every value in
 * the HTML is escaped.
 */
export const MAX_ITEMS = 20; // alerts listed in one e-mail; the rest are counted

const TYPE_LABELS = { earthquake: "Earthquake", flood: "Flood", wildfire: "Wildfire", storm: "Storm", volcano: "Volcano" };
const SEVERITY_LABELS = { high: "High", medium: "Medium", low: "Low", unrated: "Not rated" };
const SUB_SEVERITY_LABELS = { low: "every severity", medium: "medium and above", high: "high only" };
const SOURCE_LABELS = { nasa: "NASA EONET", usgs: "USGS", manual: "DisasterWatch" };

const typeLabel = (t) => TYPE_LABELS[t] ?? (t ? t.charAt(0).toUpperCase() + t.slice(1) : "Disaster");
const sourceOf = (eventId) => String(eventId ?? "").split(":")[0];

/** Same numeric id as the public feed (backend utils/normalizeDisasters.js toId), so /?event=<id> selects it. */
export function feedId(eventId) {
  const raw = String(eventId ?? "").replace(/^(nasa|usgs):/, "");
  let h = 0;
  for (let i = 0; i < raw.length; i++) h = (h * 31 + raw.charCodeAt(i)) >>> 0;
  return h;
}

export function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatUtc(date) {
  const d = new Date(date);
  if (!Number.isFinite(d.getTime())) return "unknown time";
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

const coord = (lat, lng) =>
  `${Math.abs(lat).toFixed(2)}° ${lat >= 0 ? "N" : "S"}, ${Math.abs(lng).toFixed(2)}° ${lng >= 0 ? "E" : "W"}`;

/** One alert as plain fields (shared by the text and the HTML part). */
function describe(n, appUrl) {
  const source = sourceOf(n.eventId);
  const km = Number.isFinite(Number(n.distanceKm)) ? Math.round(Number(n.distanceKm)) : null;
  const where = n.subscriptionLabel ? `${km ?? "?"} km from your alert "${n.subscriptionLabel}"` : km !== null ? `${km} km from your alert area` : null;
  return {
    title: n.title,
    facts: `${typeLabel(n.type)} · Severity: ${SEVERITY_LABELS[n.severity] ?? n.severity} · Source: ${SOURCE_LABELS[source] ?? source}`,
    time: formatUtc(n.occurredAt),
    location: `${coord(n.lat, n.lng)}${where ? ` (${where})` : ""}`,
    approximate: n.locationPrecision === "approximate" ? "Approximate location: the sources disagree on the exact area." : null,
    link: source === "nasa" || source === "usgs" ? `${appUrl}/?event=${feedId(n.eventId)}` : `${appUrl}/`,
  };
}

/** Why this e-mail: the user's alerts that matched (label, type, severity, radius). */
function reasons(notifications) {
  const seen = new Map();
  for (const n of notifications) {
    const key = n.subscriptionId ?? "removed";
    if (seen.has(key)) continue;
    seen.set(
      key,
      n.subscriptionLabel
        ? `"${n.subscriptionLabel}": ${n.subscriptionType === "any" || !n.subscriptionType ? "any disaster" : `${typeLabel(n.subscriptionType).toLowerCase()}s`}, ${SUB_SEVERITY_LABELS[n.subscriptionMinSeverity] ?? "any severity"}, within ${n.subscriptionRadiusKm} km`
        : "an alert you have since removed"
    );
  }
  return [...seen.values()];
}

/**
 * -> { subject, text, html }
 * notifications: [{ eventId, title, type, severity, lat, lng, distanceKm, occurredAt, locationPrecision,
 *                   subscriptionId, subscriptionLabel, subscriptionType, subscriptionMinSeverity, subscriptionRadiusKm }]
 */
export function renderDigest({ notifications, appUrl, unsubscribeUrl }) {
  const all = notifications.map((n) => describe(n, appUrl));
  const shown = all.slice(0, MAX_ITEMS);
  const more = all.length - shown.length;
  const settingsUrl = `${appUrl}/alerts`;
  const why = reasons(notifications);
  const subject = all.length === 1 ? `DisasterWatch alert: ${all[0].title}` : `DisasterWatch: ${all.length} new alerts`;
  const intro = all.length === 1 ? "A new event matches one of your alerts." : `${all.length} new events match your alerts.`;
  const whyLine = `You are receiving this e-mail because e-mail alerts are on for your DisasterWatch account and these events matched your alert${why.length > 1 ? "s" : ""}: ${why.join("; ")}.`;

  const text = [
    intro,
    "",
    ...shown.flatMap((a) => [a.title, a.facts, `Time: ${a.time}`, `Location: ${a.location}`, ...(a.approximate ? [a.approximate] : []), `View on the map: ${a.link}`, ""]),
    ...(more > 0 ? [`…and ${more} more on ${appUrl}/`, ""] : []),
    "—",
    whyLine,
    `Alert settings: ${settingsUrl}`,
    `Unsubscribe from these e-mails: ${unsubscribeUrl}`,
  ].join("\n");

  const e = escapeHtml;
  const item = (a) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #e5e7eb">
      <div style="font-size:16px;font-weight:600;color:#111827">${e(a.title)}</div>
      <div style="font-size:14px;color:#374151;margin-top:4px">${e(a.facts)}</div>
      <div style="font-size:14px;color:#374151">Time: ${e(a.time)}</div>
      <div style="font-size:14px;color:#374151">Location: ${e(a.location)}</div>
      ${a.approximate ? `<div style="font-size:14px;color:#92400e">${e(a.approximate)}</div>` : ""}
      <div style="font-size:14px;margin-top:4px"><a href="${e(a.link)}" style="color:#1d4ed8">View on the map</a></div>
    </td></tr>`;
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${e(subject)}</title></head>
<body style="margin:0;padding:16px;background:#ffffff;font-family:Arial,Helvetica,sans-serif;color:#111827">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;margin:0 auto">
    <tr><td style="font-size:18px;font-weight:700;padding-bottom:8px">DisasterWatch</td></tr>
    <tr><td style="font-size:15px;padding-bottom:4px">${e(intro)}</td></tr>
    ${shown.map(item).join("")}
    ${more > 0 ? `<tr><td style="padding:12px 0;font-size:14px">…and ${more} more on <a href="${e(appUrl)}/" style="color:#1d4ed8">DisasterWatch</a></td></tr>` : ""}
    <tr><td style="padding-top:16px;font-size:13px;color:#4b5563">
      <p style="margin:0 0 8px">${e(whyLine)}</p>
      <p style="margin:0"><a href="${e(settingsUrl)}" style="color:#1d4ed8">Alert settings</a> · <a href="${e(unsubscribeUrl)}" style="color:#1d4ed8">Unsubscribe from these e-mails</a></p>
    </td></tr>
  </table>
</body></html>`;

  return { subject: subject.slice(0, 200), text, html };
}
