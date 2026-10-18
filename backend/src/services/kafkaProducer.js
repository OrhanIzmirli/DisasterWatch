import { Kafka } from "kafkajs";

// Comma-separated list, e.g. "broker-1:9092,broker-2:9092"
const brokers = (
  process.env.KAFKA_BROKER ||
  process.env.KAFKA_BROKERS ||
  process.env.KAFKA_BOOTSTRAP_SERVERS ||
  "redpanda:9092"
)
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
  clientId: "disasterwatch-backend",
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

export const producer = kafka.producer();

let connected = false;
producer.on(producer.events.CONNECT, () => {
  connected = true;
});
producer.on(producer.events.DISCONNECT, () => {
  connected = false;
});

/** "connected" | "disconnected" | "misconfigured" — surfaced on /health. */
export function producerStatus() {
  if (kafkaConfigError) return "misconfigured";
  return connected ? "connected" : "disconnected";
}

let settleReady;
/**
 * Resolves once the first initProducer() attempt has finished, connected or
 * not, so the wake endpoint can let a cold-started service connect to Kafka
 * before it ingests and publishes.
 */
export const producerReady = new Promise((resolve) => {
  settleReady = resolve;
});

export async function initProducer() {
  try {
    if (kafkaConfigError) throw new Error(kafkaConfigError);
    await producer.connect();
    connected = true;
    console.log(
      `Kafka producer connected (${useSasl ? "SASL_SSL" : "plaintext"}): ${brokers.join(", ")}`
    );
  } finally {
    settleReady();
  }
}

const TOPIC = "disaster-events";

export async function publishDisasterEvent(event) {
  return publishDisasterEvents([event]);
}

/** Publishes contract events in one batch, keyed by eventId for per-event ordering. */
export async function publishDisasterEvents(events) {
  if (kafkaConfigError) throw new Error(kafkaConfigError);
  if (!Array.isArray(events) || events.length === 0) return;
  await producer.send({
    topic: TOPIC,
    messages: events.map((event) => ({
      key: event?.eventId ? String(event.eventId) : undefined,
      value: JSON.stringify(event),
    })),
  });
}
