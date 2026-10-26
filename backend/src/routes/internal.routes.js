/**
 * Internal endpoints called by the scheduled wake-up (GitHub Actions
 * .github/workflows/wake.yml, every few hours in practice), not by the frontend.
 *
 *   POST /internal/ingest   Authorization: Bearer <INGEST_WAKE_SECRET>
 *     -> 200 { ok, ran, reason, lastRunAt, stats }
 *
 *     -> 202 { ok: null, ran: null, reason: "in-progress", lastRunAt, stats: null }
 *        when the run is still going after WAKE_WAIT_MS (follow it on /health -> ingest)
 *
 * The free Render plan puts the backend to sleep after ~15 minutes without
 * traffic; while it sleeps nothing is ingested or published. The scheduled call
 * wakes it (the start-up run ingests) and, when it was already awake, runs
 * an ingestion now. It is idempotent: a run that finished in the last
 * WAKE_MIN_INTERVAL_MS without errors is not repeated, a run in progress is
 * joined. `ok` is false when any part of the run failed.
 *
 * The answer never waits longer than WAKE_WAIT_MS (Kafka readiness and the
 * run together): a caller's request timeout must not fail only because a
 * run is slow (after a long sleep GDACS lookups can take minutes), and a
 * timed-out call would be retried against the same run. After the wait the
 * endpoint answers 202 and the run goes on; /health -> ingest.running and
 * ingest.lastErrorSources tell how it ended.
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
export const READY_TIMEOUT_MS = 45 * 1000;
/** The answer is sent after this long at the latest (202 when the run is still going); below the callers' request timeouts. */
export const WAKE_WAIT_MS = 60 * 1000;

/** Resolves with the promise's value, or with `fallback` after `ms` (the promise goes on; a rejection counts as `fallback`). */
function within(promise, ms, fallback) {
  let timer;
  const late = new Promise((resolve) => (timer = setTimeout(() => resolve(fallback), Math.max(0, ms))));
  return Promise.race([Promise.resolve(promise).catch(() => fallback), late]).finally(() => clearTimeout(timer));
}

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
  waitMs = WAKE_WAIT_MS,
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

    const startedAt = Date.now();
    const remaining = () => waitMs - (Date.now() - startedAt);
    // a cold-started service: let the first Kafka connection attempt finish (bounded) so this run can publish
    await within(ready(), Math.min(readyTimeoutMs, remaining()), null);

    // the run itself is not bounded; this answer is (the run continues, the next call joins it)
    const result = await within(runner.wake(), remaining(), null);
    if (!result) {
      return res.status(202).json({ ok: null, ran: null, reason: "in-progress", lastRunAt: runner.status().lastRunAt, stats: null });
    }
    const s = result.last?.stats;
    res.json({
      // false when the run failed or any part of it did (a source fetch, the Kafka publish): the workflow fails on it
      ok: !result.last?.error && !(s?.errors?.length),
      ran: result.ran,
      reason: result.reason,
      lastRunAt: result.last?.at ? new Date(result.last.at).toISOString() : null,
      stats: s ? { fetched: s.fetched, inserted: s.inserted, eonetFallback: s.eonetFallback ?? 0, published: s.published, pending: s.pending, errors: s.errors.length } : null,
    });
  });

  return router;
}
