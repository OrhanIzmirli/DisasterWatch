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

// Managed Kafka providers require SASL over TLS. When no credentials are set
// (local docker-compose), connect over plaintext as before.
const { KAFKA_SASL_USERNAME, KAFKA_SASL_PASSWORD } = process.env;
const useSasl = Boolean(KAFKA_SASL_USERNAME && KAFKA_SASL_PASSWORD);

// Optional CA certificate (PEM) for providers that use a private CA, e.g. Aiven.
// Escaped "\n" sequences are accepted so the value can be stored on one line.
const sslCa = process.env.KAFKA_SSL_CA?.replace(/\\n/g, "\n");

const kafka = new Kafka({
  clientId: "disasterwatch-backend",
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

export const producer = kafka.producer();

export async function initProducer() {
  await producer.connect();
  console.log(
    `Kafka producer connected (${useSasl ? "SASL_SSL" : "plaintext"}): ${brokers.join(", ")}`
  );
}

export async function publishDisasterEvent(event) {
  await producer.send({
    topic: "disaster-events",
    messages: [{ value: JSON.stringify(event) }],
  });
}
