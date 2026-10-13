import "dotenv/config";
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";

import eventsRoutes from "./routes/events.routes.js";
import disasterRoutes from "./routes/disaster.routes.js";
import newsRoutes from "./routes/news.routes.js";
import usersRoutes from "./routes/users.routes.js";
import alertsRoutes from "./routes/alerts.routes.js";

import { initProducer, producer } from "./services/kafkaProducer.js";

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
  res.json({ ok: true, service: "backend", time: new Date().toISOString() });
});

// Kafka publish test endpoint
app.use("/events", eventsRoutes);

// Disasters API
app.use("/disasters", disasterRoutes);

// News API (frontend /api/news -> backend /news)
app.use("/news", newsRoutes);

// Auth / users API (frontend /api/users -> backend /users)
app.use("/users", usersRoutes);

// Alert subscriptions (frontend /api/alerts -> backend /alerts)
app.use("/alerts", alertsRoutes);

// Hosting platforms provide PORT; docker-compose sets it to 5000
const PORT = Number(process.env.PORT) || 5000;

// Start the HTTP server right away so health checks pass
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on port ${PORT}`);
});

// Connect the Kafka producer in the background; a failure must not stop the server
initProducer()
  .then(() => {
    console.log("Kafka producer initialized");
  })
  .catch((err) => {
    console.error("Kafka init failed (ignored for demo):", err?.message || err);
  });

// Graceful shutdown
process.on("SIGTERM", async () => {
  try {
    await producer.disconnect();
  } catch {}
  process.exit(0);
});

process.on("SIGINT", async () => {
  try {
    await producer.disconnect();
  } catch {}
  process.exit(0);
});
