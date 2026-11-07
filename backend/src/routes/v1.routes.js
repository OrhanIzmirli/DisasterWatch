/**
 * Public, read-only API v1 (mounted at /v1 and /api/v1, see app.js).
 *
 *   GET /v1                    index: endpoints, documentation, limits
 *   GET /v1/disasters          events of the last 30 days, filtered and paged
 *   GET /v1/disasters/{id}     one event ("usgs:us7000abcd", "eonet:EONET_1234")
 *   GET /v1/types              event types, severity levels and the rating rules
 *   GET /v1/openapi.json       OpenAPI 3.1 description (api/v1/openapi.js)
 *
 * - GET/HEAD only (OPTIONS answers CORS preflights); any other method is 405.
 * - CORS: any origin, no credentials; cookies are never read or set here.
 * - Rate limit per client IP (V1_RATE_LIMIT): 429 + Retry-After + RateLimit headers.
 * - Cache-Control + ETag (Express): a client that sends If-None-Match gets 304.
 * - Every body carries `attribution` (sources, credit lines, disclaimer);
 *   errors are { error: { code, message } } with Cache-Control: no-store.
 * The dashboard feed (/disasters) and the Kafka contract are untouched.
 */
import express from "express";
import cors from "cors";
import rateLimit from "express-rate-limit";
import { feedService as defaultFeed, FeedUnavailableError } from "../services/feed.service.js";
import { SEVERITY_RULES } from "../utils/severity.js";
import { ATTRIBUTION } from "../api/v1/attribution.js";
import { BadRequest, createEventCache, parseListQuery, selectPage, TYPES, SEVERITIES, WINDOW_DAYS, WINDOW_MS, PAGE_LIMIT, RATE_LIMIT } from "../api/v1/events.js";
import { buildOpenApi } from "../api/v1/openapi.js";

export const V1_RATE_LIMIT = RATE_LIMIT;
export const LIST_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
export const TYPES_CACHE_CONTROL = "public, max-age=86400";
const ID_PATTERN = /^(usgs|eonet):[A-Za-z0-9_.-]{1,80}$/;

const TYPE_INFO = {
  earthquake: { label: "Earthquake", source: "usgs" },
  wildfire: { label: "Wildfire", source: "eonet" },
  flood: { label: "Flood", source: "eonet" },
  storm: { label: "Severe storm", source: "eonet" },
};

function sendError(res, status, code, message) {
  res.set("Cache-Control", "no-store");
  res.status(status).json({ error: { code, message }, attribution: ATTRIBUTION });
}

/**
 * @param {object} [options]
 * @param {{ snapshot: Function }} [options.feed] source cache (feed.service.js)
 * @param {false | { windowMs?: number, limit?: number }} [options.rateLimit] false disables it (tests only)
 * @param {() => number} [options.now]
 */
export function createV1Router({ feed = defaultFeed, rateLimit: limitOptions, now = () => Date.now() } = {}) {
  const router = express.Router();
  const eventsFor = createEventCache();

  router.use(cors({ origin: "*", methods: ["GET", "HEAD", "OPTIONS"], credentials: false, maxAge: 86400 }));
  router.use((req, res, next) => {
    // helmet's same-site default is for the dashboard API; this one is meant to be fetched from anywhere
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    res.set("Allow", "GET, HEAD, OPTIONS");
    sendError(res, 405, "method_not_allowed", "The public API is read-only: use GET");
  });

  if (limitOptions !== false) {
    const { windowMs, limit } = { ...V1_RATE_LIMIT, ...(limitOptions || {}) };
    router.use(
      rateLimit({
        windowMs,
        limit,
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skip: (req) => req.method === "OPTIONS",
        handler: (req, res, next, options) => {
          const reset = req.rateLimit?.resetTime;
          const seconds = reset instanceof Date ? Math.ceil((reset.getTime() - Date.now()) / 1000) : Math.ceil(options.windowMs / 1000);
          res.set("Retry-After", String(Math.max(1, seconds)));
          sendError(res, 429, "rate_limited", `Too many requests: at most ${options.limit} per ${Math.round(options.windowMs / 1000)} s per client`);
        },
      })
    );
  }

  /** Source snapshot + events; answers 503 itself when nothing can be served. */
  async function load(res) {
    try {
      const snap = await feed.snapshot();
      return { snap, events: eventsFor(snap.served, now()) };
    } catch (err) {
      if (err instanceof FeedUnavailableError) {
        res.set("Retry-After", "60");
        sendError(res, 503, "unavailable", "The data sources are not responding and nothing is cached; try again in a minute");
        return null;
      }
      throw err;
    }
  }

  const sourceMeta = (snap) => ({
    updatedAt: snap.updatedAt,
    stale: snap.stale,
    partial: snap.partial,
    sources: { usgs: snap.sources.usgs, eonet: snap.sources.nasa },
  });

  router.get("/", (req, res) => {
    res.set("Cache-Control", TYPES_CACHE_CONTROL);
    res.json({
      name: "DisasterWatch public API",
      version: "v1",
      documentation: "/api",
      endpoints: {
        disasters: "/api/v1/disasters",
        disaster: "/api/v1/disasters/{id}",
        types: "/api/v1/types",
        openapi: "/api/v1/openapi.json",
      },
      limits: { requestsPerMinute: V1_RATE_LIMIT.limit, windowDays: WINDOW_DAYS, maxPageSize: PAGE_LIMIT.max },
      attribution: ATTRIBUTION,
    });
  });

  router.get("/disasters", async (req, res) => {
    let filters;
    try {
      filters = parseListQuery(req.query);
    } catch (err) {
      if (err instanceof BadRequest) return sendError(res, 400, "bad_request", err.message);
      throw err;
    }
    const loaded = await load(res);
    if (!loaded) return;
    const { snap, events } = loaded;
    const { page, total, nextCursor } = selectPage(events, filters);
    // to the minute: the body (and so the ETag) only changes when the data or the window does
    const to = Math.floor(now() / 60_000) * 60_000;
    res.set("Cache-Control", LIST_CACHE_CONTROL);
    res.json({
      data: page,
      meta: {
        count: page.length,
        total,
        limit: filters.limit,
        nextCursor,
        window: { from: new Date(to - WINDOW_MS).toISOString(), to: new Date(to).toISOString() },
        ...sourceMeta(snap),
      },
      attribution: ATTRIBUTION,
    });
  });

  router.get("/disasters/:id", async (req, res) => {
    const { id } = req.params;
    if (!ID_PATTERN.test(id)) return sendError(res, 400, "bad_request", 'id must look like "usgs:us7000abcd" or "eonet:EONET_1234"');
    const loaded = await load(res);
    if (!loaded) return;
    const event = loaded.events.find((e) => e.id === id);
    if (!event) return sendError(res, 404, "not_found", `No event ${id} in the last ${WINDOW_DAYS} days`);
    res.set("Cache-Control", LIST_CACHE_CONTROL);
    res.json({ data: event, meta: sourceMeta(loaded.snap), attribution: ATTRIBUTION });
  });

  const openApi = buildOpenApi();
  router.get("/openapi.json", (req, res) => {
    res.set("Cache-Control", TYPES_CACHE_CONTROL);
    res.json(openApi);
  });

  router.get("/types", (req, res) => {
    res.set("Cache-Control", TYPES_CACHE_CONTROL);
    res.json({
      data: TYPES.map((id) => ({ id, ...TYPE_INFO[id] })),
      severities: SEVERITIES,
      severityRules: SEVERITY_RULES,
      attribution: ATTRIBUTION,
    });
  });

  router.use((req, res) => sendError(res, 404, "not_found", `No endpoint ${req.path}; see /api/v1`));
  // eslint-disable-next-line no-unused-vars
  router.use((err, req, res, next) => {
    console.error("[v1] unhandled error:", err);
    sendError(res, 500, "server_error", "Server error");
  });

  return router;
}
