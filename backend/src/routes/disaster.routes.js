import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { writeAudit } from "../utils/audit.js";

import { feedService, FeedUnavailableError, FEED_PARAM_LIMITS, FEED_UNAVAILABLE_MESSAGE } from "../services/feed.service.js";

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

/** Clamps a query value into its accepted range; non-numeric input falls back to the default. */
function bounded(val, { min, max, fallback }, parse = toInt) {
  return Math.min(max, Math.max(min, parse(val, fallback)));
}

/* =====================================================
   PUBLIC FEED (NASA EONET + USGS, 5-minute server-side cache)
   GET /disasters?minutes=10080&limit=50&minMag=4.5
   -> { items, count, counts, source, stale, partial, sources, sourcesUpdatedAt, updatedAt, params }
   counts = { total, bySeverity, byType } over the whole window, independent of limit (dashboard KPIs)
   The cache lifetime is fixed on the server: there is no query parameter to
   force a live fetch or shorten the cache, so anonymous callers cannot make
   NASA/USGS calls go through this server. limit is clamped to 1..200,
   minutes to 60..43200, minMag to 0..10.
   503 { message, retryAfterSeconds } when both sources fail and nothing is cached;
   upstream error details never leave the server (log only).
===================================================== */
router.get("/", async (req, res) => {
  const options = {
    minutesWindow: bounded(req.query.minutes, FEED_PARAM_LIMITS.minutes),
    limit: bounded(req.query.limit, FEED_PARAM_LIMITS.limit),
    minMag: bounded(req.query.minMag, FEED_PARAM_LIMITS.minMag, toFloat),
  };
  try {
    res.json(await feedService.getFeed(options));
  } catch (err) {
    if (err instanceof FeedUnavailableError) {
      return res.status(503).json({ message: FEED_UNAVAILABLE_MESSAGE, retryAfterSeconds: 60 });
    }
    console.error("DISASTER FEED ERROR:", err);
    res.status(500).json({ message: "Disaster feed unavailable" });
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
    severity: z.enum(["low", "medium", "high"]).optional(), // chosen by the admin; never "unrated"
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
