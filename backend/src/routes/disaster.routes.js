import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { writeAudit } from "../utils/audit.js";

import { feedService, FeedUnavailableError } from "../services/feed.service.js";

// import { publishDisasterEvent } from "../services/kafkaProducer.js";
// Kafka publishing is disabled here for now to avoid request timeouts

const router = express.Router();

function toInt(val, fallback) {
  const n = parseInt(String(val ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(val, fallback) {
  const n = parseFloat(String(val ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

/* =====================================================
   PUBLIC FEED (NASA EONET + USGS, 5-minute cache)
   GET /disasters?force=1&minutes=10080&limit=50&minMag=4.5&cacheMs=300000
   -> { items, count, source, stale, updatedAt, params }
   503 { message, retryAfterSeconds } when the sources fail and nothing is cached.
===================================================== */
router.get("/", async (req, res) => {
  const options = {
    forceLive: String(req.query.force || "") === "1",
    minutesWindow: toInt(req.query.minutes, 7 * 24 * 60), // default: 7 days
    limit: Math.min(toInt(req.query.limit, 50), 200), // default 50, max 200
    minMag: toFloat(req.query.minMag, 4.5),
    cacheMs: toInt(req.query.cacheMs, 5 * 60 * 1000),
  };
  try {
    res.json(await feedService.getFeed(options));
  } catch (err) {
    if (err instanceof FeedUnavailableError) {
      return res.status(503).json({ message: err.message, retryAfterSeconds: 60 });
    }
    console.error("DISASTER FEED ERROR:", err);
    res.status(500).json({ message: "Disaster feed unavailable" });
  }
});

/* ===========================
   NASA RAW (optional)
=========================== */
router.get("/nasa", async (req, res) => {
  try {
    const events = await fetchNasaEvents();
    res.json(events);
  } catch (err) {
    res.status(500).json({ message: "NASA API error" });
  }
});

/* ===========================
   Routes below require authentication
=========================== */
router.use(requireAuth);

/* ===========================
   MANUAL DISASTERS (DB)
   Admin-entered records, separate from the public NASA+USGS feed
=========================== */
router.get("/manual", async (req, res) => {
  try {
    const items = await prisma.disaster.findMany({
      orderBy: { createdAt: "desc" },
      take: 50,
    });
    res.json({ items, count: items.length, source: "DB" });
  } catch (err) {
    console.error("LIST MANUAL DISASTERS ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

/* ===========================
   CREATE DISASTER (admin only)
=========================== */
router.post("/", requireAdmin, async (req, res) => {
  const schema = z.object({
    type: z.string().trim().min(1),
    title: z.string().trim().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    date: z.string().min(1),
    severity: z.string().trim().optional(),
    description: z.string().trim().optional(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid input" });
  }

  const date = new Date(parsed.data.date);
  if (Number.isNaN(date.getTime())) {
    return res.status(400).json({ message: "Invalid date" });
  }

  try {
    // The entry and its audit row are written in one transaction.
    const disaster = await prisma.$transaction(async (tx) => {
      const created = await tx.disaster.create({
        data: {
          ...parsed.data,
          date,
          createdBy: req.user.email ?? null,
        },
      });
      await writeAudit(tx, {
        actor: req.user,
        action: "disaster.create",
        targetLabel: `${created.type}: ${created.title}`,
        metadata: { disasterId: created.id, type: created.type, severity: created.severity ?? null },
      });
      return created;
    });

    res.status(201).json({ message: "Disaster created", disaster });
  } catch (err) {
    console.error("CREATE DISASTER ERROR:", err?.message || err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
