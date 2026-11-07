/**
 * OpenAPI 3.1 description of the public API v1, served at GET /api/v1/openapi.json.
 *
 * Built from the same constants the routes use (types, severities, limits,
 * cache headers, attribution), so the document cannot drift from the code on
 * those points; tests/v1-contract.test.js validates the document itself and
 * every response the routes give against it.
 */
import { ATTRIBUTION } from "./attribution.js";
import { KEY_RATE_LIMIT, PAGE_LIMIT, RATE_LIMIT, SEVERITIES, TYPES, WINDOW_DAYS } from "./events.js";

const OPENAPI_LIMITS = { requestsPerMinute: RATE_LIMIT.limit, requestsPerMinuteWithKey: KEY_RATE_LIMIT.limit };

const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema) => ({ "application/json": { schema } });

const SOURCE_STATUS = { type: "string", enum: ["ok", "stale", "error"], description: "ok: fresh; stale: the source failed, its last good data is served; error: nothing from this source" };

const rateHeaders = {
  RateLimit: { $ref: "#/components/headers/RateLimit" },
  "RateLimit-Policy": { $ref: "#/components/headers/RateLimitPolicy" },
};
const cachedHeaders = {
  ...rateHeaders,
  "Cache-Control": { $ref: "#/components/headers/CacheControl" },
  ETag: { $ref: "#/components/headers/ETag" },
};

const errorResponse = (description, extraHeaders = {}) => ({
  description,
  headers: { "Cache-Control": { description: "Always no-store", schema: { type: "string", const: "no-store" } }, ...extraHeaders },
  content: json(ref("Error")),
});

const commonErrors = {
  401: { $ref: "#/components/responses/InvalidKey" },
  429: { $ref: "#/components/responses/TooManyRequests" },
  500: { $ref: "#/components/responses/ServerError" },
};

export function buildOpenApi() {
  return {
    openapi: "3.1.0",
    info: {
      title: "DisasterWatch public API",
      version: "1.0.0",
      summary: "Read-only access to the earthquakes, wildfires, floods and severe storms DisasterWatch shows.",
      description: [
        `Events of the last ${WINDOW_DAYS} days from USGS (earthquakes of magnitude 4.5 and above) and NASA EONET (wildfires, floods, severe storms), rated with the same rules as the DisasterWatch dashboard.`,
        "",
        `- **No key needed.** At most ${OPENAPI_LIMITS.requestsPerMinute} requests per minute per IP address; above that the API answers 429 with \`Retry-After\`.`,
        `- **Optional key.** Sign in with GitHub on the API page to get one; send it as \`X-API-Key\` for ${OPENAPI_LIMITS.requestsPerMinuteWithKey} requests per minute, counted per key. A wrong key is a 401. Keep keys on your server: a key in browser code is public.`,
        "- **Cache.** Responses carry `Cache-Control` and an `ETag`: send `If-None-Match` to get a 304. The data itself refreshes every 5 minutes.",
        "- **Free hosting.** The first request after about 15 quiet minutes can take up to a minute while the server wakes up.",
        "- **Attribution.** Every response has an `attribution` object: credit the sources it lists when you show the data.",
        "- **GDACS.** Only the GDACS alert level and the link to its report are included; GDACS impact figures are not, because its terms grant no redistribution licence.",
        "",
        ATTRIBUTION.disclaimer,
      ].join("\n"),
    },
    servers: [
      { url: "/api/v1", description: "The site serving this document" },
      { url: "https://disasterwatch-frontend.onrender.com/api/v1", description: "DisasterWatch (live)" },
    ],
    tags: [{ name: "Events" }, { name: "Reference" }],
    // the key is optional: every operation works without one ({}) or with one
    security: [{}, { ApiKey: [] }],
    paths: {
      "/disasters": {
        get: {
          tags: ["Events"],
          operationId: "listDisasters",
          summary: "List events",
          description: `Events of the last ${WINDOW_DAYS} days, newest first. Filters combine with AND; comma-separated values within one filter combine with OR. Follow \`meta.nextCursor\` to page through the rest.`,
          parameters: [
            { $ref: "#/components/parameters/type" },
            { $ref: "#/components/parameters/severity" },
            { $ref: "#/components/parameters/minSeverity" },
            { $ref: "#/components/parameters/from" },
            { $ref: "#/components/parameters/to" },
            { $ref: "#/components/parameters/bbox" },
            { $ref: "#/components/parameters/country" },
            { $ref: "#/components/parameters/limit" },
            { $ref: "#/components/parameters/cursor" },
          ],
          responses: {
            200: { description: "A page of events", headers: cachedHeaders, content: json(ref("EventList")) },
            304: { description: "Not modified (the ETag sent in If-None-Match still matches)" },
            400: { $ref: "#/components/responses/BadRequest" },
            ...commonErrors,
            503: { $ref: "#/components/responses/Unavailable" },
          },
        },
      },
      "/disasters/{id}": {
        get: {
          tags: ["Events"],
          operationId: "getDisaster",
          summary: "Get one event",
          parameters: [
            {
              name: "id",
              in: "path",
              required: true,
              description: "The event id from a list response: the source and its own id, e.g. `usgs:us7000abcd` or `eonet:EONET_1234`.",
              schema: { type: "string", pattern: "^(usgs|eonet):[A-Za-z0-9_.-]{1,80}$" },
            },
          ],
          responses: {
            200: { description: "The event", headers: cachedHeaders, content: json(ref("EventResponse")) },
            304: { description: "Not modified" },
            400: { $ref: "#/components/responses/BadRequest" },
            404: errorResponse(`No event with this id in the last ${WINDOW_DAYS} days`),
            ...commonErrors,
            503: { $ref: "#/components/responses/Unavailable" },
          },
        },
      },
      "/types": {
        get: {
          tags: ["Reference"],
          operationId: "listTypes",
          summary: "Event types, severity levels and rating rules",
          responses: {
            200: { description: "Reference data", headers: cachedHeaders, content: json(ref("TypesResponse")) },
            304: { description: "Not modified" },
            ...commonErrors,
          },
        },
      },
      "/": {
        get: {
          tags: ["Reference"],
          operationId: "getIndex",
          summary: "API index",
          responses: {
            200: { description: "Endpoints and limits", headers: cachedHeaders, content: json(ref("Index")) },
            304: { description: "Not modified" },
            ...commonErrors,
          },
        },
      },
      "/openapi.json": {
        get: {
          tags: ["Reference"],
          operationId: "getOpenApi",
          summary: "This document",
          responses: {
            200: { description: "OpenAPI 3.1 document", headers: cachedHeaders, content: json({ type: "object" }) },
            304: { description: "Not modified" },
            ...commonErrors,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKey: {
          type: "apiKey",
          in: "header",
          name: "X-API-Key",
          description: `Optional. ${OPENAPI_LIMITS.requestsPerMinuteWithKey} requests per minute per key instead of ${OPENAPI_LIMITS.requestsPerMinute} per IP address.`,
        },
      },
      parameters: {
        type: {
          name: "type",
          in: "query",
          description: "One or more types, comma-separated, e.g. `earthquake,storm`.",
          schema: { type: "string", pattern: `^(${TYPES.join("|")})(,(${TYPES.join("|")}))*$` },
        },
        severity: {
          name: "severity",
          in: "query",
          description: "One or more exact severities, comma-separated, e.g. `high`. `unrated`: the source reports no intensity the rules can rate.",
          schema: { type: "string", pattern: `^(${SEVERITIES.join("|")})(,(${SEVERITIES.join("|")}))*$` },
        },
        minSeverity: {
          name: "minSeverity",
          in: "query",
          description: "Lowest severity to include (unrated events are left out).",
          schema: { type: "string", enum: ["low", "medium", "high"] },
        },
        from: {
          name: "from",
          in: "query",
          description: "Earliest occurrence time, ISO 8601 date or date-time (UTC unless an offset is given), e.g. `2026-11-01`.",
          schema: { type: "string" },
        },
        to: {
          name: "to",
          in: "query",
          description: "Latest occurrence time, ISO 8601 date or date-time.",
          schema: { type: "string" },
        },
        bbox: {
          name: "bbox",
          in: "query",
          description: "Bounding box `minLng,minLat,maxLng,maxLat` in degrees, e.g. `26,36,45,42` (Türkiye). A box with minLng greater than maxLng crosses the antimeridian.",
          schema: { type: "string" },
        },
        country: {
          name: "country",
          in: "query",
          description: "Country name as in the events' `country` field (case-insensitive), e.g. `Japan`. Events whose country could not be derived from the source place have none.",
          schema: { type: "string", minLength: 1, maxLength: 60 },
        },
        limit: {
          name: "limit",
          in: "query",
          description: "Page size.",
          schema: { type: "integer", minimum: PAGE_LIMIT.min, maximum: PAGE_LIMIT.max, default: PAGE_LIMIT.fallback },
        },
        cursor: {
          name: "cursor",
          in: "query",
          description: "`meta.nextCursor` of the previous page. Keep the other parameters the same.",
          schema: { type: "string", maxLength: 300 },
        },
      },
      headers: {
        RateLimit: { description: "Remaining requests in the current window (IETF draft-7 format), e.g. `limit=60, remaining=59, reset=60`", schema: { type: "string" } },
        RateLimitPolicy: { description: `The limit: \`${OPENAPI_LIMITS.requestsPerMinute};w=60\` without a key, \`${OPENAPI_LIMITS.requestsPerMinuteWithKey};w=60\` with one`, schema: { type: "string" } },
        RetryAfter: { description: "Seconds to wait before retrying", schema: { type: "integer", minimum: 1 } },
        CacheControl: { description: "`public, max-age=60, stale-while-revalidate=300` for events, a day for reference data", schema: { type: "string" } },
        ETag: { description: "Send it back in If-None-Match to get a 304 when nothing changed", schema: { type: "string" } },
      },
      responses: {
        BadRequest: errorResponse("A parameter is unknown or invalid; the message says which"),
        InvalidKey: errorResponse("The X-API-Key header holds no valid key (unknown, revoked or malformed); leave the header out to use the API without a key"),
        TooManyRequests: errorResponse(`More than ${OPENAPI_LIMITS.requestsPerMinute} requests in a minute from this IP address, or ${OPENAPI_LIMITS.requestsPerMinuteWithKey} with this key`, {
          "Retry-After": { $ref: "#/components/headers/RetryAfter" },
          ...rateHeaders,
        }),
        Unavailable: errorResponse("The sources are not responding and nothing is cached yet", { "Retry-After": { $ref: "#/components/headers/RetryAfter" } }),
        ServerError: errorResponse("Unexpected server error"),
      },
      schemas: {
        Event: {
          type: "object",
          additionalProperties: false,
          required: ["id", "source", "type", "severity", "severityReason", "title", "place", "country", "lat", "lng", "occurredAt", "updatedAt", "status", "measurements", "alerts", "links"],
          properties: {
            id: { type: "string", description: "Stable id: the source and its own id", examples: ["usgs:us7000abcd"] },
            source: { type: "string", enum: ["usgs", "eonet"] },
            type: { type: "string", enum: TYPES },
            severity: { type: "string", enum: SEVERITIES },
            severityReason: nullable({ type: "string", description: "Which rule rated the event and on what value" }),
            title: { type: "string" },
            place: nullable({ type: "string", description: "Place as the source names it" }),
            country: nullable({ type: "string", description: "Derived from the source place; null when it cannot be" }),
            lat: { type: "number", minimum: -90, maximum: 90 },
            lng: { type: "number", minimum: -180, maximum: 180 },
            occurredAt: { type: "string", format: "date-time" },
            updatedAt: nullable({ type: "string", format: "date-time" }),
            status: nullable({ type: "string", description: "USGS: reviewed | automatic; EONET: open | closed" }),
            measurements: {
              type: "object",
              additionalProperties: false,
              required: ["magnitude", "magnitudeType", "depthKm", "burnedAreaHa", "peakWindKts", "currentWindKts"],
              properties: {
                magnitude: nullable({ type: "number", description: "Earthquakes" }),
                magnitudeType: nullable({ type: "string", description: "Earthquakes, e.g. mww" }),
                depthKm: nullable({ type: "number", description: "Earthquakes" }),
                burnedAreaHa: nullable({ type: "number", description: "Wildfires, hectares" }),
                peakWindKts: nullable({ type: "number", description: "Storms, highest advisory wind in knots" }),
                currentWindKts: nullable({ type: "number", description: "Storms, latest advisory wind in knots" }),
              },
            },
            alerts: {
              type: "object",
              additionalProperties: false,
              required: ["usgsPager", "tsunami", "gdacs"],
              properties: {
                usgsPager: nullable({ type: "string", enum: ["green", "yellow", "orange", "red", null], description: "USGS PAGER alert level" }),
                tsunami: nullable({ type: "boolean", description: "USGS tsunami flag" }),
                gdacs: nullable({ type: "string", enum: ["green", "orange", "red", null], description: "GDACS alert level (the report link is in links)" }),
              },
            },
            links: {
              type: "array",
              description: "The source's page for the event and, for EONET events, the organisations it was curated from",
              items: { type: "object", additionalProperties: false, required: ["name", "url"], properties: { name: { type: "string" }, url: { type: "string", format: "uri" } } },
            },
          },
        },
        SourceMeta: {
          type: "object",
          required: ["updatedAt", "stale", "partial", "sources"],
          properties: {
            updatedAt: nullable({ type: "string", format: "date-time", description: "When the served data was fetched from the sources" }),
            stale: { type: "boolean", description: "True when no source answered and older data is served" },
            partial: { type: "boolean", description: "True when one source contributed nothing" },
            sources: {
              type: "object",
              additionalProperties: false,
              required: ["usgs", "eonet"],
              properties: { usgs: SOURCE_STATUS, eonet: SOURCE_STATUS },
            },
          },
        },
        EventList: {
          type: "object",
          additionalProperties: false,
          required: ["data", "meta", "attribution"],
          properties: {
            data: { type: "array", items: ref("Event") },
            meta: {
              allOf: [
                ref("SourceMeta"),
                {
                  type: "object",
                  required: ["count", "total", "limit", "nextCursor", "window"],
                  properties: {
                    count: { type: "integer", minimum: 0, description: "Events on this page" },
                    total: { type: "integer", minimum: 0, description: "Events matching the filters" },
                    limit: { type: "integer", minimum: PAGE_LIMIT.min, maximum: PAGE_LIMIT.max },
                    nextCursor: nullable({ type: "string", description: "Pass as cursor for the next page; null on the last page" }),
                    window: {
                      type: "object",
                      additionalProperties: false,
                      required: ["from", "to"],
                      properties: { from: { type: "string", format: "date-time" }, to: { type: "string", format: "date-time" } },
                    },
                  },
                },
              ],
              unevaluatedProperties: false,
            },
            attribution: ref("Attribution"),
          },
        },
        EventResponse: {
          type: "object",
          additionalProperties: false,
          required: ["data", "meta", "attribution"],
          properties: {
            data: ref("Event"),
            meta: { allOf: [ref("SourceMeta")], unevaluatedProperties: false },
            attribution: ref("Attribution"),
          },
        },
        TypesResponse: {
          type: "object",
          additionalProperties: false,
          required: ["data", "severities", "severityRules", "attribution"],
          properties: {
            data: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "label", "source"],
                properties: { id: { type: "string", enum: TYPES }, label: { type: "string" }, source: { type: "string", enum: ["usgs", "eonet"] } },
              },
            },
            severities: { type: "array", items: { type: "string", enum: SEVERITIES } },
            severityRules: { type: "object", description: "Thresholds per type (lower bounds of medium and high) and the GDACS level mapping" },
            attribution: ref("Attribution"),
          },
        },
        Index: {
          type: "object",
          additionalProperties: false,
          required: ["name", "version", "documentation", "endpoints", "limits", "attribution"],
          properties: {
            name: { type: "string" },
            version: { type: "string" },
            documentation: { type: "string" },
            endpoints: { type: "object", additionalProperties: { type: "string" } },
            limits: {
              type: "object",
              additionalProperties: false,
              required: ["requestsPerMinute", "requestsPerMinuteWithKey", "windowDays", "maxPageSize"],
              properties: { requestsPerMinute: { type: "integer" }, requestsPerMinuteWithKey: { type: "integer" }, windowDays: { type: "integer" }, maxPageSize: { type: "integer" } },
            },
            attribution: ref("Attribution"),
          },
        },
        Attribution: {
          type: "object",
          additionalProperties: false,
          required: ["sources", "disclaimer"],
          description: "Credit these sources when you show the data",
          properties: {
            sources: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                required: ["id", "name", "url", "credit", "licence", "terms", "provides"],
                properties: {
                  id: { type: "string" },
                  name: { type: "string" },
                  url: { type: "string", format: "uri" },
                  credit: { type: "string" },
                  licence: { type: "string" },
                  terms: { type: "string", format: "uri" },
                  provides: { type: "string" },
                },
              },
            },
            disclaimer: { type: "string" },
          },
        },
        Error: {
          type: "object",
          additionalProperties: false,
          required: ["error", "attribution"],
          properties: {
            error: {
              type: "object",
              additionalProperties: false,
              required: ["code", "message"],
              properties: {
                code: { type: "string", enum: ["bad_request", "invalid_key", "not_found", "method_not_allowed", "rate_limited", "unavailable", "server_error"] },
                message: { type: "string" },
              },
            },
            attribution: ref("Attribution"),
          },
        },
      },
    },
  };
}
