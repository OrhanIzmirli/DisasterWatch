import { Router } from "express";
import { publishDisasterEvent } from "../services/kafkaProducer.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { disasterEventSchema } from "../events/contract.js";

const router = Router();

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ ok: false, error: "Admin access required" });
  }
  next();
}

// POST /events -> validates the body against the event contract and publishes it (admin only)
router.post("/", requireAuth, requireAdmin, async (req, res) => {
  const parsed = disasterEventSchema.safeParse(req.body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const path = issue?.path?.join(".") || "body";
    return res.status(400).json({
      ok: false,
      error: `Invalid event: ${path}: ${issue?.message || "invalid"}`,
    });
  }

  const event = parsed.data;

  try {
    await publishDisasterEvent(event);
    return res.json({ ok: true, published: true, event });
  } catch (e) {
    console.error("Publish error:", e?.message || e);
    return res.status(500).json({ ok: false, error: "Publish failed" });
  }
});

export default router;
