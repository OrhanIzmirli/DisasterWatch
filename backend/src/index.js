import express from "express";
import cors from "cors";

import eventsRoutes from "./routes/events.routes.js";
import disasterRoutes from "./routes/disaster.routes.js";
import newsRoutes from "./routes/news.routes.js";

import { initProducer, producer } from "./services/kafkaProducer.js";

const app = express();

app.use(cors());
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
