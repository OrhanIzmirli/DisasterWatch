/**
 * E-mail alert channel, as the notification-service last reported it
 * (EmailChannelStatus row, written on its start and after every e-mail run)
 * plus the digests of the last 24 h counted from EmailDelivery.
 *
 *   state: "active"         configured and seen recently, under the daily limit
 *          "limit-reached"  the daily limit is used up: alerts stay in-app
 *          "not-configured" the sender has no provider settings (or never ran)
 *          "unknown"        configured, but the service has not reported for STALE_MS
 *
 * Counts and times only: no addresses, no error text for the public /health
 * beyond the stored (address-masked) provider error.
 */
import crypto from "node:crypto";
import defaultPrisma from "../prisma.js";

/** The notification-service reports at least on every hourly wake-up. */
export const STALE_MS = 3 * 60 * 60 * 1000;
const WINDOW_MS = 24 * 60 * 60 * 1000;

/** Unsubscribe and confirmation tokens: 32 random bytes, base64url (43 characters). */
export const EMAIL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
export const newEmailToken = () => crypto.randomBytes(32).toString("base64url");

export async function emailChannelStatus({ prisma = defaultPrisma, now = new Date() } = {}) {
  const row = await prisma.emailChannelStatus.findUnique({ where: { id: 1 } });
  const since = new Date(now.getTime() - WINDOW_MS);
  // same rule as the notification-service (src/email/dispatcher.js COUNTED; keep in step): sent, pending,
  // and failed or cancelled ones that were attempted, by COALESCE(sentAt, lastAttemptAt, createdAt)
  const [{ n: sentLast24h }] = await prisma.$queryRaw`
    SELECT count(*)::int AS n FROM "EmailDelivery"
     WHERE ("status" IN ('sent', 'pending') OR ("status" IN ('failed', 'cancelled') AND "attempts" > 0))
       AND COALESCE("sentAt", "lastAttemptAt", "createdAt") > ${since}`;
  let state = "not-configured";
  if (row?.configured) {
    if (now.getTime() - row.updatedAt.getTime() > STALE_MS) state = "unknown";
    else state = sentLast24h >= row.dailyLimit ? "limit-reached" : "active";
  }
  return {
    state,
    dailyLimit: row?.dailyLimit ?? null,
    sentLast24h,
    reportedAt: row?.updatedAt?.toISOString() ?? null,
    lastSentAt: row?.lastSentAt?.toISOString() ?? null,
    lastError: row?.lastError ?? null,
    lastErrorAt: row?.lastErrorAt?.toISOString() ?? null,
  };
}
