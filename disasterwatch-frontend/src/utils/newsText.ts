/**
 * Display text for news cards (news panel). Kept out of the component file so
 * the component module only exports components (React Fast Refresh).
 */
import { PROVIDER_LABELS, REGION_LABELS, type NewsItem, type NewsType } from "../services/newsService";
import { cleanTitle } from "./eventText";

const TYPE_LABELS: Record<NewsType, string> = {
  earthquake: "Earthquake",
  flood: "Flood",
  wildfire: "Wildfire",
  storm: "Storm",
};

const capitalise = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** "via GDELT" / "via The Guardian"; unknown provider (old cache) shows nothing. */
/** Languages the backend reads besides English (backend/src/services/newsLanguages.js). */
export const LANGUAGE_NAMES: Record<string, string> = { en: "English", tr: "Turkish", es: "Spanish", fr: "French", de: "German", pt: "Portuguese", unknown: "Language not given" };

/** "Turkish · Turkey" for an article in another language; null for English or when nothing is known. */
export function originText(item: NewsItem) {
  if (!item.language || item.language === "en") return null;
  const name = LANGUAGE_NAMES[item.language] ?? item.language;
  return item.sourceCountry ? `${name} · ${item.sourceCountry}` : name;
}

export function providerText(item: NewsItem) {
  return item.provider && PROVIDER_LABELS[item.provider] ? `via ${PROVIDER_LABELS[item.provider]}` : null;
}

let countryNames: Intl.DisplayNames | null = null;
try {
  countryNames = new Intl.DisplayNames(["en"], { type: "region" });
} catch {
  countryNames = null;
}

/** "Mexico" for "MX"; the code itself when the browser has no name for it. */
export function countryName(code: string) {
  try {
    return countryNames?.of(code) ?? code;
  } catch {
    return code;
  }
}

/**
 * "Türkiye · Middle East" / "Mexico, United States · Americas" / "Africa"
 * (region tag only) for a located article; null when it has no location.
 */
export function locationText(item: NewsItem) {
  const loc = item.location;
  if (!loc || (!loc.countries?.length && !loc.regions?.length)) return null;
  const countries = (loc.countries ?? []).map(countryName).join(", ");
  const regions = (loc.regions ?? []).map((r) => REGION_LABELS[r] ?? r).join(", ");
  return [countries, regions].filter(Boolean).join(" · ");
}

/**
 * "Earthquake · M 5.2 - 107 km NNE of Hihifo, Tonga · Medium" for an article linked to a feed event;
 * "Wildfire in Indonesia · High" when the title already names the type.
 */
export function eventTagText(item: NewsItem) {
  const e = item.relatedEvent;
  if (!e) return null;
  // the location is the event's clean title; older cached payloads may still carry the raw source id
  const type = TYPE_LABELS[e.type] ?? capitalise(e.type);
  const title = cleanTitle(e.location);
  const severity = e.severity === "unrated" ? "Not rated" : capitalise(e.severity);
  // "Wildfire in Indonesia" already names the type: no "Wildfire · Wildfire in Indonesia"
  const namesType = title.toLowerCase().startsWith(type.toLowerCase());
  return namesType ? `${title} · ${severity}` : `${type} · ${title} · ${severity}`;
}
