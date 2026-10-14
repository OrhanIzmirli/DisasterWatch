import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth, requireAdmin } from "../middleware/auth.middleware.js";
import { writeAudit } from "../utils/audit.js";

import { fetchNasaEvents } from "../services/nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";

import {
  fetchUsgsEarthquakes,
  normalizeUsgsEarthquakes,
} from "../services/usgs.service.js";

// import { publishDisasterEvent } from "../services/kafkaProducer.js";
// Kafka publishing is disabled here for now to avoid request timeouts

const router = express.Router();

/* =====================================================
   CACHE
   - 5 minute cache by default
   - force=1 bypasses the cache
===================================================== */
let CACHE = {
  items: [
    {
      id: "cache-1",
      type: "wildfire",
      title: "Cached Wildfire – Turkey",
      lat: 39.9,
      lng: 32.8,
      source: "cache",
      timeMinutesAgo: 30,
      meta: "Cache - 30 min ago",
      description: "Fallback cache item",
      severity: "low",
    },
  ],
  updatedAt: 0,
};

function toInt(val, fallback) {
  const n = parseInt(String(val ?? ""), 10);
  return Number.isFinite(n) ? n : fallback;
}

function toFloat(val, fallback) {
  const n = parseFloat(String(val ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeText(s) {
  if (!s) return s;
  // Clean up characters that render incorrectly in PowerShell
  return String(s)
    .replace(/•/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

router.get("/", async (req, res) => {
  console.log("GET /disasters");

  // Query parameters
  const forceLive = String(req.query.force || "") === "1";

  // How far back to look, in minutes (default: 7 days)
  const minutesWindow = toInt(req.query.minutes, 7 * 24 * 60); // 10080

  // Number of items to return (default: 50, max: 200)
  const limit = Math.min(toInt(req.query.limit, 50), 200);

  // USGS minimum magnitude (default: 4.5)
  const minMag = toFloat(req.query.minMag, 4.5);

  // Cache duration in ms (default: 5 minutes)
  const cacheMs = toInt(req.query.cacheMs, 5 * 60 * 1000);

  // Serve from cache while it is fresh, unless force=1
  if (!forceLive && Date.now() - CACHE.updatedAt < cacheMs) {
    return res.json({
      items: CACHE.items,
      count: CACHE.items.length,
      source: "CACHE",
      params: { minutesWindow, limit, minMag, cacheMs },
    });
  }

  try {
    // ---- NASA ----
    const nasaEvents = await fetchNasaEvents();
    const nasaNormalized = normalizeNasaEvents(nasaEvents)
      .filter((e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow)
      .slice(0, Math.ceil(limit * 0.6)); // up to 60% of the limit from NASA

    // ---- USGS ----
    const usgsFeatures = await fetchUsgsEarthquakes();
    const quakesNormalized = normalizeUsgsEarthquakes(usgsFeatures, {
      minMag,
      limit: Math.ceil(limit * 0.6),
    }).filter((e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow);

    // Merge sources and apply the limit
    let merged = [...nasaNormalized, ...quakesNormalized]
      .slice(0, limit)
      .map((e) => ({
        ...e,
        meta: sanitizeText(e.meta),
        description: sanitizeText(e.description),
        location: sanitizeText(e.location),
        title: sanitizeText(e.title),
      }));

    // If the live result is empty, fall back to the cached items
    if (!merged.length) {
      merged = CACHE.items;
    }

    // cache update
    CACHE = {
      items: merged,
      updatedAt: Date.now(),
    };

    return res.json({
      items: merged,
      count: merged.length,
      source: "NASA + USGS (CACHED)",
      params: { minutesWindow, limit, minMag, cacheMs },
    });
  } catch (err) {
    console.error("Live API failed, returning cache:", err?.message || err);

    return res.json({
      items: CACHE.items,
      count: CACHE.items.length,
      source: "CACHE-FALLBACK",
    });
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
