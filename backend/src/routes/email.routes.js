/**
 * Public e-mail endpoints (no sign-in): the unsubscribe link of every alert
 * e-mail.
 *
 *   POST /email/unsubscribe?token=<token>   (RFC 8058 one-click: the mail
 *        client posts "List-Unsubscribe=One-Click" to the List-Unsubscribe URL)
 *   POST /email/unsubscribe  { token }      (the site's /unsubscribe page)
 *     -> 200 { ok: true }   e-mail alerts are off for that account (idempotent)
 *     -> 404                unknown token
 *
 * The token is unguessable (32 random bytes) and only switches e-mail alerts
 * off, so it needs no session. A GET never changes anything: link scanners
 * that prefetch URLs in e-mails cannot unsubscribe anyone.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import prisma from "../prisma.js";
import { UNSUBSCRIBE_TOKEN } from "../services/emailChannel.js";

export function createEmailRouter({ limit = { windowMs: 15 * 60 * 1000, limit: 30 } } = {}) {
  const router = express.Router();
  if (limit) {
    router.use(rateLimit({ windowMs: limit.windowMs, limit: limit.limit, standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many requests" } }));
  }

  router.post("/unsubscribe", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const token = String(req.query.token ?? req.body?.token ?? "");
    if (!UNSUBSCRIBE_TOKEN.test(token)) return res.status(404).json({ message: "This unsubscribe link is not valid." });
    try {
      const result = await prisma.user.updateMany({
        where: { emailUnsubscribeToken: token },
        data: { emailAlertsEnabled: false, emailAlertsConsentAt: null },
      });
      if (result.count === 0) return res.status(404).json({ message: "This unsubscribe link is not valid." });
      res.json({ ok: true, message: "You are unsubscribed from DisasterWatch e-mail alerts." });
    } catch (err) {
      console.error("UNSUBSCRIBE ERROR:", err?.message || err);
      res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}
