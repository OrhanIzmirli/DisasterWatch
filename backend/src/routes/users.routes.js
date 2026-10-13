import express from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import rateLimit from "express-rate-limit";
import prisma from "../prisma.js";
import { signAccessToken } from "../utils/jwt.js";
import { requireAuth } from "../middleware/auth.middleware.js";

const router = express.Router();

const COOKIE_NAME = process.env.COOKIE_NAME || "dw_session";

// Brute-force protection for credential endpoints: 10 attempts per IP per 15 minutes
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { message: "Too many attempts. Please try again in 15 minutes." },
});

const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000,
  path: "/",
};

const credentialsSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email({ message: "Invalid email address." })),
  password: z.string().min(8, { message: "Password must be at least 8 characters." }),
});

function publicUser(user) {
  return { email: user.email, role: user.role };
}

function setSessionCookie(res, user) {
  const token = signAccessToken({ id: user.id, email: user.email, role: user.role });
  res.cookie(COOKIE_NAME, token, cookieOptions);
}

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

    // The very first account becomes the admin; everyone after that is a regular user.
    const userCount = await prisma.user.count();
    const role = userCount === 0 ? "admin" : "user";

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
    const user = await prisma.user.findUnique({ where: { email } });

    // Same message whether the email or the password is wrong (no account enumeration)
    const passwordOk = user ? await bcrypt.compare(password, user.password) : false;
    if (!user || !passwordOk) {
      return res.status(401).json({ message: "Invalid email or password." });
    }

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
  res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
  res.json({ ok: true });
});

/* ===========================
   GET /users/me
=========================== */
router.get("/me", requireAuth, (req, res) => {
  res.json({ user: { email: req.user.email, role: req.user.role } });
});

export default router;
