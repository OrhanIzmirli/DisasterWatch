/**
 * Public e-mail endpoints (no sign-in): the unsubscribe link of every alert
 * e-mail, and the double opt-in confirmation link.
 *
 *   POST /email/confirm  { token }  -> 200: the address is confirmed, alert
 *        e-mails may now go to it; 404: unknown or already used token;
 *        403: the address is on ADMIN_EMAILS and the request does not carry
 *        that account's session (a confirmed listed address is an admin, so
 *        whoever registered it must prove the password too: otherwise someone
 *        who registered the owner's address first gets admin when the owner
 *        clicks the link in their own inbox)
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
import { EMAIL_TOKEN } from "../services/emailChannel.js";
import { isAdminEmail } from "../utils/adminEmails.js";
import { sessionUserId } from "../middleware/auth.middleware.js";

// RFC 8058 one-click posts come from a few mailbox-provider servers: the limit is per client IP,
// so it is generous (the tokens are 256-bit random, so it is not what protects them)
/** The token as a plain string; arrays and objects (?token=a&token=b, JSON) are not tokens. */
const asToken = (...values) => {
  const v = values.find((x) => x !== undefined && x !== null);
  return typeof v === "string" ? v : "";
};

export function createEmailRouter({ limit = { windowMs: 15 * 60 * 1000, limit: 300 } } = {}) {
  const router = express.Router();
  if (limit) {
    router.use(rateLimit({ windowMs: limit.windowMs, limit: limit.limit, standardHeaders: "draft-7", legacyHeaders: false, message: { message: "Too many requests" } }));
  }

  router.post("/unsubscribe", express.urlencoded({ extended: false, limit: "1kb" }), async (req, res) => {
    const token = asToken(req.query.token, req.body?.token);
    if (!EMAIL_TOKEN.test(token)) return res.status(404).json({ message: "This unsubscribe link is not valid." });
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

  router.post("/confirm", async (req, res) => {
    const token = asToken(req.body?.token);
    if (!EMAIL_TOKEN.test(token)) return res.status(404).json({ message: "This confirmation link is not valid or was already used." });
    try {
      const owner = await prisma.user.findUnique({ where: { emailConfirmToken: token }, select: { id: true, email: true } });
      if (!owner) return res.status(404).json({ message: "This confirmation link is not valid or was already used." });
      const signedIn = (await sessionUserId(req)) === owner.id;
      if (isAdminEmail(owner.email) && !signedIn) {
        return res.status(403).json({
          message: "This address needs one more step: sign in to the account that asked for these e-mails, then open the link again.",
        });
      }
      // the token in the condition: a second press, or a new token issued meanwhile, changes nothing
      const result = await prisma.user.updateMany({
        where: { id: owner.id, emailConfirmToken: token },
        // signed in to this account: password and mailbox proven together (needed for admin, see utils/adminEmails.js)
        data: { emailVerifiedAt: new Date(), emailConfirmToken: null, ...(signedIn ? { emailConfirmedSignedInAt: new Date() } : {}) },
      });
      if (result.count === 0) return res.status(404).json({ message: "This confirmation link is not valid or was already used." });
      res.json({ ok: true, message: "Your address is confirmed." });
    } catch (err) {
      console.error("EMAIL CONFIRM ERROR:", err?.message || err);
      res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}
