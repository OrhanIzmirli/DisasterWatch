/**
 * E-mail digests for new notifications (opt-in per user).
 *
 * A run (after a burst of new notifications, and every few minutes for
 * retries) does, holding a Postgres advisory lock so two instances never
 * run at once:
 *
 *  1. claim, in one transaction: every notification of the last 24 h that
 *     has no e-mail yet and whose user turned e-mail alerts on before it was
 *     created is put into ONE "pending" EmailDelivery per user. The daily
 *     limit is counted from EmailDelivery (rolling 24 h, sent + pending), not
 *     from memory: the service sleeps and restarts. Over the limit the
 *     notifications are marked emailSkipReason = "daily-limit" (the in-app
 *     notification exists anyway) and are not e-mailed later;
 *  2. send every pending delivery with the Idempotency-Key
 *     "dw-email-delivery-<id>"; only after the provider accepted it are the
 *     delivery and its notifications marked sent (emailSentAt). A transient
 *     failure leaves it pending for the next run (same key, so a send that
 *     did go out is not repeated); a permanent failure, MAX_ATTEMPTS
 *     failures or a delivery older than 23 h (the key window is 24 h) marks
 *     it failed. A notification belongs to at most one delivery, so it is
 *     never e-mailed twice;
 *  3. write the EmailChannelStatus row (configured, limit, last error) that
 *     the backend shows on the Alerts page.
 *
 * Logs and stored errors carry masked addresses only.
 */
import { renderDigest } from "./render.js";
import { maskEmail, scrubText } from "./mask.js";

export const LOCK_KEY = 74_030_001; // pg advisory lock id of the e-mail run
export const NOTIFICATION_MAX_AGE_MS = 24 * 60 * 60 * 1000; // older notifications are never e-mailed
export const DELIVERY_MAX_AGE_MS = 23 * 60 * 60 * 1000; // Resend keeps idempotency keys 24 h
export const MAX_ATTEMPTS = 5;
export const DEBOUNCE_MS = 20 * 1000; // wait for the rest of a burst of messages
export const MAX_WAIT_MS = 2 * 60 * 1000; // ...but not longer than this
export const RETRY_INTERVAL_MS = 10 * 60 * 1000;

const WINDOW_MS = 24 * 60 * 60 * 1000;

export function createEmailDispatcher({ pool, config, sender, now = () => new Date(), log = console, debounceMs = DEBOUNCE_MS, maxWaitMs = MAX_WAIT_MS }) {
  const state = {
    lastRunAt: null,
    lastSentAt: null,
    lastError: null,
    lastErrorAt: null,
    sentLast24h: null,
    pending: null,
    lastRun: null, // { claimed, sent, failed, retrying, skippedDailyLimit }
  };
  let running = null;
  let again = false;
  let timer = null;
  let firstScheduledAt = 0;

  const setError = (message) => {
    state.lastError = scrubText(message);
    state.lastErrorAt = now().toISOString();
  };

  async function countRecent(db, t) {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM "EmailDelivery"
        WHERE "status" IN ('sent', 'pending') AND COALESCE("sentAt", "createdAt") > $1`,
      [new Date(t.getTime() - WINDOW_MS)]
    );
    return rows[0].n;
  }

  /** Step 1: one pending delivery per user, within the daily limit. */
  async function claim(db, t) {
    const out = { claimed: 0, skippedDailyLimit: 0 };
    await db.query("BEGIN");
    try {
      let used = await countRecent(db, t);
      const { rows } = await db.query(
        `SELECT n."id", n."userId"
           FROM "Notification" n
           JOIN "User" u ON u."id" = n."userId"
          WHERE n."emailSentAt" IS NULL AND n."emailDeliveryId" IS NULL AND n."emailSkipReason" IS NULL
            AND n."createdAt" > $1
            AND u."emailAlertsEnabled" = true AND u."disabledAt" IS NULL
            AND u."emailAlertsConsentAt" IS NOT NULL AND n."createdAt" >= u."emailAlertsConsentAt"
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
          `INSERT INTO "EmailDelivery" ("userId", "status", "notificationCount", "createdAt") VALUES ($1, 'pending', $2, $3) RETURNING "id"`,
          [userId, ids.length, t]
        );
        await db.query(`UPDATE "Notification" SET "emailDeliveryId" = $1 WHERE "id" = ANY($2::int[]) AND "emailDeliveryId" IS NULL`, [created[0].id, ids]);
        used += 1;
        out.claimed += 1;
      }
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    }
    if (out.skippedDailyLimit) log.warn(`[email] daily limit (${config.dailyLimit}) reached: ${out.skippedDailyLimit} notification(s) stay in-app only`);
    return out;
  }

  async function finish(db, id, status, skipReason, error) {
    await db.query("BEGIN");
    try {
      await db.query(`UPDATE "EmailDelivery" SET "status" = $2, "lastError" = COALESCE($3, "lastError") WHERE "id" = $1`, [id, status, error]);
      await db.query(`UPDATE "Notification" SET "emailSkipReason" = $2 WHERE "emailDeliveryId" = $1 AND "emailSentAt" IS NULL`, [id, skipReason]);
      await db.query("COMMIT");
    } catch (err) {
      await db.query("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  /** Step 2 for one delivery -> "sent" | "failed" | "retrying" | "cancelled" */
  async function sendDelivery(db, d, t) {
    if (t.getTime() - new Date(d.createdAt).getTime() > DELIVERY_MAX_AGE_MS) {
      await finish(db, d.id, "failed", "send-failed", "not sent within 23 hours");
      return "failed";
    }
    if (!d.emailAlertsEnabled || d.disabledAt || !d.emailUnsubscribeToken) {
      await finish(db, d.id, "cancelled", "disabled", null);
      return "cancelled";
    }
    const { rows: notifications } = await db.query(
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
    if (!notifications.length) {
      await finish(db, d.id, "cancelled", "disabled", null);
      return "cancelled";
    }

    const token = encodeURIComponent(d.emailUnsubscribeToken);
    const unsubscribeUrl = `${config.appUrl}/unsubscribe?token=${token}`;
    const { subject, text, html } = renderDigest({ notifications, appUrl: config.appUrl, unsubscribeUrl });
    const to = maskEmail(d.email);
    try {
      const { id: messageId } = await sender.send({
        from: config.from,
        to: d.email,
        subject,
        text,
        html,
        headers: {
          // RFC 8058 one-click unsubscribe: the mail client POSTs to this URL
          "List-Unsubscribe": `<${config.appUrl}/api/email/unsubscribe?token=${token}>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
        idempotencyKey: `dw-email-delivery-${d.id}`,
      });
      await db.query("BEGIN");
      try {
        await db.query(
          `UPDATE "EmailDelivery" SET "status" = 'sent', "sentAt" = $2, "lastAttemptAt" = $2, "attempts" = "attempts" + 1,
                  "providerMessageId" = $3, "lastError" = NULL WHERE "id" = $1`,
          [d.id, t, messageId]
        );
        await db.query(`UPDATE "Notification" SET "emailSentAt" = $2 WHERE "emailDeliveryId" = $1`, [d.id, t]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        throw err; // stays pending: the retry reuses the idempotency key, so no second e-mail
      }
      state.lastSentAt = t.toISOString();
      log.log(`[email] delivery ${d.id}: ${notifications.length} alert(s) sent to ${to}`);
      return "sent";
    } catch (err) {
      if (err?.name !== "EmailSendError") throw err;
      setError(err.message);
      const attempts = d.attempts + 1;
      const giveUp = !err.transient || attempts >= MAX_ATTEMPTS;
      await db.query(`UPDATE "EmailDelivery" SET "attempts" = $2, "lastAttemptAt" = $3, "lastError" = $4 WHERE "id" = $1`, [d.id, attempts, t, scrubText(err.message)]);
      if (giveUp) await finish(db, d.id, "failed", "send-failed", null);
      log.warn(`[email] delivery ${d.id} to ${to}: ${scrubText(err.message)}${giveUp ? " (given up)" : " (retried next run)"}`);
      return giveUp ? "failed" : "retrying";
    }
  }

  async function writeStatus(db, t) {
    await db.query(
      `INSERT INTO "EmailChannelStatus" ("id", "configured", "dailyLimit", "updatedAt", "lastSentAt", "lastError", "lastErrorAt")
       VALUES (1, $1, $2, $3, $4, $5, $6)
       ON CONFLICT ("id") DO UPDATE SET "configured" = EXCLUDED."configured", "dailyLimit" = EXCLUDED."dailyLimit",
         "updatedAt" = EXCLUDED."updatedAt", "lastSentAt" = COALESCE(EXCLUDED."lastSentAt", "EmailChannelStatus"."lastSentAt"),
         "lastError" = EXCLUDED."lastError", "lastErrorAt" = EXCLUDED."lastErrorAt"`,
      [config.configured, config.dailyLimit, t, state.lastSentAt ? new Date(state.lastSentAt) : null, state.lastError, state.lastErrorAt ? new Date(state.lastErrorAt) : null]
    );
  }

  async function runLocked(db) {
    const t = now();
    if (!state.lastRunAt) {
      // first run after a (re)start: keep the last error and send time the previous process wrote
      const { rows } = await db.query(`SELECT "lastSentAt", "lastError", "lastErrorAt" FROM "EmailChannelStatus" WHERE "id" = 1`);
      if (rows[0]) {
        state.lastSentAt ??= rows[0].lastSentAt?.toISOString() ?? null;
        state.lastError ??= rows[0].lastError;
        state.lastErrorAt ??= rows[0].lastErrorAt?.toISOString() ?? null;
      }
    }
    const result = { claimed: 0, sent: 0, failed: 0, retrying: 0, cancelled: 0, skippedDailyLimit: 0 };
    if (config.configured) {
      Object.assign(result, await claim(db, t));
      const { rows: pending } = await db.query(
        `SELECT d."id", d."attempts", d."createdAt", u."email", u."emailAlertsEnabled", u."disabledAt", u."emailUnsubscribeToken"
           FROM "EmailDelivery" d JOIN "User" u ON u."id" = d."userId"
          WHERE d."status" = 'pending' ORDER BY d."id"`
      );
      for (const d of pending) result[await sendDelivery(db, d, t)] += 1;
      if (result.sent && !result.failed && !result.retrying) {
        state.lastError = null;
        state.lastErrorAt = null;
      }
      state.sentLast24h = await countRecent(db, t);
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM "EmailDelivery" WHERE "status" = 'pending'`);
      state.pending = rows[0].n;
    }
    await writeStatus(db, t);
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
    running = (async () => {
      let db;
      try {
        db = await pool.connect();
        const { rows } = await db.query("SELECT pg_try_advisory_lock($1) AS ok", [LOCK_KEY]);
        if (!rows[0].ok) return { skipped: "locked" };
        try {
          return await runLocked(db);
        } finally {
          await db.query("SELECT pg_advisory_unlock($1)", [LOCK_KEY]).catch(() => {});
        }
      } catch (err) {
        setError(err?.message || String(err));
        log.error("[email] run failed:", state.lastError);
        return { error: state.lastError };
      } finally {
        db?.release();
        running = null;
        if (again) {
          again = false;
          schedule(0);
        }
      }
    })();
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
