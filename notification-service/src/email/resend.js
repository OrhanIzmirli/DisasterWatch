/**
 * Minimal Resend client (POST https://api.resend.com/emails; no SDK).
 *
 * Every send carries an Idempotency-Key: a retry of the same digest (after a
 * timeout, or a crash between the send and marking it sent) is accepted by
 * Resend once only, within its 24 h key window.
 *
 * Errors are `EmailSendError { transient, status }`: network errors,
 * timeouts, 429, 5xx and 409 concurrent_idempotent_requests (the same key is
 * still being processed) are transient (retried next run); other 4xx (bad
 * sender, recipient not allowed in test mode, invalid key, a key reused with
 * another payload) are not.
 * Messages are scrubbed of e-mail addresses; the API key never appears.
 */
import { scrubText } from "./mask.js";

export const RESEND_URL = "https://api.resend.com/emails";
const TIMEOUT_MS = 15000;

export class EmailSendError extends Error {
  constructor(message, { transient, status = null } = {}) {
    super(scrubText(message));
    this.name = "EmailSendError";
    this.transient = Boolean(transient);
    this.status = status;
  }
}

export function createResendSender({ apiKey, fetchImpl = (...a) => fetch(...a), timeoutMs = TIMEOUT_MS } = {}) {
  /** -> { id } */
  async function send({ from, to, subject, text, html, headers = {}, idempotencyKey }) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(RESEND_URL, {
        method: "POST",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
        },
        body: JSON.stringify({ from, to: [to], subject, text, html, headers }),
      });
    } catch (err) {
      const msg = err?.name === "AbortError" ? `timeout after ${timeoutMs} ms` : err?.message || String(err);
      throw new EmailSendError(`Resend request failed: ${msg}`, { transient: true });
    } finally {
      clearTimeout(timer);
    }

    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (res.ok && body?.id) return { id: String(body.id) };
    const status = res.status;
    const detail = body?.message || body?.name || (res.ok ? "no message id in the answer" : "");
    const concurrent = status === 409 && body?.name === "concurrent_idempotent_requests";
    throw new EmailSendError(`Resend ${status}${detail ? `: ${detail}` : ""}`, { transient: status === 429 || status >= 500 || concurrent || res.ok, status });
  }

  return { send };
}
