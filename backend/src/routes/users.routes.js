import express from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { roleForEmail } from "../utils/adminEmails.js";
import { setSessionCookie, clearSessionCookie } from "../utils/session.js";

// Brute-force protection for credential endpoints: 10 attempts per IP per 15 minutes
const DEFAULT_AUTH_RATE_LIMIT = { windowMs: 15 * 60 * 1000, limit: 10 };

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: "Invalid email address." })),
  password: z.string().min(8, { message: "Password must be at least 8 characters." }),
});

const withSubscriptionCount = { _count: { select: { subscriptions: true } } };

function publicUser(user) {
  return {
    email: user.email,
    role: user.role,
    createdAt: user.createdAt,
    subscriptionCount: user._count?.subscriptions ?? 0,
  };
}

/**
 * Build the /users router.
 *
 * @param {object} [options]
 * @param {false | { windowMs?: number, limit?: number }} [options.authRateLimit]
 *   Rate limit applied to /login and /register. Defaults to production
 *   settings; `false` disables it (used by tests that need many sign-ins).
 */
export function createUsersRouter(options = {}) {
  const router = express.Router();

  const rateLimitConfig =
    options.authRateLimit === false
      ? null
      : { ...DEFAULT_AUTH_RATE_LIMIT, ...(options.authRateLimit || {}) };

  const authLimiter = rateLimitConfig
    ? rateLimit({
        windowMs: rateLimitConfig.windowMs,
        limit: rateLimitConfig.limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        message: { message: "Too many attempts. Please try again in 15 minutes." },
      })
    : (req, res, next) => next();

  /* ===========================
     POST /users/register
  =========================== */
  router.post("/register", authLimiter, async (req, res) => {
    const parsed = credentialsSchema.safeParse(req.body);
    if (!parsed.success) {
      const message = parsed.error.issues[0]?.message || "Invalid input";
      return res.status(400).json({ message });
    }

    const { email, password } = parsed.data;

    try {
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        return res.status(409).json({ message: "Email is already registered." });
      }

      const passwordHash = await bcrypt.hash(password, 10);

      // Role comes from the ADMIN_EMAILS env list; everyone else is a regular user.
      const role = roleForEmail(email);

      const user = await prisma.user.create({
        data: { email, password: passwordHash, role },
      });

      setSessionCookie(res, user);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      // Unique constraint race (two registrations with the same email at once)
      if (err?.code === "P2002") {
        return res.status(409).json({ message: "Email is already registered." });
      }
      console.error("REGISTER ERROR:", err?.message || err);
      res.status(500).json({ message: "Server error" });
    }
  });

  /* ===========================
     POST /users/login
  =========================== */
  router.post("/login", authLimiter, async (req, res) => {
    const parsed = z
      .object({
        email: z.string().trim().toLowerCase().min(1),
        password: z.string().min(1),
      })
      .safeParse(req.body);

    if (!parsed.success) {
      return res.status(400).json({ message: "Email and password are required." });
    }

    const { email, password } = parsed.data;

    try {
      let user = await prisma.user.findUnique({
        where: { email },
        include: withSubscriptionCount,
      });

      // Same message whether the email or the password is wrong (no account enumeration)
      const passwordOk = user ? await bcrypt.compare(password, user.password) : false;
      if (!user || !passwordOk) {
        return res.status(401).json({ message: "Invalid email or password." });
      }

      // A suspended account cannot sign in, even with the right password.
      if (user.disabledAt) {
        return res.status(403).json({ message: "Account disabled" });
      }

      // Keep the stored role in sync with ADMIN_EMAILS (promote if listed,
      // demote if not) and record the sign-in.
      user = await prisma.user.update({
        where: { id: user.id },
        data: { role: roleForEmail(user.email), lastLoginAt: new Date() },
        include: withSubscriptionCount,
      });

      setSessionCookie(res, user);
      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error("LOGIN ERROR:", err?.message || err);
      res.status(500).json({ message: "Server error" });
    }
  });

  /* ===========================
     POST /users/logout
  =========================== */
  router.post("/logout", (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  /* ===========================
     GET /users/me
  =========================== */
  router.get("/me", requireAuth, async (req, res) => {
    try {
      // Read from the DB rather than the token so role changes take effect immediately
      const user = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: {
          email: true,
          role: true,
          createdAt: true,
          _count: { select: { subscriptions: true } },
        },
      });

      if (!user) {
        clearSessionCookie(res);
        return res.status(401).json({ message: "Not authenticated" });
      }

      res.json({ user: publicUser(user) });
    } catch (err) {
      console.error("ME ERROR:", err?.message || err);
      res.status(500).json({ message: "Server error" });
    }
  });

  return router;
}

const router = createUsersRouter();

export default router;
