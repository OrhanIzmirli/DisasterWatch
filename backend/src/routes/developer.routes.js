/**
 * Developer sign-in (GitHub OAuth) and API key management for the public API.
 * Mounted before the read-only v1 router (app.js), at /v1 and /api/v1:
 *
 *   GET    /auth/github             -> redirect to GitHub (state + PKCE in a 10-minute cookie)
 *   GET    /auth/github/callback    <- GitHub; signs the developer in, back to the /api page
 *   GET    /developer/session       { enabled, developer: { login, createdAt } | null, key: { prefix, createdAt, lastUsedAt } | null }
 *   POST   /developer/keys          201 { key, prefix, createdAt }: a new key, shown once; the previous one is revoked
 *   DELETE /developer/keys          204: revokes the active key
 *   POST   /developer/logout        204
 *   DELETE /developer/me            204: deletes the developer and every key
 *
 * The developer session is its own cookie (dw_dev, path /api/v1/developer), separate
 * from the site's account session. Writes need the X-DW-Request header (a cross-site
 * form cannot set it, and these routes send no CORS headers). Nothing here is cached.
 */
import express from "express";
import rateLimit from "express-rate-limit";
import crypto from "node:crypto";
import defaultPrisma from "../prisma.js";
import { keyStore as defaultKeyStore } from "../services/apiKeys.js";
import { authorizeUrl, exchangeCode, GithubError, newAttempt, readGithubConfig } from "../services/githubOAuth.js";
import { signToken, verifyAccessToken } from "../utils/jwt.js";

export const DEV_COOKIE = "dw_dev";
export const OAUTH_COOKIE = "dw_oauth";
export const DEV_SESSION_DAYS = 7;
export const DEVELOPER_RATE_LIMIT = { windowMs: 60 * 1000, limit: 30 };
const secure = process.env.NODE_ENV === "production";

/** Public paths of the site, from the callback URL: /api/v1/auth and /api/v1/developer. */
export function sitePaths(redirectUri) {
  const u = new URL(redirectUri);
  const auth = u.pathname.replace(/\/github\/callback$/, "");
  return { origin: u.origin, auth, developer: auth.replace(/\/auth$/, "/developer"), page: new URL("/api", u.origin).toString() };
}

function sameString(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

/**
 * @param {object} [options]
 * @param {Record<string, string | undefined>} [options.env]
 * @param {typeof fetch} [options.fetch] for the GitHub calls (tests)
 * @param {false | { windowMs?: number, limit?: number }} [options.rateLimit]
 */
export function createDeveloperRouters({ prisma = defaultPrisma, keyStore = defaultKeyStore, env = process.env, fetch: fetchImpl = fetch, rateLimit: limitOptions } = {}) {
  const config = readGithubConfig(env);
  const paths = sitePaths(config.redirectUri);
  const devCookie = { httpOnly: true, secure, sameSite: "lax", path: paths.developer, maxAge: DEV_SESSION_DAYS * 24 * 3600 * 1000 };
  const oauthCookie = { httpOnly: true, secure, sameSite: "lax", path: paths.auth, maxAge: 10 * 60 * 1000 };
  const backToPage = (res, outcome) => res.redirect(303, `${paths.page}?developer=${outcome}#developer`);

  const limiter =
    limitOptions === false
      ? (req, res, next) => next()
      : rateLimit({ ...DEVELOPER_RATE_LIMIT, ...(limitOptions || {}), standardHeaders: "draft-7", legacyHeaders: false, message: { error: { code: "rate_limited", message: "Too many requests" } } });

  const noStore = (req, res, next) => {
    res.set("Cache-Control", "no-store");
    next();
  };

  /* ---------------- GitHub sign-in ---------------- */
  const auth = express.Router();
  auth.use(limiter, noStore);

  auth.get("/github", (req, res) => {
    if (!config.enabled) return res.status(503).json({ error: { code: "not_configured", message: "GitHub sign-in is not set up on this server" } });
    const attempt = newAttempt();
    res.cookie(OAUTH_COOKIE, signToken({ s: attempt.state, v: attempt.verifier }, "10m"), oauthCookie);
    res.redirect(302, authorizeUrl(config, attempt));
  });

  auth.get("/github/callback", async (req, res) => {
    const raw = req.cookies?.[OAUTH_COOKIE];
    res.clearCookie(OAUTH_COOKIE, { ...oauthCookie, maxAge: undefined });
    if (!config.enabled) return backToPage(res, "error");
    if (req.query.error) return backToPage(res, "denied"); // the developer declined on GitHub
    let attempt;
    try {
      attempt = raw ? verifyAccessToken(raw) : null;
    } catch {
      attempt = null;
    }
    const { code, state } = req.query;
    if (!attempt || typeof code !== "string" || typeof state !== "string" || !sameString(state, attempt.s)) return backToPage(res, "expired");
    try {
      const user = await exchangeCode(config, { code, verifier: attempt.v }, fetchImpl);
      const developer = await prisma.apiDeveloper.upsert({
        where: { githubId: user.githubId },
        create: { githubId: user.githubId, githubLogin: user.login },
        update: { githubLogin: user.login, lastLoginAt: new Date() },
        select: { id: true },
      });
      res.cookie(DEV_COOKIE, signToken({ dev: developer.id, typ: "developer" }, `${DEV_SESSION_DAYS}d`), devCookie);
      return backToPage(res, "signed-in");
    } catch (err) {
      console.warn(`[developer] GitHub sign-in failed: ${err instanceof GithubError ? err.message : err?.name || "error"}`);
      return backToPage(res, "error");
    }
  });

  /* ---------------- developer session and keys ---------------- */
  const developer = express.Router();
  developer.use(limiter, noStore);

  /** The signed-in developer row or null (an unknown or deleted developer clears the cookie). */
  async function currentDeveloper(req, res) {
    const raw = req.cookies?.[DEV_COOKIE];
    if (!raw) return null;
    let claims;
    try {
      claims = verifyAccessToken(raw);
    } catch {
      claims = null;
    }
    const row = claims?.typ === "developer" && Number.isInteger(claims.dev) ? await prisma.apiDeveloper.findUnique({ where: { id: claims.dev }, select: { id: true, githubLogin: true, createdAt: true } }) : null;
    if (!row) res.clearCookie(DEV_COOKIE, { ...devCookie, maxAge: undefined });
    return row;
  }

  const requireDeveloper = async (req, res, next) => {
    if (req.method !== "GET" && req.get("X-DW-Request") !== "1") return res.status(403).json({ error: { code: "forbidden", message: "Missing X-DW-Request header" } });
    const dev = await currentDeveloper(req, res);
    if (!dev) return res.status(401).json({ error: { code: "not_signed_in", message: "Sign in with GitHub first" } });
    req.developer = dev;
    next();
  };

  developer.get("/session", async (req, res) => {
    const dev = await currentDeveloper(req, res);
    res.json({
      enabled: config.enabled,
      developer: dev ? { login: dev.githubLogin, createdAt: dev.createdAt } : null,
      key: dev ? await keyStore.active(dev.id) : null,
    });
  });

  developer.post("/keys", requireDeveloper, async (req, res) => {
    const issued = await keyStore.issue(req.developer.id);
    res.status(201).json(issued);
  });

  developer.delete("/keys", requireDeveloper, async (req, res) => {
    await keyStore.revoke(req.developer.id);
    res.status(204).end();
  });

  developer.post("/logout", (req, res) => {
    if (req.get("X-DW-Request") !== "1") return res.status(403).json({ error: { code: "forbidden", message: "Missing X-DW-Request header" } });
    res.clearCookie(DEV_COOKIE, { ...devCookie, maxAge: undefined });
    res.status(204).end();
  });

  developer.delete("/me", requireDeveloper, async (req, res) => {
    await keyStore.revoke(req.developer.id); // drops cached lookups before the rows go
    await prisma.apiDeveloper.delete({ where: { id: req.developer.id } });
    res.clearCookie(DEV_COOKIE, { ...devCookie, maxAge: undefined });
    res.status(204).end();
  });

  developer.use((req, res) => res.status(404).json({ error: { code: "not_found", message: "Not found" } }));
  auth.use((req, res) => res.status(404).json({ error: { code: "not_found", message: "Not found" } }));

  return { auth, developer, config };
}
