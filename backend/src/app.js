import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { corsOptions, parseCorsOrigins } from "./utils/corsOrigins.js";
import { useClientIp } from "./utils/clientIp.js";

import eventsRoutes from "./routes/events.routes.js";
import disasterRoutes from "./routes/disaster.routes.js";
import newsRoutes from "./routes/news.routes.js";
import { newsService } from "./services/news.service.js";
import { createUsersRouter } from "./routes/users.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { producerStatus } from "./services/kafkaProducer.js";
import { countPendingOutbox, ingestRunner } from "./jobs/ingest.js";
import { createInternalRouter } from "./routes/internal.routes.js";
import { gdacsClient } from "./services/gdacs.js";
import { createEmailRouter } from "./routes/email.routes.js";
import { emailChannelStatus } from "./services/emailChannel.js";
import { createV1Router } from "./routes/v1.routes.js";
import { createDeveloperRouters } from "./routes/developer.routes.js";

/**
 * Build the Express app without starting a server or touching Kafka,
 * so it can be mounted by index.js in production and by supertest in tests.
 *
 * @param {object} [options]
 * @param {false | { windowMs?: number, limit?: number }} [options.authRateLimit]
 *   Rate limit for /users/login and /users/register. Defaults to the
 *   production setting; pass `false` to disable it (tests only).
 * @param {string} [options.corsOrigins] comma-separated allowed origins
 *   (defaults to CORS_ORIGINS from the environment, else the built-in list).
 * @param {object} [options.internal] options for the scheduled-wake router
 *   (routes/internal.routes.js); defaults read INGEST_WAKE_SECRET.
 * @param {false | { windowMs?: number, limit?: number }} [options.v1RateLimit]
 *   Per-IP limit of the public API v1 (default 60/min); `false` disables it (tests only).
 * @param {false | { windowMs?: number, limit?: number }} [options.developerRateLimit]
 *   Limit of the GitHub sign-in and key routes (default 30/min); `false` disables it (tests only).
 * @param {object} [options.developer] overrides for createDeveloperRouters (env, fetch, prisma, keyStore; tests)
 */
export function createApp(options = {}) {
  const app = express();

  // Render's proxies sit in front of the app: trust the first hop so secure cookies
  // see https. The client address comes from Cloudflare's headers (utils/clientIp.js):
  // with several hops, req.ip alone is an internal address that changes per request.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(useClientIp);

  // Security headers for a JSON API that is served behind the frontend's /api
  // proxy: no framing, no sniffing, a CSP that allows nothing to load (the API
  // never serves HTML or scripts), HSTS left to the edge (Render/Cloudflare).
  app.use(
    helmet({
      contentSecurityPolicy: { directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] } },
      crossOriginResourcePolicy: { policy: "same-site" },
      hsts: false,
    })
  );

  // Public read-only API v1: its own CORS (any origin, GET only, no credentials) and rate limit.
  // /api/v1 is the documented path; the site's /api/* rewrite delivers it here as /v1.
  // GitHub sign-in and key management (POST/DELETE, cookies, no CORS) come first: the v1
  // router answers every other method with 405.
  const developer = createDeveloperRouters({ rateLimit: options.developerRateLimit, ...(options.developer || {}) });
  app.use(["/v1/auth", "/api/v1/auth"], cookieParser(), developer.auth);
  app.use(["/v1/developer", "/api/v1/developer"], cookieParser(), developer.developer);
  const v1 = createV1Router({ rateLimit: options.v1RateLimit });
  app.use("/v1", v1);
  app.use("/api/v1", v1);

  // Allow-listed origins only (CORS_ORIGINS, see utils/corsOrigins.js); never "*".
  app.use(cors(corsOptions(parseCorsOrigins(options.corsOrigins ?? process.env.CORS_ORIGINS))));
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));

  app.get("/", (req, res) => {
    res.send("DisasterWatch Backend is running");
  });

  // Compact news-cache status for /health: which providers served it, when, whether it is stale,
  // and per provider what happened on its last attempt (so a silent GDELT failure is visible).
  const newsStatus = () => {
    const s = newsService.status();
    return { provider: s.provider, updatedAt: s.updatedAt, stale: s.stale, articles: s.articles, providers: s.providers, storms: s.storms };
  };

  app.get("/health", async (req, res) => {
    // Events recorded but not yet published to Kafka (null when the DB is unreachable)
    let outboxPending = null;
    try {
      outboxPending = await countPendingOutbox();
    } catch {
      outboxPending = null;
    }
    // e-mail alert channel as the notification-service last reported it (counts, times, masked error; no addresses)
    let email = null;
    try {
      email = await emailChannelStatus();
    } catch {
      email = null;
    }
    res.json({
      ok: true,
      service: "backend",
      kafka: producerStatus(),
      outboxPending,
      // last ingestion run and last scheduled wake-up (counts and times only)
      ingest: ingestRunner.status(),
      news: newsStatus(),
      gdacs: gdacsClient.status(),
      email,
      time: new Date().toISOString(),
    });
  });

  // Kafka publish test endpoint
  app.use("/events", eventsRoutes);

  // Disasters API
  app.use("/disasters", disasterRoutes);

  // News API (frontend /api/news -> backend /news)
  app.use("/news", newsRoutes);

  // Auth / users API (frontend /api/users -> backend /users)
  app.use("/users", createUsersRouter({ authRateLimit: options.authRateLimit }));

  // Alert subscriptions (frontend /api/alerts -> backend /alerts)
  app.use("/alerts", alertsRoutes);

  // In-app notifications (frontend /api/notifications -> backend /notifications)
  app.use("/notifications", notificationsRoutes);

  // Admin console: user management and audit log (frontend /api/admin -> backend /admin)
  app.use("/admin", adminRoutes);

  // E-mail unsubscribe links (public, token-based; frontend /api/email -> backend /email)
  app.use("/email", createEmailRouter(options.email));

  // Scheduled wake-up (external cron + GitHub Actions backup): POST /internal/ingest with a shared secret
  app.use("/internal", createInternalRouter(options.internal));

  // Unknown routes and every error, including body-parser failures, answer JSON: never Express's HTML pages.
  app.use((req, res) => {
    res.status(404).json({ message: `Not found: ${req.method} ${req.path}` });
  });
  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err?.type === "entity.parse.failed") return res.status(400).json({ message: "Malformed JSON body" });
    if (err?.type === "entity.too.large") return res.status(413).json({ message: "Request body too large" });
    if (err?.type === "charset.unsupported" || err?.type === "encoding.unsupported") return res.status(415).json({ message: "Unsupported body encoding" });
    const status = Number.isInteger(err?.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) console.error("UNHANDLED ERROR:", err);
    res.status(status).json({ message: status >= 500 ? "Server error" : err?.message || "Request failed" });
  });

  return app;
}

const app = createApp();

export default app;
