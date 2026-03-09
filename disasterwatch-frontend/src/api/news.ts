import { getJson } from "./client";
import { NEWS_API_URL, NEWS_MOCK_PATH } from "./config";
import type { NewsResponse } from "./types";

export async function fetchNews(): Promise<NewsResponse> {
  // Gerçek API varsa onu kullan
  if (NEWS_API_URL && NEWS_API_URL.trim().length > 0) {
    return getJson<NewsResponse>(NEWS_API_URL);
  }

  // Yoksa mock
  return getJson<NewsResponse>(NEWS_MOCK_PATH);
}
