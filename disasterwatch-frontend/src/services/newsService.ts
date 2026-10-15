export type NewsType = "earthquake" | "flood" | "wildfire" | "storm";

export type RelatedEvent = {
  id: number;
  type: NewsType;
  severity: "high" | "medium" | "low" | "unrated";
  location: string;
  lat: number;
  lng: number;
};

export type NewsProvider = "gdelt" | "guardian";

export const PROVIDER_LABELS: Record<NewsProvider, string> = {
  gdelt: "GDELT",
  guardian: "The Guardian",
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
};

export type NewsResponse = {
  items: NewsItem[];
  count: number;
  updatedAt: string | null;
  stale: boolean;
  /** Label of the provider that produced the current cache ("GDELT" | "The Guardian"). */
  source?: string;
  provider?: NewsProvider | null;
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
 * type (hazard) and eventId (articles linked to one feed event).
 */
export async function getDisasterNews(
  { type, eventId, limit }: { type?: NewsType | null; eventId?: number | null; limit?: number } = {},
  signal?: AbortSignal
): Promise<NewsResponse> {
  const params = new URLSearchParams();
  if (type) params.set("type", type);
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
