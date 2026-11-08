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
 *      countries);
 *   4. a GDELT headline that names exactly one country, in the article's own
 *      language (headlineCountry below).
 *
 * Nothing is guessed: an article none of these place stays unlocated
 * (location: null) and is listed only under "All regions". A fixed
 * country -> region table maps ISO 3166-1 alpha-2 codes to six regions.
 * Russia spans two: the event's longitude decides (>= 60° E is Asia); without
 * coordinates it counts for both.
 */
import { countryFromToken, countryAliases, usStates } from "../utils/country.js";
import { CITY_COUNTRY } from "./newsCities.js";
import { LANGUAGE_NAMES } from "./newsLanguages.js";

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
    "AX AL AD AM AT AZ BY BE BA BG HR CY CZ DK EE FO FI FR GE DE GI GR GG HU IS IE IM IT JE XK LV LI LT LU MT MD MC ME NL MK NO PL PT RO SM RS SK SI ES SJ SE CH TR UA GB VA",
  "middle-east": "BH EG IR IQ IL JO KW LB OM PS QA SA SY AE YE",
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
  const code = headlineCountry(article);
  return code ? placed([code], "headline") : null;
}

/** Adjectives headlines use instead of the country name ("Nepali villages", "Turkish officials"). */
const DEMONYMS = {
  AF: ["afghan"], AR: ["argentine", "argentinian"], AU: ["australian"], BD: ["bangladeshi"], BR: ["brazilian"], CA: ["canadian"],
  CL: ["chilean"], CN: ["chinese"], CO: ["colombian"], DE: ["german"], EC: ["ecuadorian"], EG: ["egyptian"], ES: ["spanish"],
  ET: ["ethiopian"], FR: ["french"], GB: ["british"], GR: ["greek"], GT: ["guatemalan"], HT: ["haitian"], ID: ["indonesian"],
  IN: ["indian"], IR: ["iranian"], IT: ["italian"], JP: ["japanese"], KE: ["kenyan"], KR: ["south korean"], LK: ["sri lankan"],
  LY: ["libyan"], MA: ["moroccan"], MM: ["burmese"], MX: ["mexican"], MY: ["malaysian"], NG: ["nigerian"], NP: ["nepali", "nepalese"],
  NZ: ["new zealand"], PE: ["peruvian"], PH: ["philippine", "filipino"], PK: ["pakistani"], PT: ["portuguese"], RU: ["russian"],
  SO: ["somali"], TH: ["thai"], TR: ["turkish"], TW: ["taiwanese"], UA: ["ukrainian"], US: ["american"], VN: ["vietnamese"],
  ZA: ["south african"],
};

const fold = (s) =>
  String(s ?? "")
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i") // Turkish dotless i: "MISIR" and "Mısır" read the same
    .replace(/[’‘]/g, "'");

/**
 * Names that can mean something else in a headline, so they never place an
 * article on their own: the US state and the country, a first name, the
 * Spanish city and the Caribbean island, the second half of New Jersey, the
 * two Congos.
 */
const AMBIGUOUS_NAMES = ["georgia", "georgie", "jordan", "chad", "reunion", "jersey", "granada", "washington", "congo"];
/** Everyday words of one language that equal a place name: "sabah" (morning), "mali" (financial), "cin", "madeira" (wood), "ira" (anger), "chili". */
const COMMON_WORDS = { tr: ["mali", "cin", "misir", "sabah"], pt: ["madeira", "ira"], fr: ["chili"] };
/** Places whose name holds a country they are not in; removed before matching. */
const NOT_THE_COUNTRY = [
  "gulf of mexico", "golfo de mexico", "golfo do mexico", "golfe du mexique", "golf von mexiko", "meksika korfezi",
  "nuevo mexico", "novo mexico", "nouveau-mexique", "nouveau mexique", "yeni meksika",
  "gulf of guinea", "gulf of oman", "gulf of thailand", "sea of japan", "south china sea", "east china sea",
  "mar de japon", "mar do japao", "mer du japon", "japon denizi", "mar de china", "mar da china", "mer de chine",
];

const WORD_EDGE_BEFORE = "(^|[^\\p{L}\\p{N}])";
const WORD_EDGE_AFTER = "(?![\\p{L}\\p{N}])";
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Every code the region table knows, plus Russia, which it handles apart. */
const placeableCodes = () => [...COUNTRY_REGION.keys(), "RU"];

const HEADLINE_TERMS = new Map();

/**
 * Compiled place names for headlines in one language, longest first ("south
 * sudan" before "sudan"). Each language looks for its own country names
 * ("Japonya", "Japón", "Japon"); English also knows the US states and the
 * aliases, which are English words ("usa" is a verb in Spanish). Demonyms
 * are left out: "Indian Ocean", "Turkish Airlines" and "American Red Cross"
 * are not places.
 */
function headlineTerms(language) {
  const lang = LANGUAGE_NAMES[language] ? language : "en";
  if (HEADLINE_TERMS.has(lang)) return HEADLINE_TERMS.get(lang);
  const terms = new Map();
  const add = (term, code) => {
    const t = fold(term).replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (code && t.length >= 3) terms.set(t, code);
  };
  if (lang === "en") {
    for (const state of usStates()) add(state, "US");
    for (const [alias, name] of countryAliases()) add(alias, countryCode(name));
  }
  const display = new Intl.DisplayNames([lang], { type: "region" });
  for (const code of placeableCodes()) add(display.of(code), code);
  add("hong kong", "HK");
  for (const [city, code] of CITY_COUNTRY) add(city, code);
  for (const word of [...AMBIGUOUS_NAMES, ...(COMMON_WORDS[lang] ?? [])]) terms.delete(word);
  const compiled = [...terms]
    .sort((a, b) => b[0].length - a[0].length)
    .map(([term, code]) => ({ code, pattern: new RegExp(`${WORD_EDGE_BEFORE}${escapeRegExp(term)}${WORD_EDGE_AFTER}`, "gu") }));
  HEADLINE_TERMS.set(lang, compiled);
  return compiled;
}

/**
 * ISO code of the one country a GDELT headline names, or null. GDELT sends no
 * place for an article and most of its articles match no feed event, so the
 * headline is all there is. Two countries ("Japan sends aid to Peru") leave
 * the article unlocated: the headline does not say which one it is about. A
 * name found is blanked, so "Papua New Guinea" is not also "Guinea".
 */
export function headlineCountry(article) {
  if (article?.provider !== "gdelt") return null;
  let text = fold(article.title);
  for (const place of NOT_THE_COUNTRY) text = text.split(place).join(" ");
  const found = new Set();
  for (const { code, pattern } of headlineTerms(article.language)) {
    const rest = text.replace(pattern, "$1 ");
    if (rest === text) continue;
    found.add(code);
    text = rest;
  }
  return found.size === 1 ? [...found][0] : null;
}

/** Lower-case, accent-free names a headline may use for each country code. */
function buildCountryTerms() {
  const terms = new Map();
  const add = (code, term) => {
    const t = fold(term).replace(/\s*\(.*?\)\s*/g, " ").trim();
    if (!code || t.length < 3) return;
    if (!terms.has(code)) terms.set(code, new Set());
    terms.get(code).add(t);
  };
  for (const [name, code] of CODES) add(code, name);
  for (const [alias, name] of countryAliases()) add(countryCode(name), alias);
  for (const [code, words] of Object.entries(DEMONYMS)) for (const w of words) add(code, w);
  return terms;
}
let COUNTRY_TERMS = null;

const HAZARD_LABEL_WORDS = new Set(["flood", "floods", "wildfire", "wildfires", "forest", "fire", "fires", "storm", "tropical", "cyclone", "hurricane", "typhoon", "earthquake", "volcano", "drought", "in", "of", "near", "off", "the", "and", "region", "province", "state"]);

/** Whole-word, accent-free match. */
function mentions(text, term) {
  return new RegExp(`(^|[^\\p{L}\\p{N}])${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`, "u").test(text);
}

/** Headline plus the URL's last path segment (the story slug), folded. */
function articleText(article) {
  let slug = "";
  try {
    slug = new URL(article?.url).pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    slug = "";
  }
  return fold(`${article?.title ?? ""} ${slug.replace(/[-_]+/g, " ").replace(/\.\w+$/, "")}`);
}

/**
 * Does the article itself name this country (its name, an alias, a
 * demonym) or a place word of its linked event's label ("Padang" in
 * "Flood in Padang")?
 */
export function namesCountry(article, code) {
  if (!COUNTRY_TERMS) COUNTRY_TERMS = buildCountryTerms();
  const text = articleText(article);
  if ([...(COUNTRY_TERMS.get(code) ?? [])].some((t) => mentions(text, t))) return true;
  const label = article?.relatedEvent?.location;
  if (label && countryCode(article.relatedEvent.country) === code) {
    const places = fold(label)
      .split(/[^\p{L}'-]+/u)
      .filter((w) => w.length >= 4 && !HAZARD_LABEL_WORDS.has(w));
    if (places.some((w) => mentions(text, w))) return true;
  }
  return false;
}

/** Countries of the unambiguous cities (src/services/newsCities.js) the headline or slug names. */
function citiesNamed(article) {
  let text = articleText(article);
  const codes = new Set();
  for (const [city, code] of CITY_COUNTRY) {
    if (!mentions(text, city)) continue;
    codes.add(code);
    text = text.split(city).join(" "); // "new delhi" is not also "delhi"
  }
  return codes;
}

/**
 * Honesty check on a resolved location. GDACS media lists are noisy (an
 * Indonesian story can sit in the list of a fire in China), so a GDACS
 * article keeps an inherited country (from its event or the GDACS report)
 * only when its headline or slug names that country or an unambiguous city
 * of it ("Istanbul" -> Türkiye); a city of another country contradicts it.
 * Otherwise it is left unlocated. Other placements (Guardian tags, events linked by place-name
 * match) are kept as they are. Applied when fetching and again when serving
 * from the cache.
 */
export function confirmLocation(article, loc) {
  if (!loc) return null;
  if (article?.provider !== "gdacs" || loc.source === "guardian-tags") return loc;
  const cityCountries = citiesNamed(article);
  // a city of another country contradicts the inherited place
  if ([...cityCountries].some((c) => !loc.countries.includes(c))) return null;
  const countries = loc.countries.filter((c) => namesCountry(article, c) || cityCountries.has(c));
  if (!countries.length) return null;
  if (countries.length === loc.countries.length) return loc;
  const lng = Number.isFinite(article?.relatedEvent?.lng) ? article.relatedEvent.lng : null;
  return placed(countries, loc.source, lng);
}

/** The article with `location` set and the helper fields (tagPlace, gdacsPlace) removed. */
export function withLocation(article) {
  const { tagPlace, gdacsPlace, ...rest } = article;
  return { ...rest, location: confirmLocation(rest, resolveLocation(article)) };
}
