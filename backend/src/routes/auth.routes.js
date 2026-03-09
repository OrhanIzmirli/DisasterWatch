import express from "express";
import { z } from "zod";
import prisma from "../prisma.js";
import { requireAuth } from "../middleware/auth.middleware.js";
import { fetchNasaEvents } from "../services/nasa.service.js";
import { normalizeNasaEvents } from "../utils/normalizeDisasters.js";

const router = express.Router();

/* ===========================
   🌍 REAL DISASTERS (NASA)
   👉 PUBLIC (FRONTEND OKUR)
=========================== */
router.get("/", async (req, res) => {
  try {
    const nasaEvents = await fetchNasaEvents();
    const normalized = normalizeNasaEvents(nasaEvents);

    res.json({
      items: normalized,
      count: normalized.length,
      source: "NASA EONET",
    });
  } catch (err) {
    console.error("DISASTER API ERROR:", err);
    res.status(500).json({ message: "Disaster data unavailable" });
  }
});

/* ===========================
   🌍 NASA RAW (DEBUG)
   👉 PUBLIC
=========================== */
router.get("/nasa", async (req, res) => {
  try {
    const events = await fetchNasaEvents();

    const mapped = events.map((event) => ({
      nasaId: event.id,
      title: event.title,
      type: event.categories?.[0]?.title || "Unknown",
      date: event.geometry?.[0]?.date,
      coordinates: event.geometry?.[0]?.coordinates,
      source: "NASA",
    }));

    res.json(mapped);
  } catch (err) {
    console.error("NASA API ERROR:", err);
    res.status(500).json({ message: "NASA API error" });
  }
});

/* ===========================
   🔐 AUTH SADECE BURADAN SONRA
=========================== */
router.use(requireAuth);

/* ===========================
   📥 CREATE DISASTER (MANUAL)
=========================== */
const disasterSchema = z.object({
  type: z.string(),
  title: z.string(),
  severity: z.string().optional(),
  magnitude: z.number().optional(),
  lat: z.number(),
  lng: z.number(),
  date: z.string(),
});

router.post("/", async (req, res) => {
  try {
    const parsed = disasterSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: "Invalid input" });
    }

    const disaster = await prisma.disaster.create({
      data: {
        ...parsed.data,
        date: new Date(parsed.data.date),
      },
    });

    res.status(201).json({
      message: "Disaster created",
      disaster,
    });
  } catch (err) {
    console.error("CREATE DISASTER ERROR:", err);
    res.status(500).json({ message: "Server error" });
  }
});

export default router;
