/**
 * Allowed browser origins for CORS.
 *
 * The frontend reaches the API through its own /api proxy (same origin), so
 * cookies never cross origins. Direct browser access is allowed only from the
 * origins in CORS_ORIGINS (comma-separated); the default covers the live
 * frontend and the local dev/preview servers. Requests without an Origin
 * header (same-origin proxy, curl, server-to-server) are not CORS requests
 * and always pass.
 */
export const DEFAULT_CORS_ORIGINS = [
  "https://disasterwatch-frontend.onrender.com",
  "http://localhost:8080",
  "http://localhost:5173",
  "http://localhost:4173",
];

export function parseCorsOrigins(value) {
  const list = String(value ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  return new Set(list.length ? list : DEFAULT_CORS_ORIGINS);
}

/** cors() options: echo the origin only when it is on the list; never a wildcard. */
export function corsOptions(allowed) {
  return {
    origin(origin, callback) {
      if (!origin) return callback(null, true); // not a cross-origin browser request
      callback(null, allowed.has(origin.replace(/\/+$/, "")));
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Accept"],
    maxAge: 600,
  };
}
