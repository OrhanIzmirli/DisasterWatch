/**
 * Links disaster events to news articles. Pure logic plus one injectable
 * article search, so it can be unit tested and reused by the admin-entry
 * verification step in a later release.
 *
 *   findArticlesForEvent({ type, locationText, occurredAt }, { searchArticles })
 *     -> [{ title, url, domain, publishedAt, image }]
 *
 * The news refresh no longer searches once per event: buildSearchPlan()
 * folds the top events into at most a few provider-neutral queries (one per
 * hazard type, places OR-ed together) and linkArticlesToEvents() assigns the
 * returned articles to events on our side, by place and hazard words in the
 * title and URL.
 */

const TYPE_KEYWORDS = {
  earthquake: "(earthquake OR quake OR tremor)",
  flood: "(flood OR flooding OR floods)",
  wildfire: '(wildfire OR "forest fire" OR bushfire OR "brush fire")',
  storm: "(storm OR hurricane OR cyclone OR typhoon)",
};

/** Same hazard vocabulary as TYPE_KEYWORDS, as plain terms for providers and matching. */
export const HAZARD_TERMS = {
  earthquake: ["earthquake", "quake", "tremor"],
  flood: ["flood", "flooding", "floods"],
  wildfire: ["wildfire", "forest fire", "bushfire", "brush fire"],
  storm: ["storm", "hurricane", "cyclone", "typhoon"],
};
export const GENERAL_TERMS = ["earthquake", "flood", "wildfire", "forest fire", "hurricane", "cyclone", "typhoon", "natural disaster"];

/**
 * Words that make an article a disaster story. General-search results must
 * name one of these in the headline or standfirst; the provider may have
 * matched a hazard word anywhere in the body ("Did Trump get one thing
 * right about Greenland?" matched "storm" in the text).
 */
export const DISASTER_KEYWORDS = [
  "earthquake", "earthquakes", "quake", "quakes", "tremor", "tremors", "aftershock", "aftershocks",
  "flood", "floods", "flooding", "flooded", "flash flood", "deluge",
  "wildfire", "wildfires", "bushfire", "bushfires", "forest fire", "forest fires", "brush fire", "brushfire",
  "storm", "storms", "hurricane", "cyclone", "typhoon", "tornado", "tornadoes",
  "tsunami", "eruption", "erupts", "volcano", "volcanic", "landslide", "landslides", "mudslide", "mudslides",
  "natural disaster", "evacuated", "evacuation", "evacuations",
];

/** True when the headline or the standfirst/summary names a hazard (whole words, case-insensitive). */
export function mentionsDisaster(article) {
  const text = `${article?.title ?? ""} ${article?.summary ?? ""}`.toLowerCase();
  return DISASTER_KEYWORDS.some((k) => containsWord(text, k));
}

/** Place words too generic to identify an event on their own. */
const PLACE_STOPWORDS = new Set(["the", "and", "of", "de", "del", "la", "le", "north", "south", "east", "west", "central", "new", "islands", "island", "coast", "sea", "ocean", "gulf", "bay"]);

export const GENERAL_QUERY =
  '(earthquake OR flood OR wildfire OR "forest fire" OR hurricane OR cyclone OR typhoon OR "natural disaster")';

/** Words that describe the hazard rather than the place; dropped from locations. */
const HAZARD_WORDS =
  /\b(wildfire|wildfires|fire|fires|flood|floods|flooding|earthquake|quake|storm|storms|severe|tropical|hurricane|cyclone|typhoon|depression|volcano|eruption|landslide|drought)\b/gi;

/**
 * "Flood in Nepal 1104225"            -> "Nepal"
 * "53 km S of Kushiro, Japan"         -> "Kushiro Japan"
 * "M 6.0 - 126 km S of Kokopo, PNG"   -> "Kokopo PNG"
 * "Wildfire in Mongolia, China 1032753" -> "Mongolia China"
 * "Hurricane Simon"                   -> "Simon"
 * "Wildfire Buckhorn 2, Cassia, Idaho" -> "Buckhorn Cassia Idaho"
 */
export function cleanLocationText(text) {
  let s = String(text ?? "");
  s = s.replace(/^\s*M\s?\d+(\.\d+)?\s*-\s*/i, ""); // "M 6.0 - "
  s = s.replace(/\s+\d{4,}\s*$/u, ""); // trailing numeric source id
  s = s.replace(/\b\d+(\.\d+)?\s*(km|mi|miles)\s+[NSEW]{1,3}\s+of\s+/gi, ""); // "53 km S of "
  s = s.replace(/\b\d+(\.\d+)?\s*(km|mi|miles)\s+(north|south|east|west|[a-z]+)\s+of\s+/gi, "");
  s = s.replace(/^\s*[a-z ]+?\s+in\s+/i, ""); // "Flood in ", "Severe Storm in "
  s = s.replace(HAZARD_WORDS, " ");
  s = s.replace(/\b(near|off|the coast of|region|area|province)\b/gi, " ");
  s = s.replace(/[^\p{L}\p{N}\s'-]/gu, " "); // punctuation, commas
  s = s.replace(/\b\d+\b/g, " "); // stray numbers ("Buckhorn 2")
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

/** GDELT query for one event: hazard keywords + cleaned place, English only. */
export function buildEventQuery({ type, locationText }) {
  const place = cleanLocationText(locationText);
  const keywords = TYPE_KEYWORDS[type] || "disaster";
  const placeTerm = place ? ` ${quotePlace(place)}` : "";
  return `${keywords}${placeTerm} sourcelang:english`;
}

function quotePlace(place) {
  // Multi-word places are quoted so GDELT treats them as a phrase; single
  // words are left bare. Two-part places ("Kushiro Japan") become an AND.
  const words = place.split(" ");
  if (words.length <= 1) return place;
  if (words.length === 2) return `${words[0]} ${words[1]}`;
  return `"${place}"`;
}

/** GDELT "20261013T120000Z" -> ISO; also accepts anything Date can parse. */
export function parseGdeltDate(value) {
  const s = String(value ?? "");
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.000Z`;
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function normalizeArticle(raw) {
  const url = String(raw?.url ?? "").trim();
  if (!url) return null;
  let domain = String(raw?.domain ?? "").trim();
  if (!domain) {
    try {
      domain = new URL(url).hostname.replace(/^www\./, "");
    } catch {
      domain = "";
    }
  }
  return {
    title: String(raw?.title ?? "").replace(/\s+/g, " ").trim() || "Untitled",
    url,
    domain,
    publishedAt: parseGdeltDate(raw?.seendate ?? raw?.date ?? raw?.datetime),
    image: String(raw?.socialimage ?? raw?.image ?? "").trim() || null,
  };
}

function titleKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter((w) => w.length > 2)
    .slice(0, 10)
    .join(" ");
}

function titleTokens(title) {
  return new Set(titleKey(title).split(" ").filter(Boolean));
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter += 1;
  return inter / (a.size + b.size - inter);
}

/**
 * Removes duplicates by URL (ignoring query/hash and a www. prefix) and by
 * near-identical titles (Jaccard >= 0.8 on the first ten significant words).
 * Keeps the first occurrence, so callers pass the preferred order.
 */
export function dedupeArticles(articles) {
  const seenUrls = new Set();
  const kept = [];
  const keptTokens = [];

  for (const a of articles) {
    if (!a?.url) continue;
    let urlKey;
    try {
      const u = new URL(a.url);
      urlKey = `${u.hostname.replace(/^www\./, "")}${u.pathname.replace(/\/+$/, "")}`.toLowerCase();
    } catch {
      urlKey = a.url.toLowerCase();
    }
    if (seenUrls.has(urlKey)) continue;

    const tokens = titleTokens(a.title);
    if (keptTokens.some((t) => jaccard(t, tokens) >= 0.8)) continue;

    seenUrls.add(urlKey);
    keptTokens.push(tokens);
    kept.push(a);
  }
  return kept;
}

/**
 * Articles for one event: targeted GDELT search (last 72 h, English),
 * normalised, deduplicated, and filtered to articles published no earlier
 * than 24 h before the event (when occurredAt is known).
 *
 * @param {{ type: string, locationText: string, occurredAt?: string|null }} event
 * @param {{ searchArticles: (opts) => Promise<object[]>, maxRecords?: number, timespan?: string }} deps
 */
export async function findArticlesForEvent(event, { searchArticles, maxRecords = 10, timespan = "72h" }) {
  const query = buildEventQuery(event);
  const raw = await searchArticles({ query, timespan, maxRecords });
  const normalized = raw.map(normalizeArticle).filter(Boolean);

  const since = event.occurredAt ? new Date(event.occurredAt).getTime() - 24 * 3600 * 1000 : null;
  const inWindow =
    since && Number.isFinite(since)
      ? normalized.filter((a) => !a.publishedAt || new Date(a.publishedAt).getTime() >= since)
      : normalized;

  return dedupeArticles(inWindow);
}

/** Significant, lower-cased words of a cleaned place ("Kokopo Papua New Guinea" -> kokopo, papua, guinea). */
export function placeTokens(locationText) {
  const place = cleanLocationText(locationText).toLowerCase();
  return [...new Set(place.split(" ").filter((w) => w.length >= 3 && !PLACE_STOPWORDS.has(w)))];
}

export const MAX_EVENT_QUERIES = 3;
export const MAX_PLACES_PER_QUERY = 12;

/**
 * Folds the ranked top events into at most `maxQueries` provider-neutral
 * searches: one per hazard type (types ordered by their best-ranked event),
 * each carrying the events' cleaned places. Events of a type that did not
 * make the cut, or without a usable place, are left out of the plan (the
 * general search can still link them).
 *
 *   -> [{ type, terms: string[], places: string[], events: [...] }]
 */
export function buildSearchPlan(events, { maxQueries = MAX_EVENT_QUERIES, maxPlaces = MAX_PLACES_PER_QUERY } = {}) {
  const groups = new Map();
  for (const ev of events) {
    if (!HAZARD_TERMS[ev.type]) continue;
    const place = cleanLocationText(ev.locationText);
    if (!place) continue;
    if (!groups.has(ev.type)) groups.set(ev.type, { type: ev.type, terms: HAZARD_TERMS[ev.type], places: [], events: [] });
    const g = groups.get(ev.type);
    if (g.places.length >= maxPlaces) continue;
    if (!g.places.includes(place)) g.places.push(place);
    g.events.push({ ...ev, place });
  }
  return [...groups.values()].slice(0, maxQueries);
}

/** Path segments that name a section, format or date rather than the story. */
const SECTION_SEGMENT =
  /^(world|news|uk|us|australia|environment|commentisfree|business|politics|sport|culture|lifeandstyle|film|music|society|science|technology|money|travel|global-development|cities|video|gallery|interactive|ng-interactive|live|liveblog|blog|article|articles|story|stories|[a-z]+-news|\d+|[a-z]{3})$/i;
const SLUG_NOISE = new Set(["live", "news", "blog", "liveblog", "updates", "latest"]);

/**
 * Words of the story slug (the last path segment) with section names,
 * dates, ids and format markers removed, including words that merely repeat
 * an earlier path segment ("/australia-news/live/.../australia-news-live-…"
 * keeps only the story words). Used so an article is linked to a place by
 * its headline or its real slug, never by the section it was filed under.
 */
export function slugWords(url) {
  let segments;
  try {
    segments = decodeURIComponent(new URL(url).pathname).split("/").filter(Boolean);
  } catch {
    return [];
  }
  if (segments.length === 0) return [];
  const slug = segments[segments.length - 1].replace(/\.[a-z0-9]{2,5}$/i, "");
  if (segments.length > 1 && SECTION_SEGMENT.test(slug)) return [];
  const sectionWords = new Set();
  for (const seg of segments.slice(0, -1)) for (const w of seg.toLowerCase().split(/[-_]+/)) sectionWords.add(w);
  return slug
    .toLowerCase()
    .split(/[-_+.]+/)
    .filter((w) => w && !/^\d+$/.test(w) && !SLUG_NOISE.has(w) && !sectionWords.has(w));
}

function searchableText(article) {
  return `${article.title ?? ""} ${slugWords(article.url).join(" ")}`.toLowerCase();
}

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whole-word match: "quake" is found in "hokkaido quake" but not in "earthquakes". */
function containsWord(text, word) {
  let from = 0;
  for (;;) {
    const i = text.indexOf(word, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + word.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

function mentionsHazard(text, type) {
  return (HAZARD_TERMS[type] ?? []).some((t) => containsWord(text, t));
}

/**
 * Assigns articles to events. An article is linked to the event whose place
 * words it mentions most (title + URL path); ties go to the better-ranked
 * event. With `requireHazard` the article must also mention one of the
 * event type's hazard words (used for the general search, whose results
 * were not filtered by hazard type per event). When no place matches and the
 * candidate list holds exactly one event, the article is linked to it when
 * `single` is set: a one-event query only returned it because that event's
 * place matched in the article body.
 *
 *   -> [{ ...article, event: <event | null> }]
 */
export function linkArticlesToEvents(articles, events, { requireHazard = false, single = false } = {}) {
  const candidates = events.map((ev) => ({ ev, tokens: placeTokens(ev.locationText ?? ev.place), phrase: cleanLocationText(ev.locationText ?? ev.place).toLowerCase() }));
  return articles.map((article) => {
    const text = searchableText(article);
    let best = null;
    let bestScore = 0;
    for (const c of candidates) {
      if (requireHazard && !mentionsHazard(text, c.ev.type)) continue;
      let score = c.tokens.filter((t) => containsWord(text, t)).length;
      if (score && c.phrase && text.includes(c.phrase)) score += 1;
      if (score > bestScore) {
        best = c.ev;
        bestScore = score;
      }
    }
    if (!best && single && candidates.length === 1 && (!requireHazard || mentionsHazard(text, candidates[0].ev.type))) {
      best = candidates[0].ev;
    }
    return { ...article, event: best };
  });
}
