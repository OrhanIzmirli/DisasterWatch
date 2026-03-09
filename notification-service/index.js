import { Kafka } from "kafkajs";

const broker =
  process.env.KAFKA_BROKER ||
  process.env.KAFKA_BROKERS ||
  process.env.KAFKA_BOOTSTRAP_SERVERS ||
  "dw-kafka:9092"; // docker-compose servis adı

const kafka = new Kafka({
  clientId: "notification-service",
  brokers: broker.split(",").map((s) => s.trim()),
});

const consumer = kafka.consumer({ groupId: "disaster-group" });

async function start() {
  await consumer.connect();
  await consumer.subscribe({ topic: "disaster-events", fromBeginning: true });

  console.log("📡 Notification service listening on topic: disaster-events");
  console.log("✅ Connected to Kafka broker(s):", broker);

  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString() ?? "";
      console.log("🔥 EVENT RECEIVED:", value);
    },
  });
}

start().catch((err) => {
  console.error("Notification service failed:", err);
  process.exit(1);
});