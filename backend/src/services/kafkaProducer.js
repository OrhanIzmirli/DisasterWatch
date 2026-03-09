import { Kafka } from "kafkajs";

const kafka = new Kafka({
  clientId: "disasterwatch-backend",
  brokers: [process.env.KAFKA_BROKER || "redpanda:9092"],
});

export const producer = kafka.producer();

export async function initProducer() {
  await producer.connect();
  console.log("✅ Kafka producer connected");
}

export async function publishDisasterEvent(event) {
  await producer.send({
    topic: "disaster-events",
    messages: [{ value: JSON.stringify(event) }],
  });
}
