/**
 * Internal endpoints called by the scheduled wake-up (GitHub Actions,
 * .github/workflows/wake.yml), not by the frontend.
 *
 *   POST /internal/ingest   Authorization: Bearer <INGEST_WAKE_SECRET>
 *     -> 200 { ok, ran, reason, lastRunAt, stats }
 *
 * The free Render plan puts the backend to sleep after ~15 minutes without
 * traffic; while it sleeps nothing is ingested or published. The hourly call
 * wakes it (the start-up run ingests) and, when it was already awake, runs
 * an ingestion now. It is idempotent: a run that finished in the last
 * WAKE_MIN_INTERVAL_MS is not repeated, a run in progress is joined.
 *
 * Protection: a shared secret (INGEST_WAKE_SECRET, at least 32 characters)
 * compared in constant time, and a rate limit per client. Without a usable
 * secret the endpoint does not exist (404). Responses carry counts only,
 * never the secret or upstream error details.
 */
import crypto from "node:crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { ingestRunner } from "../jobs/ingest.js";
import { producerReady } from "../services/kafkaProducer.js";

export const MIN_SECRET_LENGTH = 32;
export const WAKE_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };
/** How long a cold-started service may wait for its first Kafka connection attempt before ingesting. */
export const READY_TIMEOUT_MS = 20 * 1000;

/** Constant-time comparison of two strings of any length (both hashed to 32 bytes first). */
export function secretsEqual(given, expected) {
  const a = crypto.createHash("sha256").update(String(given ?? "")).digest();
  const b = crypto.createHash("sha256").update(String(expected ?? "")).digest();
  return crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const m = /^Bearer\s+(.+)$/i.exec(String(req.get("authorization") ?? ""));
  return m ? m[1].trim() : null;
}

export function createInternalRouter({
  secret = process.env.INGEST_WAKE_SECRET,
  runner = ingestRunner,
  ready = () => producerReady,
  readyTimeoutMs = READY_TIMEOUT_MS,
  limit = WAKE_RATE_LIMIT,
  log = console,
} = {}) {
  const router = express.Router();
  const expected = String(secret ?? "").trim();
  const enabled = expected.length >= MIN_SECRET_LENGTH;
  if (!enabled && expected) log.warn(`[wake] INGEST_WAKE_SECRET is shorter than ${MIN_SECRET_LENGTH} characters; /internal/ingest is disabled`);

  if (limit) {
    router.use(
      rateLimit({
        windowMs: limit.windowMs,
        limit: limit.limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { message: "Too many requests" },
      })
    );
  }

  router.post("/ingest", async (req, res) => {
    if (!enabled) return res.status(404).json({ message: "Not found: POST /internal/ingest" });
    const given = bearer(req);
    if (!given || !secretsEqual(given, expected)) return res.status(401).json({ message: "Unauthorized" });

    // a cold-started service: let the first Kafka connection attempt finish (bounded) so this run can publish
    let timer;
    await Promise.race([Promise.resolve(ready()).catch(() => {}), new Promise((r) => (timer = setTimeout(r, readyTimeoutMs)))]);
    clearTimeout(timer);

    const result = await runner.wake();
    const s = result.last?.stats;
    res.json({
      ok: !result.last?.error,
      ran: result.ran,
      reason: result.reason,
      lastRunAt: result.last?.at ? new Date(result.last.at).toISOString() : null,
      stats: s ? { fetched: s.fetched, inserted: s.inserted, published: s.published, pending: s.pending, errors: s.errors.length } : null,
    });
  });

  return router;
}
