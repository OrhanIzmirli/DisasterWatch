import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import eventsRoutes from "./routes/events.routes.js";
import disasterRoutes from "./routes/disaster.routes.js";
import newsRoutes from "./routes/news.routes.js";
import { createUsersRouter } from "./routes/users.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";
import notificationsRoutes from "./routes/notifications.routes.js";
import { producerStatus } from "./services/kafkaProducer.js";

/**
 * Build the Express app without starting a server or touching Kafka,
 * so it can be mounted by index.js in production and by supertest in tests.
 *
 * @param {object} [options]
 * @param {false | { windowMs?: number, limit?: number }} [options.authRateLimit]
 *   Rate limit for /users/login and /users/register. Defaults to the
 *   production setting; pass `false` to disable it (tests only).
 */
export function createApp(options = {}) {
  const app = express();

  // Render / other reverse proxies sit in front of the app: trust the first hop so
  // req.ip (used by the rate limiter) and secure cookies see the real client.
  app.set("trust proxy", 1);

  app.use(cors());
  app.use(cookieParser());
  app.use(express.json());

  app.get("/", (req, res) => {
    res.send("DisasterWatch Backend is running");
  });

  app.get("/health", (req, res) => {
    res.json({
      ok: true,
      service: "backend",
      kafka: producerStatus(),
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

  return app;
}

const app = createApp();

export default app;
