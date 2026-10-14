/**
 * Session cookie helpers shared by the users routes and the auth middleware.
 *
 * The JWT carries the user's id, e-mail, role and `tokenVersion`. The
 * middleware re-checks the user in the database on every request, so a
 * disabled or deleted account, or a bumped tokenVersion, ends every session
 * immediately instead of when the 24 h token expires.
 */
import { signAccessToken } from "./jwt.js";

export const COOKIE_NAME = process.env.COOKIE_NAME || "dw_session";

export const cookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  maxAge: 24 * 60 * 60 * 1000,
  path: "/",
};

export function setSessionCookie(res, user) {
  const token = signAccessToken({
    id: user.id,
    email: user.email,
    role: user.role,
    tokenVersion: user.tokenVersion ?? 0,
  });
  res.cookie(COOKIE_NAME, token, cookieOptions);
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: undefined });
}
