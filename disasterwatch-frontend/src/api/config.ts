const env = (import.meta as any).env ?? {};

// API base: VITE_API_URL, then VITE_API_BASE_URL, then "/api"
export const API_BASE_URL: string =
  (env.VITE_API_URL || env.VITE_API_BASE_URL || "/api") as string;

// News API: env value, otherwise "/api/news"
export const NEWS_API_URL: string =
  (env.VITE_NEWS_API_URL || "/api/news") as string;

// Mock path stays the same
export const NEWS_MOCK_PATH: string =
  (env.VITE_NEWS_MOCK_PATH || "/mock/news.json") as string;
