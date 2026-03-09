import { Router } from "express";
import { publishDisasterEvent } from "../services/kafkaProducer.js";

const router = Router();

// POST /events  -> body’yi Kafka’ya yollar
router.post("/", async (req, res) => {
  try {
    const event = req.body;

    // Minimum kontrol (boş body olmasın)
    if (!event || Object.keys(event).length === 0) {
      return res.status(400).json({ ok: false, error: "Empty body" });
    }

    await publishDisasterEvent(event);
    return res.json({ ok: true, published: true, event });
  } catch (e) {
    console.error(" publish error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Publish failed" });
  }
});

export default router;
