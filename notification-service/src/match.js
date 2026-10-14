/**
 * Pure matching rules between a disaster event (contract v1) and an
 * AlertSubscription row. No I/O, no clock access except through `now`.
 */

export const SEVERITY_RANK = { low: 0, medium: 1, high: 2 };

/** How far back an event may lie and still trigger a notification. */
export const MAX_EVENT_AGE_MS = 48 * 60 * 60 * 1000;

const EARTH_RADIUS_KM = 6371;

export function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function typeMatches(subscriptionType, eventType) {
  return subscriptionType === "any" || subscriptionType === eventType;
}

export function severityMatches(minSeverity, eventSeverity) {
  const min = SEVERITY_RANK[minSeverity];
  const ev = SEVERITY_RANK[eventSeverity];
  if (min === undefined || ev === undefined) return false;
  return ev >= min;
}

/**
 * Does the subscription's rule match the event? (type, severity, radius,
 * active). Returns { matched, distanceKm }.
 */
export function matchesSubscription(event, sub) {
  const distanceKm = haversineKm(sub.centerLat, sub.centerLng, event.lat, event.lng);
  const matched =
    sub.active === true &&
    typeMatches(sub.type, event.type) &&
    severityMatches(sub.minSeverity, event.severity) &&
    distanceKm <= sub.radiusKm;
  return { matched, distanceKm };
}

/**
 * Should a notification be created? Besides the rule match:
 *  - the event must have occurred within the last 48 hours (relative to
 *    `now`), so a backlog replayed at startup does not flood users;
 *  - the subscription must have been created before the event occurred,
 *    so a new subscription does not pull in history.
 * Returns { notify, reason, distanceKm }.
 */
export function shouldNotify(event, sub, now = new Date()) {
  const { matched, distanceKm } = matchesSubscription(event, sub);
  if (!matched) return { notify: false, reason: "no-match", distanceKm };

  const occurred = new Date(event.occurredAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : Number(now);
  if (!Number.isFinite(occurred)) return { notify: false, reason: "bad-date", distanceKm };
  if (nowMs - occurred > MAX_EVENT_AGE_MS) return { notify: false, reason: "too-old", distanceKm };

  const subCreated = new Date(sub.createdAt).getTime();
  if (!Number.isFinite(subCreated) || subCreated > occurred) {
    return { notify: false, reason: "subscription-newer-than-event", distanceKm };
  }

  return { notify: true, reason: "match", distanceKm };
}

/**
 * Builds the notification rows for one event across many subscriptions.
 * One row per user at most: if several of a user's subscriptions match,
 * the closest one wins (the DB also has a unique (userId, eventId) guard).
 */
export function buildNotifications(event, subscriptions, now = new Date()) {
  const byUser = new Map();

  for (const sub of subscriptions) {
    const result = shouldNotify(event, sub, now);
    if (!result.notify) continue;

    const current = byUser.get(sub.userId);
    if (!current || result.distanceKm < current.distanceKm) {
      byUser.set(sub.userId, {
        userId: sub.userId,
        subscriptionId: sub.id,
        subscriptionLabel: sub.label,
        eventId: event.eventId,
        title: event.title,
        type: event.type,
        severity: event.severity,
        lat: event.lat,
        lng: event.lng,
        distanceKm: Math.round(result.distanceKm * 10) / 10,
        occurredAt: event.occurredAt,
      });
    }
  }

  return [...byUser.values()];
}
