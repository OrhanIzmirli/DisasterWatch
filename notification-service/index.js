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

// Env values are trimmed so stray whitespace from copy-pasting is ignored.
const env = (name) => (process.env[name] ?? "").trim();

// Managed Kafka providers require SASL over TLS. When no credentials are set
// (local docker-compose), connect over plaintext as before.
const saslUsername = env("KAFKA_SASL_USERNAME");
const saslPassword = env("KAFKA_SASL_PASSWORD");
const useSasl = Boolean(saslUsername && saslPassword);

// Optional CA certificate (PEM) for providers that use a private CA, e.g. Aiven.
// Escaped "\n" sequences are accepted so the value can be stored on one line.
const sslCa = env("KAFKA_SSL_CA").replace(/\\n/g, "\n");

// Partial settings would fall back to plaintext against a broker that expects
// SASL_SSL, so they are reported as a configuration error instead.
const kafkaConfigError =
  !useSasl && (saslUsername || saslPassword || sslCa)
    ? "Kafka config error: KAFKA_SASL_USERNAME and KAFKA_SASL_PASSWORD must both be set to use SASL_SSL"
    : null;

const kafka = new Kafka({
  clientId: "notification-service",
  brokers,
  ...(useSasl && {
    ssl: sslCa ? { ca: [sslCa] } : true,
    sasl: {
      mechanism: env("KAFKA_SASL_MECHANISM") || "scram-sha-256",
      username: saslUsername,
      password: saslPassword,
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
  if (kafkaConfigError) throw new Error(kafkaConfigError);
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
