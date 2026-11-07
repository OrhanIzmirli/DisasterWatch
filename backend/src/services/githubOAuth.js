/**
 * GitHub OAuth (web application flow with PKCE) for public API keys.
 *
 * No scopes are requested: the authorization only lets us read the public
 * profile, of which we keep the numeric id and the login. The access token is
 * used for that single GET /user and then dropped (never stored or logged).
 *
 * Configuration (backend environment; never committed):
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET   the OAuth app's credentials
 *   GITHUB_OAUTH_REDIRECT_URI                optional; defaults to the live site's callback
 */
import crypto from "node:crypto";

export const DEFAULT_REDIRECT_URI = "https://disasterwatch-frontend.onrender.com/api/v1/auth/github/callback";
const AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USER_URL = "https://api.github.com/user";
const TIMEOUT_MS = 10_000;

export function readGithubConfig(env = process.env) {
  const clientId = (env.GITHUB_CLIENT_ID || "").trim();
  const clientSecret = (env.GITHUB_CLIENT_SECRET || "").trim();
  return {
    enabled: Boolean(clientId && clientSecret),
    clientId,
    clientSecret,
    redirectUri: (env.GITHUB_OAUTH_REDIRECT_URI || "").trim() || DEFAULT_REDIRECT_URI,
  };
}

/** state and PKCE verifier for one sign-in attempt. */
export function newAttempt() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  return {
    state: crypto.randomBytes(24).toString("base64url"),
    verifier,
    challenge: crypto.createHash("sha256").update(verifier).digest("base64url"),
  };
}

export function authorizeUrl(config, attempt) {
  const u = new URL(AUTHORIZE_URL);
  u.searchParams.set("client_id", config.clientId);
  u.searchParams.set("redirect_uri", config.redirectUri);
  u.searchParams.set("state", attempt.state);
  u.searchParams.set("code_challenge", attempt.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  u.searchParams.set("scope", "");
  return u.toString();
}

export class GithubError extends Error {
  constructor(message) {
    super(message);
    this.name = "GithubError";
  }
}

async function fetchJson(fetchImpl, url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, { ...init, signal: controller.signal });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new GithubError(`GitHub answered ${res.status}`);
    return body;
  } catch (err) {
    if (err instanceof GithubError) throw err;
    throw new GithubError(err?.name === "AbortError" ? "GitHub did not answer in time" : "GitHub could not be reached");
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Code -> { githubId, login }. The access token stays inside this function.
 * Throws GithubError with a message that never contains a token or secret.
 */
export async function exchangeCode(config, { code, verifier }, fetchImpl = fetch) {
  const token = await fetchJson(fetchImpl, TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: config.redirectUri, code_verifier: verifier }),
  });
  const accessToken = typeof token?.access_token === "string" ? token.access_token : null;
  if (!accessToken) throw new GithubError(`GitHub refused the code${token?.error ? ` (${String(token.error).slice(0, 40)})` : ""}`);
  const user = await fetchJson(fetchImpl, USER_URL, {
    headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${accessToken}`, "User-Agent": "DisasterWatch", "X-GitHub-Api-Version": "2022-11-28" },
  });
  if (!Number.isSafeInteger(user?.id) || typeof user?.login !== "string") throw new GithubError("GitHub returned no user");
  return { githubId: String(user.id), login: user.login.slice(0, 39) };
}
