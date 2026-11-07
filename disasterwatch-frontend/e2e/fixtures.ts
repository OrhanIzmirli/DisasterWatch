/**
 * Fixed data for the visual and accessibility tests. Every API call is answered
 * here, map tiles are replaced by a blank image and the clock is frozen, so a
 * screenshot changes only when the UI does. Titles are invented and every news
 * link points at example.com (no third-party content in the repository).
 */
import type { Page, Route } from "@playwright/test";

export const FIXED_NOW = new Date("2026-11-06T12:00:00Z");

const hoursAgo = (h: number) => new Date(FIXED_NOW.getTime() - h * 3_600_000).toISOString();

type Item = Record<string, unknown> & { id: number; type: string; severity: string; lat: number; lng: number };

function quake(id: number, mag: number, place: string, lat: number, lng: number, h: number, depthKm: number): Item {
  const label = mag.toFixed(1);
  const severity = mag >= 6 ? "high" : mag >= 5 ? "medium" : "low";
  return {
    id,
    type: "earthquake",
    severity,
    location: `M ${label} - ${place}`,
    meta: `M ${label}`,
    description: `Earthquake detected - Magnitude ${label}`,
    timeMinutesAgo: h * 60,
    lat,
    lng,
    country: place.split(", ").pop() ?? null,
    details: {
      eventId: `usgs:test${id}`,
      source: "usgs",
      category: "Earthquake",
      cleanTitle: `M ${label} - ${place}`,
      place,
      occurredAt: hoursAgo(h),
      updatedAt: hoursAgo(Math.max(0, h - 1)),
      status: "Reviewed",
      sources: [{ name: "USGS event page", url: `https://earthquake.usgs.gov/earthquakes/eventpage/test${id}` }],
      magnitude: mag,
      magnitudeLabel: label,
      magType: "mb",
      depthKm,
      pagerAlert: mag >= 6 ? "yellow" : null,
      tsunami: false,
      feltReports: mag >= 6 ? 112 : null,
      magnitudeValue: null,
      magnitudeUnit: null,
      severity,
      severityReason:
        severity === "high"
          ? `High: magnitude ${label} (≥ 6.0)`
          : severity === "medium"
            ? `Medium: magnitude ${label} (5.0–5.9)`
            : `Low: magnitude ${label} (< 5.0)`,
      severitySource: "Severity rule applied to the USGS magnitude",
      nearestPlace: (() => {
        const m = place.match(/^(\d+) km ([NSEW]{1,3}) of (.+)$/);
        return m ? { name: m[3], distanceKm: Number(m[1]), direction: m[2] } : null;
      })(),
      affectedCountries: null,
      timeline: null,
    },
  };
}

function eonet(
  id: number,
  type: "wildfire" | "flood" | "storm",
  title: string,
  place: string | null,
  lat: number,
  lng: number,
  h: number,
  extra: Record<string, unknown>
): Item {
  const severity = (extra.severity as string) ?? "low";
  return {
    id,
    type,
    severity,
    location: title,
    meta: title,
    description: title,
    timeMinutesAgo: h * 60,
    lat,
    lng,
    country: place,
    details: {
      eventId: `nasa:EONET_TEST${id}`,
      source: "nasa",
      category: type === "wildfire" ? "Wildfires" : type === "flood" ? "Floods" : "Severe Storms",
      cleanTitle: title,
      place,
      occurredAt: hoursAgo(h),
      updatedAt: hoursAgo(Math.max(0, h - 20)),
      status: "Open",
      sources: [{ name: "NASA EONET", url: "https://eonet.gsfc.nasa.gov/" }],
      magnitude: null,
      magType: null,
      depthKm: null,
      pagerAlert: null,
      tsunami: null,
      feltReports: null,
      magnitudeValue: null,
      magnitudeUnit: null,
      locationPrecision: "exact",
      nearestPlace: null,
      affectedCountries: null,
      timeline: null,
      ...extra,
      severity,
    },
  };
}

export const FEED: Item[] = [
  quake(1, 6.1, "144 km SE of Hasaki, Japan", 34.9, 141.9, 12, 35.0),
  quake(2, 4.7, "100 km SSE of Palekastro, Greece", 34.32, 26.53, 96, 40.2),
  quake(3, 4.5, "87 km S of Ierapetra, Greece", 34.22, 25.75, 30, 10.0),
  quake(4, 5.3, "41 km SW of Balangonan, Philippines", 6.1, 125.2, 16, 58.4),
  quake(5, 4.8, "36 km WNW of Poso, Indonesia", -1.24, 120.46, 4, 10.0),
  eonet(6, "wildfire", "Wildfire in Australia", "Australia", -19.12, 125.17, 48, {
    severity: "low",
    areaHa: 20731,
    magnitudeValue: 20731,
    magnitudeUnit: "hectare",
    gdacsLevel: "green",
    gdacsScore: 1,
    affectedCountries: ["AU"],
    severityReason: "Low: GDACS impact level Green (20,731 ha burned)",
    severitySource: "Impact level assigned by GDACS (gdacs.org)",
    sources: [
      { name: "NASA EONET", url: "https://eonet.gsfc.nasa.gov/" },
      { name: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=WF&eventid=900006" },
    ],
  }),
  eonet(7, "flood", "Flood in Indonesia", "Indonesia", -2.5, 118.0, 30, {
    severity: "medium",
    gdacsLevel: "orange",
    gdacsScore: 2,
    affectedCountries: ["ID"],
    severityReason: "Medium: GDACS impact level Orange",
    severitySource: "Impact level assigned by GDACS (gdacs.org)",
    sources: [
      { name: "NASA EONET", url: "https://eonet.gsfc.nasa.gov/" },
      { name: "GDACS", url: "https://www.gdacs.org/report.aspx?eventtype=FL&eventid=900007" },
    ],
  }),
  eonet(8, "storm", "Tropical Cyclone Arnab", null, 18.5, 87.0, 20, {
    severity: "high",
    peakKts: 135,
    currentKts: 55,
    timeline: [45, 70, 110, 135, 120, 90, 55].map((kts, i) => ({
      at: hoursAgo(20 + (6 - i) * 12),
      value: kts,
      unit: "kts",
      lat: 14 + i * 0.7,
      lng: 86 + i * 0.2,
    })),
    magnitudeValue: 55,
    magnitudeUnit: "kts",
    severityReason: "High: peak wind 135 kts (Saffir-Simpson category 4)",
    severitySource: "Severity rule applied to the advisory wind",
  }),
  eonet(9, "flood", "Flood in Libya", "Libya", 32.88, 13.14, 60, {
    severity: "unrated",
    severityReason: "Not rated: the source reports no intensity for this event",
    severitySource: "No GDACS level and no measurement",
  }),
];

function feedPayload() {
  const bySeverity: Record<string, number> = { high: 0, medium: 0, low: 0, unrated: 0 };
  const byType: Record<string, Record<string, number>> = {};
  for (const d of FEED) {
    bySeverity[d.severity] += 1;
    byType[d.type] ??= { total: 0, high: 0, medium: 0, low: 0, unrated: 0 };
    byType[d.type].total += 1;
    byType[d.type][d.severity] += 1;
  }
  return {
    items: FEED,
    count: FEED.length,
    counts: { total: FEED.length, bySeverity, byType },
    source: "NASA + USGS",
    stale: false,
    partial: false,
    sources: { nasa: "ok", usgs: "ok" },
    sourcesUpdatedAt: { nasa: hoursAgo(0.05), usgs: hoursAgo(0.05) },
    updatedAt: hoursAgo(0.05),
    params: { minutesWindow: 10080, limit: 200, minMag: 4.5 },
    // as served by backend/src/utils/severity.js (SEVERITY_RULES)
    severityRules: {
      earthquake: { basis: "magnitude", unit: "M", medium: 5.0, high: 6.0, step: 0.1 },
      wildfire: { basis: "burnedArea", unit: "ha", medium: 7000, high: 10000, step: 1 },
      storm: { basis: "peakWind", unit: "kts", medium: 64, high: 96, step: 1 },
      gdacs: { levels: { green: "low", orange: "medium", red: "high" }, appliesTo: ["wildfire", "flood"] },
    },
  };
}

const related = (id: number) => {
  const e = FEED.find((d) => d.id === id)!;
  return { id: e.id, type: e.type, severity: e.severity, location: String(e.location), lat: e.lat, lng: e.lng, country: e.country ?? null };
};

const NEWS = {
  items: [
    {
      title: "Example coverage: coastal towns count the cost after cyclone passes",
      url: "https://example.com/news/cyclone-aftermath",
      domain: "example.com",
      publishedAt: hoursAgo(13),
      image: null,
      provider: "gdelt",
      relatedEvent: related(8),
      location: null,
    },
    {
      title: "Example coverage: firefighters hold the line as smoke spreads",
      url: "https://example.com/news/wildfire-smoke",
      domain: "example.com",
      publishedAt: hoursAgo(30),
      image: null,
      provider: "gdacs",
      relatedEvent: related(6),
      location: { countries: ["AU"], regions: ["oceania"], source: "event" },
    },
    {
      title: "Example coverage: river levels rise after days of heavy rain",
      url: "https://example.com/news/river-levels",
      domain: "example.com",
      publishedAt: hoursAgo(40),
      image: null,
      provider: "gdacs",
      relatedEvent: related(7),
      location: { countries: ["ID"], regions: ["asia"], source: "event" },
    },
  ],
  count: 3,
  updatedAt: hoursAgo(0.02),
  stale: false,
  source: "cache",
  provider: "gdelt+gdacs",
};

// A small OpenAPI document for the /api page (invented, shaped like GET /api/v1/openapi.json)
const OPENAPI = {
  openapi: "3.1.0",
  info: { title: "DisasterWatch public API", version: "1.0.0", description: "Example document for the visual tests." },
  servers: [{ url: "/api/v1", description: "The site serving this document" }],
  tags: [{ name: "Events" }, { name: "Reference" }],
  paths: {
    "/disasters": {
      get: {
        tags: ["Events"],
        summary: "List events",
        parameters: [{ name: "limit", in: "query", description: "Page size.", schema: { type: "integer", minimum: 1, maximum: 200, default: 50 } }],
        responses: { 200: { description: "A page of events" } },
      },
    },
    "/types": { get: { tags: ["Reference"], summary: "Event types, severity levels and rating rules", responses: { 200: { description: "Reference data" } } } },
  },
};

// 1×1 transparent PNG for every map tile
const BLANK_TILE = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

export async function mockApi(page: Page) {
  await page.clock.setFixedTime(FIXED_NOW);
  await page.route("https://server.arcgisonline.com/**", (route) => route.fulfill({ status: 200, contentType: "image/png", body: BLANK_TILE }));
  await page.route("**/api/**", (route: Route) => {
    const url = new URL(route.request().url());
    const path = url.pathname.replace(/^\/api/, "");
    const json = (body: unknown, status = 200) => route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
    if (path === "/disasters") return json(feedPayload());
    if (path === "/news") {
      // the backend filters by the linked event (?event=), as the drawer's "Related news" relies on
      const event = url.searchParams.get("event");
      const items = event === null ? NEWS.items : NEWS.items.filter((a) => a.relatedEvent?.id === Number(event));
      return json({ ...NEWS, items, count: items.length });
    }
    if (path === "/disasters/impact") {
      // invented figures, shaped like GET /disasters/impact
      const id = url.searchParams.get("eventid");
      if (id === "900006") return json({ populationAffected: 1840, reported: [], fetchedAt: hoursAgo(1), source: "GDACS" });
      if (id === "900007")
        return json({
          populationAffected: null,
          reported: [
            { kind: "people evacuated", value: 320, region: "Example Province", country: "Indonesia" },
            { kind: "houses damaged", value: 45, region: "Example Province", country: "Indonesia" },
          ],
          fetchedAt: hoursAgo(1),
          source: "GDACS",
        });
      return json({ message: "GDACS is not reachable right now" }, 503);
    }
    if (path === "/v1/openapi.json") return json(OPENAPI);
    if (path === "/health") return json({ ok: true, service: "backend", kafka: "connected" });
    if (path === "/users/session") return json({ user: null });
    if (path === "/users/me") return json({ message: "Not signed in" }, 401);
    if (path.startsWith("/news")) return json(NEWS);
    return json({ message: "Not found" }, 404);
  });
}
