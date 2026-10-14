// backend/src/routes/news.routes.js
import express from "express";
import { newsService, NewsUnavailableError } from "../services/news.service.js";

const router = express.Router();

const TYPES = new Set(["earthquake", "flood", "wildfire", "storm"]);

/**
 * GET /news?type=earthquake|flood|wildfire|storm&event=<feed id>&limit=50
 * -> { items, count, updatedAt, stale, source, provider }
 * Served from the background-refreshed cache; never calls a provider itself.
 * Each item carries provider ("gdelt" | "guardian"); source is the label of
 * the provider that produced the current cache.
 */
router.get("/", (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type.toLowerCase() : null;
  if (type && !TYPES.has(type)) {
    return res.status(400).json({ message: `Unknown type "${type}". Use one of: ${[...TYPES].join(", ")}` });
  }

  let eventId = null;
  if (req.query.event !== undefined) {
    eventId = Number(req.query.event);
    if (!Number.isFinite(eventId)) {
      return res.status(400).json({ message: "event must be a numeric feed id" });
    }
  }

  const limitRaw = Number(req.query.limit ?? 50);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 100) : 50;

  try {
    const { items, updatedAt, stale, source, provider } = newsService.getNews({ type, eventId, limit });
    res.set("Cache-Control", "public, max-age=60");
    res.json({ items, count: items.length, updatedAt, stale, source, provider });
  } catch (err) {
    if (err instanceof NewsUnavailableError) {
      return res.status(503).json({ message: err.message, retryAfterSeconds: 60 });
    }
    console.error("NEWS API ERROR:", err);
    res.status(500).json({ message: "News unavailable" });
  }
});

export default router;
