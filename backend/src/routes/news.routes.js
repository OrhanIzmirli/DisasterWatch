// backend/src/routes/news.routes.js
import express from "express";
import { newsService, NewsUnavailableError } from "../services/news.service.js";
import { REGION_IDS } from "../services/newsLocation.js";
import { NEWS_LANGUAGES } from "../services/newsLanguages.js";

const LANGUAGE_CODES = new Set([...Object.values(NEWS_LANGUAGES), "unknown"]);

const router = express.Router();

const TYPES = new Set(["earthquake", "flood", "wildfire", "storm"]);

/**
 * GET /news?type=earthquake|flood|wildfire|storm&event=<feed id>&region=<region id>&country=<ISO 3166-1 alpha-2>&lang=<ISO 639-1 | unknown>&limit=50
 * -> { items, count, languages, updatedAt, stale, source, provider }
 * Items carry language (ISO 639-1 or null) and sourceCountry (publisher's country or null);
 * languages counts the matching articles per language before the lang filter.
 * Served from the background-refreshed cache; never calls a provider itself.
 * Each item carries provider ("gdelt" | "guardian" | "gdacs") and location
 * ({ countries, regions, source } or null); source is the label(s) of the
 * providers in the current cache. With region, unlocated articles are left out.
 */
router.get("/", (req, res) => {
  const type = typeof req.query.type === "string" ? req.query.type.toLowerCase() : null;
  if (type && !TYPES.has(type)) {
    return res.status(400).json({ message: `Unknown type "${type}". Use one of: ${[...TYPES].join(", ")}` });
  }

  const region = typeof req.query.region === "string" && req.query.region ? req.query.region.toLowerCase() : null;
  if (region && !REGION_IDS.has(region)) {
    return res.status(400).json({ message: `Unknown region "${region}". Use one of: ${[...REGION_IDS].join(", ")}` });
  }

  const country = typeof req.query.country === "string" && req.query.country ? req.query.country.toUpperCase() : null;
  if (country && !/^[A-Z]{2}$/.test(country)) {
    return res.status(400).json({ message: "country must be an ISO 3166-1 alpha-2 code, e.g. JP" });
  }

  const language = typeof req.query.lang === "string" && req.query.lang ? req.query.lang.toLowerCase() : null;
  if (language && !LANGUAGE_CODES.has(language)) {
    return res.status(400).json({ message: `Unknown lang "${language}". Use one of: ${[...LANGUAGE_CODES].join(", ")}` });
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
    const { items, languages, updatedAt, stale, source, provider } = newsService.getNews({ type, eventId, region, country, language, limit });
    res.set("Cache-Control", "public, max-age=60");
    res.json({ items, count: items.length, languages, updatedAt, stale, source, provider });
  } catch (err) {
    if (err instanceof NewsUnavailableError) {
      return res.status(503).json({ message: err.message, retryAfterSeconds: 60 });
    }
    console.error("NEWS API ERROR:", err);
    res.status(500).json({ message: "News unavailable" });
  }
});

export default router;
