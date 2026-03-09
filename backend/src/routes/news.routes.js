// backend/src/routes/news.routes.js
import express from "express";
import { fetchDisasterNews } from "../services/news.service.js";

const router = express.Router();

// ✅ PUBLIC endpoint
router.get("/", async (req, res) => {
  try {
    const limit = Number(req.query.limit ?? 10);
    const safeLimit = Number.isFinite(limit)
      ? Math.min(Math.max(limit, 5), 30)
      : 10;

    const items = await fetchDisasterNews({ limit: safeLimit });

    res.json({
      items,
      count: items.length,
      source: "GDELT",
    });
  } catch (err) {
    console.error("NEWS API ERROR:", err);
    res.status(500).json({ message: "News unavailable" });
  }
});

export default router;
