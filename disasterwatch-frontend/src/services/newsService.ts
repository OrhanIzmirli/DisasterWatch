export type NewsItem = {
  title: string;
  url: string;
  source: string;
  publishedAt: string;
  summary?: string;
  image?: string;
};

export async function getDisasterNews(limit = 10): Promise<NewsItem[]> {
  // ✅ nginx üzerinden backend'e gider: http://localhost:8080/api/news
  const res = await fetch(`/api/news?limit=${limit}`);

  const contentType = res.headers.get("content-type") || "";

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`News fetch failed (${res.status}). ${text.slice(0, 120)}`);
  }

  // ✅ HTML geldiyse burada yakalarız
  if (!contentType.includes("application/json")) {
    const text = await res.text().catch(() => "");
    throw new Error(`News is not JSON. ${text.slice(0, 120)}`);
  }

  const data = await res.json();
  return Array.isArray(data?.items) ? data.items : [];
}
