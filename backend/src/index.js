import "dotenv/config";

import app from "./app.js";
import { newsService } from "./services/news.service.js";
import { initProducer, producer } from "./services/kafkaProducer.js";
import { startIngestion } from "./jobs/ingest.js";

// Hosting platforms provide PORT; docker-compose sets it to 5000
const PORT = Number(process.env.PORT) || 5000;

// Start the HTTP server right away so health checks pass
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Backend listening on port ${PORT}`);
});

// Background news refresh (GDELT every 15 minutes); requests only read its cache.
if (process.env.NODE_ENV !== "test" && process.env.DISABLE_NEWS_JOB !== "1") {
  newsService.start();
}

// Connect the Kafka producer in the background; a failure must not stop the server
initProducer()
  .then(() => {
    console.log("Kafka producer initialized");
  })
  .catch((err) => {
    console.error("Kafka init failed (ignored for demo):", err?.message || err);
  })
  .finally(() => {
    // Feed ingestion: NASA + USGS every 5 minutes, new events go to Kafka.
    // Started after the producer attempt so the first pass can publish; a
    // Kafka failure only loses publishing, ingestion itself keeps working.
    if (process.env.NODE_ENV !== "test" && process.env.DISABLE_INGESTION !== "1") {
      startIngestion();
    }
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
