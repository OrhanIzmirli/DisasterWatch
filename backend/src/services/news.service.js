// backend/src/services/news.service.js

const GDELT_ENDPOINT = "https://api.gdeltproject.org/api/v2/doc/doc";

// 5-min simple cache (keyed by query+limit)
let cache = { ts: 0, key: "", data: [] };
const CACHE_MS = 5 * 60 * 1000;

function safeStr(v) {
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function normalizeGdeltArticle(a) {
  const title = safeStr(a?.title) || "Untitled";
  const url = safeStr(a?.url);
  const publishedAt = safeStr(a?.seendate || a?.date || a?.datetime || "");
  const summary = safeStr(a?.snippet || a?.description || "");
  const image = safeStr(a?.image || a?.socialimage || "");

  const source =
    safeStr(a?.domain) ||
    safeStr(a?.sourceCountry) ||
    safeStr(a?.sourceCollection) ||
    safeStr(a?.source) ||
    "Unknown";

  return { title, url, source, publishedAt, summary, image };
}

export async function fetchDisasterNews({ limit = 40 } = {}) {
  const now = Date.now();

  // ✅ English-only filter MUST be in query (GDELT query operator)
  const baseQuery =
    '(earthquake OR quake OR flood OR wildfire OR "forest fire" OR storm OR hurricane OR cyclone OR disaster OR "climate emergency")';

  const query = `${baseQuery} sourcelang:English`;

  const cacheKey = `${query}__limit=${limit}`;

  // cache hit (key aware)
  if (
    cache.key === cacheKey &&
    now - cache.ts < CACHE_MS &&
    Array.isArray(cache.data) &&
    cache.data.length
  ) {
    return cache.data;
  }

  const params = new URLSearchParams({
    query,
    mode: "ArtList",
    format: "json",
    sort: "HybridRel",
    maxrecords: String(limit),
  });

  const url = `${GDELT_ENDPOINT}?${params.toString()}`;

  const res = await fetch(url);
  if (!res.ok) throw new Error(`GDELT news fetch failed: ${res.status}`);

  const data = await res.json();

  const articles = Array.isArray(data?.articles) ? data.articles : [];
  const mapped = articles.map(normalizeGdeltArticle);

  // update cache
  cache = { ts: now, key: cacheKey, data: mapped };
  return mapped;
}
