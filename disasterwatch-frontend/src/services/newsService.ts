export type NewsType = "earthquake" | "flood" | "wildfire" | "storm";

export type RelatedEvent = {
  id: number;
  type: NewsType;
  severity: "high" | "medium" | "low" | "unrated";
  location: string;
  lat: number;
  lng: number;
  /** The feed event's country name, when the source place names one. */
  country?: string | null;
};

export type NewsProvider = "gdelt" | "guardian" | "gdacs";

export const PROVIDER_LABELS: Record<NewsProvider, string> = {
  gdelt: "GDELT",
  guardian: "The Guardian",
  gdacs: "GDACS",
};

export type NewsRegion = "africa" | "americas" | "asia" | "europe" | "middle-east" | "oceania";

export const REGION_LABELS: Record<NewsRegion, string> = {
  africa: "Africa",
  americas: "Americas",
  asia: "Asia",
  europe: "Europe",
  "middle-east": "Middle East",
  oceania: "Oceania",
};

/**
 * Where the article is about: from its linked feed event, else its Guardian
 * tags, else its GDACS event. Null when none of them places it (the article
 * is then listed only under "All regions").
 */
export type NewsLocation = {
  /** ISO 3166-1 alpha-2 codes. */
  countries: string[];
  regions: NewsRegion[];
  source: "event" | "guardian-tags" | "gdacs";
};

export type NewsItem = {
  title: string;
  url: string;
  domain: string;
  publishedAt: string | null;
  image?: string | null;
  /** Which news provider supplied the article (shown as "via …" on the card). */
  provider?: NewsProvider;
  relatedEvent?: RelatedEvent | null;
  location?: NewsLocation | null;
};

export type NewsResponse = {
  items: NewsItem[];
  count: number;
  updatedAt: string | null;
  stale: boolean;
  /** Labels of the providers in the current cache, e.g. "The Guardian + GDACS". */
  source?: string;
  /** Provider names joined with "+", e.g. "guardian+gdacs" (merged cache). */
  provider?: string | null;
};

export class NewsError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "NewsError";
    this.status = status;
  }
}

/**
 * GET /api/news (served from the backend's cache). Optional filters:
 * type (hazard), region (unlocated articles never match one) and eventId
 * (articles linked to one feed event).
 */
export async function getDisasterNews(
  { type, region, eventId, limit }: { type?: NewsType | null; region?: NewsRegion | null; eventId?: number | null; limit?: number } = {},
  signal?: AbortSignal
): Promise<NewsResponse> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
  if (region) params.set("region", region);
  if (eventId !== undefined && eventId !== null) params.set("event", String(eventId));
  if (limit) params.set("limit", String(limit));
  const qs = params.toString();

  const res = await fetch(`/api/news${qs ? `?${qs}` : ""}`, { signal, headers: { Accept: "application/json" } });
  const contentType = res.headers.get("content-type") || "";
  const body = contentType.includes("application/json") ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    const message =
      body?.message ||
      (res.status === 503 ? "News is still loading on the server." : `News request failed (${res.status}).`);
    throw new NewsError(message, res.status);
  }
  if (!body) {
    throw new NewsError("News response was not JSON.", res.status);
  }

  return {
    items: Array.isArray(body.items) ? body.items : [],
    count: Number(body.count) || 0,
    updatedAt: body.updatedAt ?? null,
    stale: Boolean(body.stale),
    source: body.source,
    provider: body.provider ?? null,
  };
}
