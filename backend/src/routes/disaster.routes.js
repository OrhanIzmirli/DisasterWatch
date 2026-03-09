import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";

import { fetchNasaEvents } from "../services/nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";

import {
  fetchUsgsEarthquakes,
  normalizeUsgsEarthquakes,
} from "../services/usgs.service.js";

// import { publishDisasterEvent } from "../services/kafkaProducer.js";
// Kafka publish şimdilik kapalı (timeout önlemek için)

const router = express.Router();

/* =====================================================
   ✅ CACHE (DEMO + AZURE SAFE)
   - default 5 dk cache
   - force=1 ile cache bypass
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
  // PowerShell'de bozulan karakterleri temizle
  return String(s)
    .replace(/•/g, " - ")
    .replace(/\s+/g, " ")
    .trim();
}

router.get("/", async (req, res) => {
  console.log("🌍 /disasters");

  // Query paramlar
  const forceLive = String(req.query.force || "") === "1";

  // kaç dakika geriye gitsin? default: 7 gün
  const minutesWindow = toInt(req.query.minutes, 7 * 24 * 60); // 10080

  // kaç item dönsün? default: 50 (isteyene 200'e kadar izin verelim)
  const limit = Math.min(toInt(req.query.limit, 50), 200);

  // USGS min magnitude default 4.5 (daha çok veri gelir)
  const minMag = toFloat(req.query.minMag, 4.5);

  // cache süresi (ms) default 5 dk
  const cacheMs = toInt(req.query.cacheMs, 5 * 60 * 1000);

  // ✅ cache geçerliyse dön (force yoksa)
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
      .slice(0, Math.ceil(limit * 0.6)); // limitin %60'ı NASA

    // ---- USGS ----
    const usgsFeatures = await fetchUsgsEarthquakes();
    const quakesNormalized = normalizeUsgsEarthquakes(usgsFeatures, {
      minMag,
      limit: Math.ceil(limit * 0.6),
    }).filter((e) => (e.timeMinutesAgo ?? 999999) <= minutesWindow);

    // Birleştir + limit uygula
    let merged = [...nasaNormalized, ...quakesNormalized]
      .slice(0, limit)
      .map((e) => ({
        ...e,
        meta: sanitizeText(e.meta),
        description: sanitizeText(e.description),
        location: sanitizeText(e.location),
        title: sanitizeText(e.title),
      }));

    // Çok boş gelirse cache'e düşme yerine yine de döndür
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
    console.error("❌ LIVE API FAILED → RETURN CACHE:", err?.message || err);

    return res.json({
      items: CACHE.items,
      count: CACHE.items.length,
      source: "CACHE-FALLBACK",
    });
  }
});

/* ===========================
   🔍 NASA RAW (opsiyonel)
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
   🔐 AUTH SONRA
=========================== */
router.use(requireAuth);

/* ===========================
   📥 CREATE DISASTER
=========================== */
router.post("/", async (req, res) => {
  const schema = z.object({
    type: z.string(),
    title: z.string(),
    lat: z.number(),
    lng: z.number(),
    date: z.string(),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid input" });
  }

  const disaster = await prisma.disaster.create({
    data: {
      ...parsed.data,
      date: new Date(parsed.data.date),
    },
  });

  res.status(201).json(disaster);
});

export default router;
