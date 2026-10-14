import express from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import { corsOptions, parseCorsOrigins } from "./utils/corsOrigins.js";

import eventsRoutes from "./routes/events.routes.js";
import disasterRoutes from "./routes/disaster.routes.js";
import newsRoutes from "./routes/news.routes.js";
import { newsService } from "./services/news.service.js";
import { createUsersRouter } from "./routes/users.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import adminRoutes from "./routes/admin.routes.js";
import { producerStatus } from "./services/kafkaProducer.js";
import { countPendingOutbox } from "./jobs/ingest.js";

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
 */
export function createApp(options = {}) {
  const app = express();

  // Render / other reverse proxies sit in front of the app: trust the first hop so
  // req.ip (used by the rate limiter) and secure cookies see the real client.
  app.set("trust proxy", 1);
  app.disable("x-powered-by");

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

  // Allow-listed origins only (CORS_ORIGINS, see utils/corsOrigins.js); never "*".
  app.use(cors(corsOptions(parseCorsOrigins(options.corsOrigins ?? process.env.CORS_ORIGINS))));
  app.use(cookieParser());
  app.use(express.json({ limit: "100kb" }));

  app.get("/", (req, res) => {
    res.send("DisasterWatch Backend is running");
  });

  // Compact news-cache status for /health: which provider served it, when, and whether it is stale.
  const newsStatus = () => {
    const s = newsService.status();
    return { provider: s.provider, updatedAt: s.updatedAt, stale: s.stale, articles: s.articles };
  };

  app.get("/health", async (req, res) => {
    // Events recorded but not yet published to Kafka (null when the DB is unreachable)
    let outboxPending = null;
    try {
      outboxPending = await countPendingOutbox();
    } catch {
      outboxPending = null;
    }
    res.json({
      ok: true,
      service: "backend",
      kafka: producerStatus(),
      outboxPending,
      news: newsStatus(),
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
