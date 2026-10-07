import { Router } from "express";
import { publishDisasterEvent } from "../services/kafkaProducer.js";

const router = Router();

// POST /events -> publishes the request body to Kafka
router.post("/", async (req, res) => {
  try {
    const event = req.body;

    // Reject empty bodies
    if (!event || Object.keys(event).length === 0) {
      return res.status(400).json({ ok: false, error: "Empty body" });
    }

    await publishDisasterEvent(event);
    return res.json({ ok: true, published: true, event });
  } catch (e) {
    console.error("Publish error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Publish failed" });
  }
});

export default router;
