import jwt from "jsonwebtoken";

const MIN_SECRET_LENGTH = 32;

function resolveJwtSecret() {
  const secret = process.env.JWT_SECRET;
  const isProduction = process.env.NODE_ENV === "production";

  let problem = null;
  if (!secret) {
    problem = "JWT_SECRET is not set";
  } else if (secret === "CHANGE_ME") {
    problem = 'JWT_SECRET is still the placeholder value "CHANGE_ME"';
  } else if (secret.length < MIN_SECRET_LENGTH) {
    problem = `JWT_SECRET is too short (${secret.length} chars, minimum ${MIN_SECRET_LENGTH})`;
  }

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
