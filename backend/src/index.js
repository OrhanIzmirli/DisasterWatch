import "dotenv/config";

import app from "./app.js";
import { initProducer, producer } from "./services/kafkaProducer.js";

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
