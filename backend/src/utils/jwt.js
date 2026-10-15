import jwt from "jsonwebtoken";

export const MIN_SECRET_LENGTH = 32;

/** The placeholder shipped in backend/.env.example (tests keep the two in sync). */
export const EXAMPLE_JWT_SECRET = "dev-only-change-me-0123456789abcdef0123456789";

/**
 * Returns a human-readable problem with the secret, or null when it is usable.
 * In production a placeholder of any kind is a problem: the example value is
 * public, so anyone could forge admin tokens with it.
 */
export function validateJwtSecret(secret, { isProduction }) {
  if (!secret) return "JWT_SECRET is not set";
  if (secret === "CHANGE_ME") return 'JWT_SECRET is still the placeholder value "CHANGE_ME"';
  if (secret.length < MIN_SECRET_LENGTH) {
    return `JWT_SECRET is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH})`;
  }
  if (isProduction) {
    if (secret === EXAMPLE_JWT_SECRET) {
      return "JWT_SECRET is the public placeholder from backend/.env.example";
    }
    if (/change[-_ ]?me/i.test(secret)) {
      return 'JWT_SECRET looks like a placeholder (contains "change me")';
    }
  }
  return null;
}

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";
  const problem = validateJwtSecret(secret, { isProduction });

  if (problem) {
    const hint =
      "Set a strong secret, e.g. generate one with: " +
      'node -e "console.log(require(\'crypto\').randomBytes(48).toString(\'base64\'))"';

    if (isProduction) {
      console.error(`FATAL: ${problem}. Refusing to start in production. ${hint}`);
      process.exit(1);
    }

    console.warn(`WARNING: ${problem}. This is only tolerated outside production. ${hint}`);
  }

  // Development fallback keeps the server usable when the secret is missing entirely
  return secret || "dev-only-insecure-jwt-secret";
}

const JWT_SECRET = resolveJwtSecret();

// Keep this aligned with the session cookie maxAge (24h) in users.routes.js
const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || "1d";

export function signAccessToken(payload) {
  return jwt.sign(payload, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });
}

export function verifyAccessToken(token) {
  return jwt.verify(token, JWT_SECRET);
}
