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
 * - Rate limit: 60/min per client IP (utils/clientIp.js) without a key, 600/min per key with a valid X-API-Key
 *   (a wrong key is a 401); 429 + Retry-After + RateLimit headers.
 * - Cache-Control + ETag (Express): a client that sends If-None-Match gets 304.
 * - Events carry the fusion fields (sources, ambiguousSources, confidence,
 *   priority; services/fusion) after the original ones; minConfidence and
 *   minPriority filter on the scores (docs/scoring.md).
 * - Every body carries `attribution` (sources, credit lines, disclaimer);
 *   errors are { error: { code, message } } with Cache-Control: no-store.
 * The dashboard feed (/disasters) and the Kafka contract are untouched.
 */
import express from "express";
import cors from "cors";
import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import { keyStore as defaultKeyStore } from "../services/apiKeys.js";
import { feedService as defaultFeed, FeedUnavailableError } from "../services/feed.service.js";
import { SEVERITY_RULES } from "../utils/severity.js";
import { ATTRIBUTION } from "../api/v1/attribution.js";
import { BadRequest, createEventCache, parseListQuery, selectPage, withFusion, TYPES, SEVERITIES, WINDOW_DAYS, WINDOW_MS, PAGE_LIMIT, RATE_LIMIT, KEY_RATE_LIMIT } from "../api/v1/events.js";
import { fusion as defaultFusion } from "../services/fusion/index.js";
import { SCORE_VERSION } from "../services/fusion/scores.js";
import { buildOpenApi } from "../api/v1/openapi.js";

export const V1_RATE_LIMIT = RATE_LIMIT;
/** Requests per window with a valid X-API-Key, counted per key instead of per IP. */
export const V1_KEY_RATE_LIMIT = KEY_RATE_LIMIT;
export const LIST_CACHE_CONTROL = "public, max-age=60, stale-while-revalidate=300";
export const TYPES_CACHE_CONTROL = "public, max-age=86400";
/** Where the confidence and priority formulas are documented. */
export const SCORING_DOC = "https://github.com/OrhanIzmirli/DisasterWatch/blob/main/docs/scoring.md";
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
 * @param {{ verify: (key: string) => Promise<number | null> }} [options.keyStore] API key lookup (services/apiKeys.js)
 * @param {number} [options.keyLimit] requests per window with a valid key (default 600)
 * @param {{ fuse: Function }} [options.fusion] multi-source fusion (services/fusion)
 */
export function createV1Router({ feed = defaultFeed, rateLimit: limitOptions, now = () => Date.now(), keyStore = defaultKeyStore, keyLimit = V1_KEY_RATE_LIMIT.limit, fusion = defaultFusion } = {}) {
  const router = express.Router();
  const eventsFor = createEventCache();
  let fusedCache = null;

  /** Public events with the fusion fields; when fusion fails the events are served without scores. */
  async function fuseEvents(events) {
    try {
      const r = await fusion.fuse(events);
      if (!(fusedCache && fusedCache.events === events && fusedCache.matches === r.matches && fusedCache.scores === r.scores)) {
        fusedCache = { events, matches: r.matches, scores: r.scores, out: withFusion(events, r) };
      }
      return { events: fusedCache.out, status: r.status, scored: true };
    } catch (err) {
      console.error("[v1] fusion failed, serving events without scores:", err);
      return { events: withFusion(events, null), status: { emsc: "error", nhc: "error", firms: "error" }, scored: false };
    }
  }

  router.use(
    cors({
      origin: "*",
      methods: ["GET", "HEAD", "OPTIONS"],
      allowedHeaders: ["X-API-Key", "If-None-Match"],
      exposedHeaders: ["RateLimit", "RateLimit-Policy", "Retry-After", "ETag"],
      credentials: false,
      maxAge: 86400,
    })
  );
  router.use((req, res, next) => {
    // helmet's same-site default is for the dashboard API; this one is meant to be fetched from anywhere
    res.set("Cross-Origin-Resource-Policy", "cross-origin");
    if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
    res.set("Allow", "GET, HEAD, OPTIONS");
    sendError(res, 405, "method_not_allowed", "The public API is read-only: use GET");
  });

  // Optional key: a valid one raises the limit and is counted per key; a wrong one is a 401
  // (silently falling back to the anonymous limit would hide a typo). When the key cannot be
  // checked (database down), the request is served under the anonymous limit.
  router.use(async (req, res, next) => {
    const key = req.get("X-API-Key");
    if (key === undefined || req.method === "OPTIONS") return next();
    try {
      const keyId = await keyStore.verify(key.trim());
      if (keyId === null) return sendError(res, 401, "invalid_key", "The X-API-Key header holds no valid key; leave it out to use the API without one");
      req.apiKeyId = keyId;
    } catch (err) {
      console.warn(`[v1] API key check unavailable, serving under the anonymous limit: ${err?.name || "error"}`);
    }
    next();
  });

  if (limitOptions !== false) {
    const { windowMs, limit } = { ...V1_RATE_LIMIT, ...(limitOptions || {}) };
    router.use(
      rateLimit({
        windowMs,
        limit: (req) => (req.apiKeyId ? keyLimit : limit),
        // per key with a valid key, else per IP (IPv6 grouped by /56, the library default)
        keyGenerator: (req) => (req.apiKeyId ? `key:${req.apiKeyId}` : ipKeyGenerator(req.ip)),
        standardHeaders: "draft-7",
        legacyHeaders: false,
        skip: (req) => req.method === "OPTIONS",
        handler: (req, res, next, options) => {
          const reset = req.rateLimit?.resetTime;
          const seconds = reset instanceof Date ? Math.ceil((reset.getTime() - Date.now()) / 1000) : Math.ceil(options.windowMs / 1000);
          res.set("Retry-After", String(Math.max(1, seconds)));
          const max = req.rateLimit?.limit ?? limit;
          sendError(res, 429, "rate_limited", `Too many requests: at most ${max} per ${Math.round(options.windowMs / 1000)} s ${req.apiKeyId ? "for this key" : "per IP address without a key"}`);
        },
      })
    );
  }

  /** Source snapshot + events with the fusion fields; answers 503 itself when nothing can be served. */
  async function load(res) {
    try {
      const snap = await feed.snapshot();
      const fused = await fuseEvents(eventsFor(snap.served, now()));
      return { snap, events: fused.events, fusion: fused };
    } catch (err) {
      if (err instanceof FeedUnavailableError) {
        res.set("Retry-After", "60");
        sendError(res, 503, "unavailable", "The data sources are not responding and nothing is cached; try again in a minute");
        return null;
      }
      throw err;
    }
  }

  const sourceMeta = (snap, fused) => ({
    updatedAt: snap.updatedAt,
    stale: snap.stale,
    partial: snap.partial,
    sources: { usgs: snap.sources.usgs, eonet: snap.sources.nasa },
    confirmingSources: fused.status,
    scoreVersion: SCORE_VERSION,
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
      limits: { requestsPerMinute: V1_RATE_LIMIT.limit, requestsPerMinuteWithKey: keyLimit, windowDays: WINDOW_DAYS, maxPageSize: PAGE_LIMIT.max },
      scoring: { version: SCORE_VERSION, documentation: SCORING_DOC },
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
    const { snap, events, fusion: fused } = loaded;
    if (!fused.scored && (filters.minConfidence !== undefined || filters.minPriority !== undefined)) {
      res.set("Retry-After", "60");
      return sendError(res, 503, "unavailable", "Scores cannot be computed right now, so minConfidence and minPriority cannot be applied; try again in a minute or leave them out");
    }
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
        ...sourceMeta(snap, fused),
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
    res.json({ data: event, meta: sourceMeta(loaded.snap, loaded.fusion), attribution: ATTRIBUTION });
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
