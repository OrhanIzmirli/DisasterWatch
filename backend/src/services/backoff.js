/**
 * Exponential backoff with jitter for an external API.
 *
 * After a failure the gate closes for baseMs * 2^(failures-1), capped at
 * maxMs, with +/- jitter so several instances never retry in lockstep. Calls
 * made while the gate is closed are rejected immediately (no request is
 * sent), which is what "no immediate retry after a 429" means in practice.
 * A success reopens the gate and resets the counter.
 *
 * `now` and `random` are injectable for tests.
 */

export const DEFAULT_BASE_MS = 30_000;
export const DEFAULT_MAX_MS = 15 * 60_000;
export const DEFAULT_JITTER = 0.25; // +/- 25 %

export class BackoffError extends Error {
  constructor(message, retryInMs) {
    super(message);
    this.name = "BackoffError";
    this.kind = "backoff";
    this.retryInMs = retryInMs;
  }
}

export function createBackoffGate({
  name = "api",
  baseMs = DEFAULT_BASE_MS,
  maxMs = DEFAULT_MAX_MS,
  jitter = DEFAULT_JITTER,
  now = Date.now,
  random = Math.random,
} = {}) {
  let failures = 0;
  let closedUntil = 0;

  /** Milliseconds until the gate reopens; 0 when open. */
  function retryInMs() {
    return Math.max(0, closedUntil - now());
  }

  /** Throws BackoffError when the gate is closed. */
  function check() {
    const wait = retryInMs();
    if (wait > 0) {
      throw new BackoffError(
        `${name} backing off for ${Math.ceil(wait / 1000)} s after ${failures} consecutive failure(s)`,
        wait
      );
    }
  }

  function failure() {
    failures += 1;
    const exp = Math.min(maxMs, baseMs * 2 ** (failures - 1));
    const spread = exp * jitter;
    const delay = Math.round(exp - spread + random() * 2 * spread);
    closedUntil = now() + delay;
    return delay;
  }

  function success() {
    failures = 0;
    closedUntil = 0;
  }

  /** Runs fn through the gate: rejects while closed, records the outcome. */
  async function run(fn) {
    check();
    try {
      const result = await fn();
      success();
      return result;
    } catch (err) {
      if (!(err instanceof BackoffError)) failure();
      throw err;
    }
  }

  return { check, failure, success, run, retryInMs, get failures() { return failures; } };
}
