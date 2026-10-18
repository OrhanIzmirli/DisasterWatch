/**
 * E-mail digests for new notifications (opt-in per user, double opt-in).
 *
 * A run (after a burst of new notifications, and every few minutes for
 * retries):
 *
 *  1. claim, in one transaction holding a transaction-level advisory lock
 *     (works through the Neon pooler, unlike a session lock), so the daily
 *     limit cannot be overrun by two instances:
 *     - a user who turned e-mail on but has not confirmed the address gets
 *       one "confirm" delivery (the confirmation link only, no user-written
 *       text; registration does not verify addresses, so nothing else is
 *       e-mailed before the owner of the mailbox confirms);
 *     - every notification of the last 24 h without an e-mail, of a user
 *       with e-mail on, the address confirmed and the consent given before
 *       the notification was created, goes into ONE "pending" digest per
 *       user (a user with a digest still pending waits for it first).
 *     The daily limit is counted from EmailDelivery (rolling 24 h; sent,
 *     pending, and failed ones that reached the provider), not from memory:
 *     the service sleeps and restarts. Over the limit notifications are
 *     marked emailSkipReason = "daily-limit" (the in-app notification exists
 *     anyway) and are not e-mailed later;
 *  2. send every pending delivery: a short lease on the row keeps a second
 *     instance off it; the message is rendered once and stored, so a retry
 *     sends exactly the same payload with the same Idempotency-Key
 *     "dw-email-delivery-<id>" (Resend accepts it once). Only after the
 *     provider accepted it are the delivery and its notifications marked
 *     sent (emailSentAt). A transient failure leaves it pending for the next
 *     run; a permanent failure, MAX_ATTEMPTS failures or 23 h (the key
 *     window is 24 h) marks it failed. A notification belongs to at most one
 *     delivery, so it is never e-mailed twice;
 *  3. write the EmailChannelStatus row (configured, limit, last error) that
 *     the backend shows on the Alerts page, also after a failed run.
 *
 * Logs and stored errors carry masked addresses only.
 */
import { renderDigest, renderConfirmation } from "./render.js";
import { maskEmail, scrubText } from "./mask.js";

export const LOCK_KEY = 74_030_001; // pg advisory lock id of the claim transaction
export const NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // older notifications are never e-mailed
export const DELIVERY_MAX_AGE_MS = 23 * 60 * 60 * 1000; // Resend keeps idempotency keys 24 h
export const LEASE_MS = 3 * 60 * 1000; // a send takes at most the client timeout (15 s)
export const MAX_ATTEMPTS = 5;
export const DEBOUNCE_MS = 20 * 1000; // wait for the rest of a burst of messages
export const MAX_WAIT_MS = 2 * 60 * 1000; // ...but not longer than this
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;
export const CONFIRM_RESEND_MS = 60 * 60 * 1000; // a new opt-in re-sends the confirmation at most hourly

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * Deliveries counted against the daily limit in the last 24 h: sent, pending,
 * and failed ones that were attempted (a timed-out send may have been accepted).
 * The backend's services/emailChannel.js counts the same way.
 */
const COUNTED = `("status" IN ('sent', 'pending') OR ("status" = 'failed' AND "attempts" > 0))
  AND COALESCE("sentAt", "lastAttemptAt", "createdAt") > $1`;

export function createEmailDispatcher({ pool, config, sender, now = () => new Date(), log = console, debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS }) {
  const state = {
    lastRunAt: null,
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    sentLast24h: null,
    pending: null,
    lastRun: null, // { claimed, confirmations, sent, failed, retrying, cancelled, skippedDailyLimit }
  };
  let running = null;
  let again = false;
  let timer = null;
  let firstScheduledAt = 0;

  const setError = (message) => {
    state.lastError = scrubText(message);
    state.lastErrorAt = now().toISOString();
  };

  /** One transaction on one connection (also through a transaction-mode pooler). */
  async function tx(fn) {
    const db = await pool.connect();
    try {
      await db.query("BEGIN");
      const out = await fn(db);
      await db.query("COMMIT");
      return out;
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      db.release();
    }
  }

  async function countRecent(db, t) {
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM "EmailDelivery" WHERE ${COUNTED}`, [new Date(t.getTime() - WINDOW_MS)]);
    return rows[0].n;
  }

  /** Step 1. */
  function claim(t) {
    return tx(async (db) => {
      const out = { claimed: 0, confirmations: 0, skippedDailyLimit: 0 };
      await db.query("SELECT pg_advisory_xact_lock($1)", [LOCK_KEY]);
      let used = await countRecent(db, t);

      // confirmation links first: one per opt-in of an unconfirmed address (re-sent at most hourly)
      const { rows: unconfirmed } = await db.query(
        `SELECT "id" FROM "User"
          WHERE "emailAlertsEnabled" = true AND "disabledAt" IS NULL AND "emailVerifiedAt" IS NULL
            AND "emailConfirmToken" IS NOT NULL AND "emailAlertsConsentAt" IS NOT NULL
            AND ("emailConfirmSentAt" IS NULL OR ("emailConfirmSentAt" < "emailAlertsConsentAt" AND "emailConfirmSentAt" < $1))
          ORDER BY "id"
          FOR UPDATE`,
        [new Date(t.getTime() - CONFIRM_RESEND_MS)]
      );
      for (const { id: userId } of unconfirmed) {
        if (used >= config.dailyLimit) break; // tried again on a later run
        await db.query(`INSERT INTO "EmailDelivery" ("userId", "kind", "status", "notificationCount", "createdAt") VALUES ($1, 'confirm', 'pending', 0, $2)`, [userId, t]);
        await db.query(`UPDATE "User" SET "emailConfirmSentAt" = $2 WHERE "id" = $1`, [userId, t]);
        used += 1;
        out.confirmations += 1;
      }

      const { rows } = await db.query(
        `SELECT n."id", n."userId"
           FROM "Notification" n
           JOIN "User" u ON u."id" = n."userId"
          WHERE n."emailSentAt" IS NULL AND n."emailDeliveryId" IS NULL AND n."emailSkipReason" IS NULL
            AND n."createdAt" > $1
            AND u."emailAlertsEnabled" = true AND u."disabledAt" IS NULL AND u."emailVerifiedAt" IS NOT NULL
            AND u."emailAlertsConsentAt" IS NOT NULL AND n."createdAt" >= u."emailAlertsConsentAt"
            AND NOT EXISTS (SELECT 1 FROM "EmailDelivery" d WHERE d."userId" = n."userId" AND d."kind" = 'digest' AND d."status" = 'pending')
          ORDER BY n."id"
          FOR UPDATE OF n`,
        [new Date(t.getTime() - NOTIFICATION_MAX_AGE_MS)]
      );
      const byUser = new Map();
      for (const r of rows) {
        if (!byUser.has(r.userId)) byUser.set(r.userId, []);
        byUser.get(r.userId).push(r.id);
      }
      for (const [userId, ids] of byUser) {
        if (used >= config.dailyLimit) {
          await db.query(`UPDATE "Notification" SET "emailSkipReason" = 'daily-limit' WHERE "id" = ANY($1::int[])`, [ids]);
          out.skippedDailyLimit += ids.length;
          continue;
        }
        const { rows: created } = await db.query(
          `INSERT INTO "EmailDelivery" ("userId", "kind", "status", "notificationCount", "createdAt") VALUES ($1, 'digest', 'pending', $2, $3) RETURNING "id"`,
          [userId, ids.length, t]
        );
        await db.query(`UPDATE "Notification" SET "emailDeliveryId" = $1 WHERE "id" = ANY($2::int[]) AND "emailDeliveryId" IS NULL`, [created[0].id, ids]);
        used += 1;
        out.claimed += 1;
      }
      if (out.skippedDailyLimit) log.warn(`[email] daily limit (${config.dailyLimit}) reached: ${out.skippedDailyLimit} notification(s) stay in-app only`);
      return out;
    });
  }

  function finish(id, status, skipReason, error) {
    return tx(async (db) => {
      await db.query(`UPDATE "EmailDelivery" SET "status" = $2, "leaseUntil" = NULL, "lastError" = COALESCE($3, "lastError") WHERE "id" = $1`, [id, status, error]);
      await db.query(`UPDATE "Notification" SET "emailSkipReason" = $2 WHERE "emailDeliveryId" = $1 AND "emailSentAt" IS NULL`, [id, skipReason]);
    });
  }

  /** The message of a delivery, rendered from the database; null when there is nothing to send any more. */
  async function render(d) {
    if (d.kind === "confirm") {
      if (d.emailVerifiedAt || !d.emailConfirmToken) return null;
      return renderConfirmation({ appUrl: config.appUrl, confirmUrl: `${config.appUrl}/confirm-email?token=${encodeURIComponent(d.emailConfirmToken)}` });
    }
    if (!d.emailVerifiedAt) return null;
    const { rows: notifications } = await pool.query(
      `SELECT n."eventId", n."title", n."type", n."severity", n."lat", n."lng", n."distanceKm", n."occurredAt", n."subscriptionId",
              s."label" AS "subscriptionLabel", s."type" AS "subscriptionType", s."minSeverity" AS "subscriptionMinSeverity",
              s."radiusKm" AS "subscriptionRadiusKm", ie."locationPrecision"
         FROM "Notification" n
         LEFT JOIN "AlertSubscription" s ON s."id" = n."subscriptionId"
         LEFT JOIN "IngestedEvent" ie ON ie."eventId" = n."eventId"
        WHERE n."emailDeliveryId" = $1
        ORDER BY n."occurredAt" DESC, n."id" DESC`,
      [d.id]
    );
    if (!notifications.length) return null;
    const token = encodeURIComponent(d.emailUnsubscribeToken);
    const message = renderDigest({ notifications, appUrl: config.appUrl, unsubscribeUrl: `${config.appUrl}/unsubscribe?token=${token}` });
    return {
      ...message,
      headers: {
        // RFC 8058 one-click unsubscribe: the mail client POSTs to this URL
        "List-Unsubscribe": `<${config.appUrl}/api/email/unsubscribe?token=${token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    };
  }

  /** Step 2 for one delivery -> "sent" | "failed" | "retrying" | "cancelled" | "busy" */
  async function deliver(d, t) {
    const { rowCount } = await pool.query(
      `UPDATE "EmailDelivery" SET "leaseUntil" = $2 WHERE "id" = $1 AND "status" = 'pending' AND ("leaseUntil" IS NULL OR "leaseUntil" < $3)`,
      [d.id, new Date(t.getTime() + LEASE_MS), t]
    );
    if (!rowCount) return "busy"; // another instance is sending it

    if (t.getTime() - new Date(d.createdAt).getTime() > DELIVERY_MAX_AGE_MS) {
      await finish(d.id, "failed", "send-failed", "not sent within 23 hours");
      return "failed";
    }
    if (!d.emailAlertsEnabled || d.disabledAt || !d.emailUnsubscribeToken) {
      await finish(d.id, "cancelled", "disabled", null);
      return "cancelled";
    }
    let payload = d.payload;
    if (!payload) {
      payload = await render(d);
      if (!payload) {
        await finish(d.id, "cancelled", "disabled", null);
        return "cancelled";
      }
      // stored before the first attempt: a retry sends the identical message under the same key
      await pool.query(`UPDATE "EmailDelivery" SET "payload" = $2 WHERE "id" = $1`, [d.id, payload]);
    }

    const to = maskEmail(d.email);
    try {
      const { id: messageId } = await sender.send({ from: config.from, to: d.email, ...payload, idempotencyKey: `dw-email-delivery-${d.id}` });
      await tx(async (db) => {
        await db.query(
          `UPDATE "EmailDelivery" SET "status" = 'sent', "sentAt" = $2, "lastAttemptAt" = $2, "attempts" = "attempts" + 1,
                  "providerMessageId" = $3, "lastError" = NULL, "leaseUntil" = NULL WHERE "id" = $1`,
          [d.id, t, messageId]
        );
        await db.query(`UPDATE "Notification" SET "emailSentAt" = $2 WHERE "emailDeliveryId" = $1`, [d.id, t]);
      });
      state.lastSentAt = t.toISOString();
      log.log(`[email] delivery ${d.id} (${d.kind}${d.kind === "digest" ? `, ${d.notificationCount} alert(s)` : ""}) sent to ${to}`);
      return "sent";
    } catch (err) {
      if (err?.name !== "EmailSendError") throw err; // stays pending: the retry reuses the key and the payload
      setError(err.message);
      const attempts = d.attempts + 1;
      const giveUp = !err.transient || attempts >= MAX_ATTEMPTS;
      await pool.query(`UPDATE "EmailDelivery" SET "attempts" = $2, "lastAttemptAt" = $3, "lastError" = $4, "leaseUntil" = NULL WHERE "id" = $1`, [d.id, attempts, t, scrubText(err.message)]);
      if (giveUp) await finish(d.id, "failed", "send-failed", null);
      log.warn(`[email] delivery ${d.id} to ${to}: ${scrubText(err.message)}${giveUp ? " (given up)" : " (retried next run)"}`);
      return giveUp ? "failed" : "retrying";
    }
  }

  async function writeStatus(t) {
    await pool.query(
      `INSERT INTO "EmailChannelStatus" ("id", "configured", "dailyLimit", "updatedAt", "lastSentAt", "lastError", "lastErrorAt")
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT ("id") DO UPDATE SET "configured" = EXCLUDED."configured", "dailyLimit" = EXCLUDED."dailyLimit",
         "updatedAt" = EXCLUDED."updatedAt", "lastSentAt" = COALESCE(EXCLUDED."lastSentAt", "EmailChannelStatus"."lastSentAt"),
         "lastError" = EXCLUDED."lastError", "lastErrorAt" = EXCLUDED."lastErrorAt"`,
      [config.configured, config.dailyLimit, t, state.lastSentAt ? new Date(state.lastSentAt) : null, state.lastError, state.lastErrorAt ? new Date(state.lastErrorAt) : null]
    );
  }

  async function run() {
    const t = now();
    const result = { claimed: 0, confirmations: 0, sent: 0, failed: 0, retrying: 0, cancelled: 0, busy: 0, skippedDailyLimit: 0 };
    try {
      if (!state.lastRunAt) {
        // first run after a (re)start: keep the last error and send time the previous process wrote
        const { rows } = await pool.query(`SELECT "lastSentAt", "lastError", "lastErrorAt" FROM "EmailChannelStatus" WHERE "id" = 1`);
        if (rows[0]) {
          state.lastSentAt ??= rows[0].lastSentAt?.toISOString() ?? null;
          state.lastError ??= rows[0].lastError;
          state.lastErrorAt ??= rows[0].lastErrorAt?.toISOString() ?? null;
        }
      }
      if (config.configured) {
        Object.assign(result, await claim(t));
        const { rows: pending } = await pool.query(
          `SELECT d."id", d."kind", d."attempts", d."createdAt", d."notificationCount", d."payload",
                  u."email", u."emailAlertsEnabled", u."disabledAt", u."emailUnsubscribeToken", u."emailVerifiedAt", u."emailConfirmToken"
             FROM "EmailDelivery" d JOIN "User" u ON u."id" = d."userId"
            WHERE d."status" = 'pending' ORDER BY d."id"`
        );
        for (const d of pending) {
          try {
            result[await deliver(d, t)] += 1;
          } catch (err) {
            // a database error for one delivery: it stays pending (its lease expires), the others go on
            setError(err?.message || String(err));
            log.error(`[email] delivery ${d.id} failed, retried next run:`, state.lastError);
            result.retrying += 1;
          }
        }
        if (result.sent && !result.failed && !result.retrying) {
          state.lastError = null;
          state.lastErrorAt = null;
        }
        state.sentLast24h = await countRecent(pool, t);
        const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "EmailDelivery" WHERE "status" = 'pending'`);
        state.pending = rows[0].n;
      }
    } catch (err) {
      setError(err?.message || String(err));
      log.error("[email] run failed:", state.lastError);
      result.error = state.lastError;
    }
    try {
      await writeStatus(t);
    } catch (err) {
      log.error("[email] status row not written:", scrubText(err?.message || String(err)));
    }
    state.lastRunAt = t.toISOString();
    state.lastRun = result;
    return result;
  }

  /** One run; concurrent calls join it (and trigger one more run afterwards). Never throws. */
  function runOnce() {
    if (running) {
      again = true;
      return running;
    }
    running = run().finally(() => {
      running = null;
      if (again) {
        again = false;
        schedule(0);
      }
    });
    return running;
  }

  /** Called after new notifications: runs once the burst is over (debounced, at most maxWaitMs late). */
  function schedule(delay = debounceMs) {
    if (!config.configured) return;
    const t = Date.now();
    if (timer) {
      if (t - firstScheduledAt >= maxWaitMs) return; // let the pending timer fire
      clearTimeout(timer);
    } else {
      firstScheduledAt = t;
    }
    timer = setTimeout(() => {
      timer = null;
      runOnce();
    }, delay);
    timer.unref?.();
  }

  /** For /health: counts and times only, never an address. */
  function status() {
    return {
      configured: config.configured,
      missing: config.missing,
      dailyLimit: config.dailyLimit,
      sentLast24h: state.sentLast24h,
      limitReached: state.sentLast24h !== null && state.sentLast24h >= config.dailyLimit,
      pending: state.pending,
      lastRunAt: state.lastRunAt,
      lastRun: state.lastRun,
      lastSentAt: state.lastSentAt,
      lastError: state.lastError,
      lastErrorAt: state.lastErrorAt,
    };
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { runOnce, schedule, status, stop };
}
