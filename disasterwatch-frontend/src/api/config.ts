const env = (import.meta as any).env ?? {};

// API base: önce VITE_API_URL, yoksa VITE_API_BASE_URL, yoksa "/api"
export const API_BASE_URL: string =
  (env.VITE_API_URL || env.VITE_API_BASE_URL || "/api") as string;

// News API: önce env, yoksa "/api/news"
export const NEWS_API_URL: string =
  (env.VITE_NEWS_API_URL || "/api/news") as string;

// Mock path aynı kalsın
export const NEWS_MOCK_PATH: string =
  (env.VITE_NEWS_MOCK_PATH || "/mock/news.json") as string;
