import http from "node:http";
import { Kafka } from "kafkajs";
import { TOPIC } from "./src/contract.js";
import { createPool, loadActiveSubscriptions, insertNotifications } from "./src/db.js";
import { createMessageHandler } from "./src/handler.js";

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

// ---- state surfaced on /health ----
let kafkaConnected = false;
let dbStatus = "connecting";
const stats = {
  processed: 0, // messages that passed validation and were matched
  invalid: 0, // messages skipped because they violate the contract
  notificationsCreated: 0,
  lastProcessedAt: null,
  lastEventId: null,
  lastError: null,
};

// ---- database + handler ----
const pool = createPool();

pool.on("error", (err) => {
  dbStatus = "error";
  stats.lastError = err?.message || String(err);
  console.error("[db] pool error:", err?.message || err);
});

const handleMessage = createMessageHandler({
  loadSubscriptions: () => loadActiveSubscriptions(pool),
  insertNotifications: (rows) => insertNotifications(pool, rows),
});

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
        db: dbStatus,
        processedCount: stats.processed,
        invalidCount: stats.invalid,
        notificationsCreated: stats.notificationsCreated,
        lastProcessedAt: stats.lastProcessedAt,
        lastEventId: stats.lastEventId,
        lastError: stats.lastError,
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

  try {
    await pool.query("SELECT 1");
    dbStatus = "connected";
    console.log("Database connection OK");
  } catch (err) {
    dbStatus = "error";
    stats.lastError = err?.message || String(err);
    console.error("Database connection failed (will retry per message):", err?.message || err);
  }

  await consumer.connect();
  await consumer.subscribe({ topic: TOPIC, fromBeginning: true });
  kafkaConnected = true;

  console.log(`Notification service listening on topic: ${TOPIC}`);
  console.log(
    `Connected to Kafka broker(s) (${useSasl ? "SASL_SSL" : "plaintext"}):`,
    brokers.join(", ")
  );

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString() ?? "";
      try {
        const result = await handleMessage(value);
        if (result.status === "invalid") {
          stats.invalid += 1;
          return;
        }
        stats.processed += 1;
        stats.notificationsCreated += result.inserted;
        stats.lastProcessedAt = new Date().toISOString();
        stats.lastEventId = result.eventId;
        dbStatus = "connected";
      } catch (err) {
        // Database (or other infrastructure) failure: rethrow so KafkaJS
        // retries the message instead of silently dropping it.
        stats.lastError = err?.message || String(err);
        dbStatus = "error";
        console.error("[consumer] processing failed, will retry:", err?.message || err);
        throw err;
      }
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
  try {
    await pool.end();
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
