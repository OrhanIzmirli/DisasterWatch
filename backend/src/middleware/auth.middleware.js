import prisma from "../prisma.js";
import { verifyAccessToken } from "../utils/jwt.js";
import { COOKIE_NAME, clearSessionCookie } from "../utils/session.js";
import { roleFor } from "../utils/adminEmails.js";

/**
 * Signed-in users only. The token is only the lookup key: the user is
 * re-read from the database on every request, so
 *   - a deleted account,
 *   - a disabled account (disabledAt set), or
 *   - a token issued before the account's tokenVersion was bumped
 * all get 401 and a cleared cookie immediately. The role is worked out on
 * every request from ADMIN_EMAILS and the confirmed address (roleFor), so a
 * stored or token role never outlives a change to either.
 */
export async function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) {
    return res.status(401).json({ message: "Not authenticated" });
  }

  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    clearSessionCookie(res);
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  const id = Number(decoded?.id);
  if (!Number.isInteger(id)) {
    clearSessionCookie(res);
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  try {
    const user = await prisma.user.findUnique({
      where: { id },
      select: { id: true, email: true, emailConfirmedSignedInAt: true, disabledAt: true, tokenVersion: true },
    });

    const tokenVersion = Number(decoded.tokenVersion ?? 0);
    if (!user || user.disabledAt || user.tokenVersion !== tokenVersion) {
      clearSessionCookie(res);
      return res.status(401).json({ message: "Not authenticated" });
    }

    req.user = { id: user.id, email: user.email, role: roleFor(user) };
    next();
  } catch (err) {
    console.error("AUTH ERROR:", err?.message || err);
    return res.status(500).json({ message: "Server error" });
  }
}

/**
 * The id of the signed-in user behind the request's session cookie, or null
 * (no cookie, bad or old token, deleted or disabled account). For routes that
 * work without a session but must know whose session it is when there is one.
 */
export async function sessionUserId(req) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return null;
  let decoded;
  try {
    decoded = verifyAccessToken(token);
  } catch {
    return null;
  }
  const id = Number(decoded?.id);
  if (!Number.isInteger(id)) return null;
  const user = await prisma.user.findUnique({ where: { id }, select: { disabledAt: true, tokenVersion: true } });
  if (!user || user.disabledAt || user.tokenVersion !== Number(decoded.tokenVersion ?? 0)) return null;
  return id;
}

/** Admins only; always used after requireAuth, so the role is the current one. */
export function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}
