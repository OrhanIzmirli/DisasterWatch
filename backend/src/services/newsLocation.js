/**
 * Where a news article is about, for the news panel's region filter.
 *
 * Each article gets `location = { countries: ["MX"], regions: ["americas"], source }`
 * or null. The country comes, in this order, from:
 *
 *   1. the feed event it is linked to (the event's country, derived from the
 *      source place name: src/utils/country.js);
 *   2. its Guardian keyword tags ("Mexico", "California" -> US; a region tag
 *      such as world/americas gives the region only);
 *   3. the GDACS event it came with (GDACS media news: the event's affected
 *      countries).
 *
 * Nothing is guessed: an article none of these place stays unlocated
 * (location: null) and is listed only under "All regions". A fixed
 * country -> region table maps ISO 3166-1 alpha-2 codes to six regions.
 * Russia spans two: the event's longitude decides (>= 60° E is Asia); without
 * coordinates it counts for both.
 */
import { countryFromToken } from "../utils/country.js";

export const REGIONS = [
  { id: "africa", label: "Africa" },
  { id: "americas", label: "Americas" },
  { id: "asia", label: "Asia" },
  { id: "europe", label: "Europe" },
  { id: "middle-east", label: "Middle East" },
  { id: "oceania", label: "Oceania" },
];
export const REGION_IDS = new Set(REGIONS.map((r) => r.id));

const REGION_COUNTRIES = {
  africa:
    "DZ AO BJ BW BF BI CV CM CF TD KM CG CD CI DJ GQ ER SZ ET GA GM GH GN GW KE LS LR LY MG MW ML MR MU YT MA MZ NA NE NG RE RW SH ST SN SC SL SO ZA SS SD TZ TG TN UG EH ZM ZW",
  americas:
    "AI AG AR AW BS BB BZ BM BO BQ BR VG CA KY CL CO CR CU CW DM DO EC SV FK GF GL GD GP GT GY HT HN JM MQ MX MS NI PA PY PE PR BL KN LC MF PM VC SX SR TT TC US UM VI UY VE",
  asia: "AF BD BT BN KH CN HK IN ID JP KZ KG LA MO MY MV MN MM NP KP PK PH SG KR LK TW TJ TH TL TM UZ VN IO",
  europe:
    "AX AL AD AM AT AZ BY BE BA BG HR CY CZ DK EE FO FI FR GE DE GI GR GG HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH UA GB VA",
  "middle-east": "BH EG IR IQ IL JO KW LB OM PS QA SA SY TR AE YE",
  oceania: "AS AU CK FJ PF GU KI MH FM NR NC NZ NU NF MP PW PG PN WS SB TK TO TV VU WF CX CC",
};

/** ISO alpha-2 -> region id (Russia is handled separately). */
export const COUNTRY_REGION = new Map(
  Object.entries(REGION_COUNTRIES).flatMap(([region, codes]) => codes.split(" ").map((code) => [code, region]))
);

/** Regions of one country; [] when the code is unknown. */
export function regionsOfCountry(code, lng = null) {
  if (code === "RU") {
    if (Number.isFinite(lng)) return [lng >= 60 ? "asia" : "europe"];
    return ["europe", "asia"];
  }
  const region = COUNTRY_REGION.get(code);
  return region ? [region] : [];
}

/** English country name -> ISO alpha-2 (the same Intl names src/utils/country.js returns). */
function buildCodes() {
  const codes = new Map();
  let display = null;
  try {
    display = new Intl.DisplayNames(["en"], { type: "region" });
  } catch {
    return codes;
  }
  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  for (const a of letters) {
    for (const b of letters) {
      let name;
      try {
        name = display.of(a + b);
      } catch {
        continue;
      }
      if (!name || name === a + b) continue;
      // several codes share a name (BU/MM, SU/RU, UK/GB): keep the one the region table knows
      const key = name.toLowerCase();
      if (!codes.has(key) || (!regionsOfCountry(codes.get(key)).length && regionsOfCountry(a + b).length)) codes.set(key, a + b);
    }
  }
  return codes;
}
const CODES = buildCodes();

/** ISO alpha-2 for a country name or alias ("Türkiye", "USA", "California" -> "US"); null when not a country. */
export function countryCode(name) {
  const country = countryFromToken(name);
  return country ? (CODES.get(country.toLowerCase()) ?? null) : null;
}

/** Guardian region tags (world/...) -> region ids. Only used when no country tag places the article. */
const GUARDIAN_REGION_TAGS = {
  "world/africa": ["africa"],
  "world/americas": ["americas"],
  "world/asia": ["asia"],
  "world/south-and-central-asia": ["asia"],
  "world/asia-pacific": ["asia", "oceania"],
  "world/europe-news": ["europe"],
  "world/middleeast": ["middle-east"],
};

/**
 * Countries and regions named by a Guardian result's keyword tags
 * ({ id: "world/mexico", webTitle: "Mexico", type: "keyword" }). Only the
 * derived codes are kept, never the tags themselves.
 */
export function guardianTagPlace(tags) {
  const countries = [];
  const regions = [];
  for (const t of Array.isArray(tags) ? tags : []) {
    if (t?.type && t.type !== "keyword") continue;
    const id = String(t?.id ?? "");
    for (const r of GUARDIAN_REGION_TAGS[id] ?? []) if (!regions.includes(r)) regions.push(r);
    const code = countryCode(t?.webTitle);
    if (code && !countries.includes(code)) countries.push(code);
  }
  return countries.length || regions.length ? { countries, regions } : null;
}

const unique = (list) => [...new Set(list)];

function placed(countries, source, lng = null, fallbackRegions = []) {
  const fromCountries = unique(countries.flatMap((c) => regionsOfCountry(c, lng)));
  const regions = fromCountries.length ? fromCountries : unique(fallbackRegions);
  return regions.length || countries.length ? { countries, regions, source } : null;
}

/**
 * Location of one article, in priority order: linked feed event -> Guardian
 * tags (`tagPlace`) -> GDACS event (`gdacsPlace`). null when none of them
 * places it.
 */
export function resolveLocation(article) {
  const ev = article?.relatedEvent;
  const evCode = ev?.country ? countryCode(ev.country) : null;
  if (evCode) {
    const loc = placed([evCode], "event", Number.isFinite(ev.lng) ? ev.lng : null);
    if (loc) return loc;
  }
  const tags = article?.tagPlace;
  if (tags && (tags.countries?.length || tags.regions?.length)) {
    const loc = placed(tags.countries ?? [], "guardian-tags", null, tags.regions ?? []);
    if (loc) return loc;
  }
  const g = article?.gdacsPlace;
  if (g?.countries?.length) {
    const loc = placed(g.countries, "gdacs", Number.isFinite(g.lng) ? g.lng : null);
    if (loc) return loc;
  }
  return null;
}

/** The article with `location` set and the helper fields (tagPlace, gdacsPlace) removed. */
export function withLocation(article) {
  const { tagPlace, gdacsPlace, ...rest } = article;
  return { ...rest, location: resolveLocation(article) };
}
