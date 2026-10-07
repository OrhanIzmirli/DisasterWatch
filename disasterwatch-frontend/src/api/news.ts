import { getJson } from "./client";
import { NEWS_API_URL, NEWS_MOCK_PATH } from "./config";
import type { NewsResponse } from "./types";

export async function fetchNews(): Promise<NewsResponse> {
  // Use the real API when available
  if (NEWS_API_URL && NEWS_API_URL.trim().length > 0) {
    return getJson<NewsResponse>(NEWS_API_URL);
  }

  // Otherwise fall back to mock data
  return getJson<NewsResponse>(NEWS_MOCK_PATH);
}
