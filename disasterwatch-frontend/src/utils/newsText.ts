/**
 * Display text for news cards (news panel). Kept out of the component file so
 * the component module only exports components (React Fast Refresh).
 */
import { PROVIDER_LABELS, type NewsItem, type NewsType } from "../services/newsService";
import { cleanTitle } from "./eventText";

const TYPE_LABELS: Record<NewsType, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "via GDELT" / "via The Guardian"; unknown provider (old cache) shows nothing. */
export function providerText(item: NewsItem) {
  return item.provider && PROVIDER_LABELS[item.provider] ? `via ${PROVIDER_LABELS[item.provider]}` : null;
}

/** "Earthquake · M 5.2 - 107 km NNE of Hihifo, Tonga · Medium" for an article linked to a feed event. */
export function eventTagText(item: NewsItem) {
  const e = item.relatedEvent;
  if (!e) return null;
  // the location is the event's clean title; older cached payloads may still carry the raw source id
  return `${TYPE_LABELS[e.type] ?? capitalise(e.type)} · ${cleanTitle(e.location)} · ${e.severity === "unrated" ? "Not rated" : capitalise(e.severity)}`;
}
