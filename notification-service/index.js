import http from "node:http";
import { Kafka } from "kafkajs";

const broker =
  process.env.KAFKA_BROKER ||
  process.env.KAFKA_BROKERS ||
  process.env.KAFKA_BOOTSTRAP_SERVERS ||
  "dw-kafka:9092"; // docker-compose service name

const brokers = broker
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Managed Kafka providers require SASL over TLS. When no credentials are set
// (local docker-compose), connect over plaintext as before.
const { KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD } = process.env;
const useSasl = Boolean(KAFKA_SASL_USERNAME && KAFKA_SASL_PASSWORD);

// Optional CA certificate (PEM) for providers that use a private CA, e.g. Aiven.
// Escaped "\n" sequences are accepted so the value can be stored on one line.
const sslCa = process.env.KAFKA_SSL_CA?.replace(/\\n/g, "\n");

const kafka = new Kafka({
  clientId: "notification-service",
  brokers,
  ...(useSasl && {
    ssl: sslCa ? { ca: [sslCa] } : true,
    sasl: {
      mechanism: process.env.KAFKA_SASL_MECHANISM || "scram-sha-256",
      username: KAFKA_SASL_USERNAME,
      password: KAFKA_SASL_PASSWORD,
    },
  }),
});

const consumer = kafka.consumer({ groupId: "disaster-group" });

let kafkaConnected = false;

// Minimal HTTP server so hosting platforms can health-check the service.
const PORT = Number(process.env.PORT) || 3000;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        ok: true,
        service: "notification-service",
        kafka: kafkaConnected ? "connected" : "connecting",
        time: new Date().toISOString(),
      })
    );
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: "Not found" }));
});

server.listen(PORT, () => {
  console.log(`Health server listening on port ${PORT}`);
});

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topic: "disaster-events", fromBeginning: true });
  kafkaConnected = true;

  console.log("Notification service listening on topic: disaster-events");
  console.log(
    `Connected to Kafka broker(s) (${useSasl ? "SASL_SSL" : "plaintext"}):`,
    brokers.join(", ")
  );

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString() ?? "";
      console.log("EVENT RECEIVED:", value);
    },
  });
}

start().catch((err) => {
  console.error("Notification service failed:", err);
  process.exit(1);
});

async function shutdown() {
  server.close();
  try {
    await consumer.disconnect();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
