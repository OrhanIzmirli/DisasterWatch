export type NewsArticle = {
  title: string;
  description?: string;
  url: string;
  sourceName?: string;
  publishedAt: string; // ISO
};

export type NewsResponse = {
  articles: NewsArticle[];
};

// İleride NASA/Backend için (şimdilik sadece tip)
export type DisasterType = "earthquake" | "flood" | "wildfire" | "storm";
export type Severity = "high" | "medium" | "low";

export type DisasterItem = {
  id: number;
  type: DisasterType;
  location: string;
  meta: string;
  severity: Severity;
  timeMinutesAgo: number;
  description: string;
  lat: number;
  lng: number;
};
