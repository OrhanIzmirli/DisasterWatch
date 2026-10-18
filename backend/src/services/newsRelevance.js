/**
 * Is this article disaster/hazard news? Applied to EVERY article from every
 * provider (group and general searches) before it reaches the cache.
 *
 * Conservative by design: dropping a borderline article is preferred to
 * showing an irrelevant one. The check reads the headline, the standfirst
 * when the provider sends one (The Guardian; never cached), and the URL path
 * (section). Rules, in order:
 *
 *  1. Non-news sections and formats are dropped (sport, business,
 *     technology, culture, opinion, lifestyle, interactives, ...): a hazard
 *     word there is almost always a metaphor, a review or a feature.
 *     Headlines of reviews, listings and features ("documentary",
 *     "screened tonight", "review", "ballad", ...) are dropped as well, and so
 *     are sports listings ("vs.", "live stream", "how to watch"), product
 *     announcements ("tracker", "launches an app") and retrospectives set
 *     after a past storm ("years after", "anniversary", "... after Hurricane
 *     Helene" with no impact word in the headline). Historical pieces (a past
 *     4-digit year, "N years ago", "World Series") and sports-team uses of a
 *     hazard word (a league or sport word and no impact word) go too. When
 *     the caller passes the current storms (`storms`: names of storms in
 *     the feed or closed in the last 14 days), a headline that names only
 *     other storms ("... Hurricane Melissa claims") is a retrospective too.
 *  2. Idioms and names are removed from the text before matching
 *     ("perfect storm", "storm of criticism", "flood of", "spread like
 *     wildfire", "political earthquake", "Carolina Hurricanes", ...).
 *  3. A STRONG hazard term in the headline keeps the article
 *     (earthquake, tsunami, wildfire, bushfire, hurricane, typhoon,
 *     cyclone, tornado, landslide, flooding, eruption, ...).
 *  4. A WEAK term (storm, flood, tremor, deluge, heavy rain, ...) in the headline
 *     keeps it only together with an impact or weather word in the headline
 *     or standfirst (killed, dead, evacuated, homes, damage, rain, winds,
 *     landfall, warning, magnitude, ...).
 *  5. A STRONG term only in the standfirst keeps it only when the headline
 *     carries an impact word ("Thousands flee as river rises" + "Flash
 *     flood warnings issued").
 *  Anything else is dropped.
 *
 *   isDisasterNews(article) -> { keep: boolean, reason: string }
 */

/** URL path segments of sections / formats that are not disaster reporting. */
const EXCLUDED_SECTIONS = new Set([
  "sport", "sports", "football", "soccer", "cricket", "tennis", "rugby", "rugby-union", "rugby-league", "golf", "formulaone", "f1", "nba", "nfl", "nhl", "mlb", "wnba",
  "business", "money", "markets", "finance", "technology", "tech",
  "culture", "film", "films", "movies", "music", "books", "tv-and-radio", "tv", "stage", "artanddesign", "games", "gaming", "entertainment", "celebrity", "arts",
  "life", "lifeandstyle", "lifestyle", "fashion", "food", "travel", "wellness",
  "commentisfree", "opinion", "opinions", "editorial", "letters", "obituaries",
  "crosswords", "puzzles", "ng-interactive", "interactive", "gallery", "video", "podcasts", "live", "liveblog",
]);

/** Removed before matching: figures of speech and names that contain a hazard word. */
const IDIOMS = [
  /\bperfect storm\b/g,
  /\bstorms? of (criticism|protest|protests|controversy|outrage|anger|abuse|tweets|posts|applause|questions|complaints)\b/g,
  /\b(fire|brain|media|political|social[- ]media|twitter|shit)storms?\b/g,
  /\bweather(ed|ing|s)? (the|a|this) storm\b/g,
  /\bby storm\b/g,
  /\bstorm in a (tea ?cup|teapot)\b/g,
  /\bstorm(s|ed|ing)? (out|off|the|into|onto|to (power|victory|the top))\b/g,
  /\bdesert storm\b/g,
  /\bstormzy\b/g,
  /\b(political|electoral|seismic shift|youth) ?quakes?\b/g,
  /\b(political|electoral|financial|market|diplomatic|cultural) earthquakes?\b/g,
  /\bfloods? of (applications|money|cash|investment|imports|complaints|tears|calls|emails|refugees|migrants|orders|bids|content|requests|interest)\b/g,
  /\bfloodgates\b/g,
  /\bflooded (with|by) (calls|messages|complaints|applications|orders|requests|offers)\b/g,
  /\bflood(ing|ed)? the (market|zone)\b/g,
  /\b(spread|spreading|spreads) like wildfire\b/g,
  /\blike (a )?wildfire\b/g,
  /\b(carolina|miami) hurricanes\b/g,
  /\bseattle storm\b/g,
  /\b(iowa state )?cyclones (beat|win|lose|fall|rally)\b/g,
  /\b(eurofighter )?typhoon (jets?|fighters?|aircraft|squadron)\b/g,
  /\beurofighter\b/g,
  /\bstorm (shadow|missiles?)\b/g,
  /\b(pretend|fake|simulated|mock|virtual|staged) (earthquakes?|quakes?|tsunamis?|hurricanes?|typhoons?|cyclones?|tornado(es)?|floods?|storms?|wildfires?)\b/g,
];

/** Unambiguous hazard terms. */
const STRONG = [
  "earthquake", "earthquakes", "quake", "quakes", "aftershock", "aftershocks", "tsunami", "tsunamis",
  "wildfire", "wildfires", "bushfire", "bushfires", "forest fire", "forest fires", "brush fire", "brush fires", "brushfire", "brushfires", "grassfire", "grassfires",
  "hurricane", "hurricanes", "cyclone", "cyclones", "typhoon", "typhoons", "super typhoon", "tropical storm", "tropical storms", "tornado", "tornadoes", "landfall",
  "flooding", "floods", "flash flood", "flash floods", "floodwater", "floodwaters",
  "flood watch", "flood warning", "flood warnings", "storm warning", "storm warnings", "storm watch", "storm surge", "severe storm", "severe storms",
  "landslide", "landslides", "mudslide", "mudslides",
  "volcano", "volcanoes", "volcanic eruption", "eruption", "erupts", "erupted",
  "natural disaster", "natural disasters",
];

/** Hazard words that are also everyday words: need impact context. */
// Plain "fire"/"blaze" and "evacuation" are deliberately absent: a building fire or a gas-leak evacuation is not hazard news.
const WEAK = ["storm", "storms", "flood", "flooded", "tremor", "tremors", "deluge", "inundated", "monsoon", "heavy rain", "torrential rain"];

/** Impact / weather context that turns a weak term into hazard news. */
const IMPACT = [
  "kill", "kills", "killed", "killing", "dead", "death", "deaths", "die", "dies", "died", "toll", "missing", "injured", "injuries", "casualties", "victims", "survivors", "bodies",
  "evacuate", "evacuated", "evacuation", "evacuations", "evacuees", "flee", "flees", "fled", "rescue", "rescued", "rescuers", "stranded", "trapped", "displaced", "homeless",
  "homes", "houses", "buildings", "destroyed", "destroys", "razes", "razed", "damage", "damaged", "damages", "devastated", "devastation", "collapsed", "swept away", "submerged",
  "power cut", "power cuts", "outage", "outages", "blackout", "blackouts",
  "rain", "rains", "rainfall", "winds", "wind", "gusts", "landfall", "surge", "storm surge", "warning", "warnings", "alert", "alerts", "red alert", "magnitude", "epicentre", "epicenter",
  "emergency", "state of emergency", "relief", "aid", "disaster", "hectares", "acres", "firefighters", "batters", "battered", "lashes", "lashed", "pounds", "pounded",
];

/** Headline words of reviews, listings and features: a hazard word there is usually a title, not news. */
const FEATURE_MARKERS = /\b(documentary|review|reviewed|screened|screening|premiere|episode|box set|tv tonight|what to watch|album|song|songs|ballad|singing|rap|rapper|unreleased|lyrics|novel|exhibition|podcast|recipe|quiz|crossword|obituary|dark tourism)\b/;

/** Sports fixtures and listings ("Hurricanes vs. Jets Time, TV & Live Stream"). */
const SPORTS_MARKERS = /\b(vs|versus|live ?stream(ing)?|how to watch|where to watch|tv channel|kick-?off time|tip-?off time|box score|final score|playoffs?)\b/;

/** Product and launch announcements ("ABC launches an updated wildfire tracker"). */
const PRODUCT_MARKERS =
  /\btrackers?\b|\b(launch|launches|launched|unveils|unveiled|rolls out|rolled out|debuts|introduces)\b(?: [\p{L}\p{N}'-]+){0,4} (app|apps|tool|tools|map|maps|dashboard|platform|feature|website|chatbot|product|sensor|sensors)\b/u;

/** Retrospectives: the headline looks back at a past disaster. */
const RETRO_MARKERS = /\b(anniversary|(years?|decades?|months?) (after|since|on from)|years on|(\d+|years|decades|centuries) ago|remember(ing|s)?|looking back|lessons (from|of)|legacy of|world series)\b/;

/** A 4-digit year in the headline; a past one marks a historical piece ("the 1989 quake", "2025 floods"). Counts ("1900 homes") are not years. */
const YEAR = /\b(1[89]\d\d|20\d\d)\b(?! ?(homes|houses|people|residents|families|buildings|hectares|acres|km|miles|feet|metres|meters|dead|killed|evacuated|firefighters|troops|visitors|tourists|students|workers|cases)\b)/;

/** League and sport words: a hazard word next to them is usually a team name ("Hurricanes", "Storm", "Cyclones"). */
const SPORT_WORDS = /\b(volleyball|football|soccer|basketball|baseball|hockey|cricket|rugby|netball|handball|league|champions league|premier league|super bowl|playoffs?|season opener|tournament|championships?)\b/;

/**
 * "... after Hurricane Helene" / "... Following Hurricane Beryl": a named storm the headline looks back on.
 * The lead-in and class words match in any casing; the name must still start with a capital in the
 * headline (checked on the match), so "after storm brings snow" is not read as a name.
 */
const AFTER_NAMED_STORM = /\b(?:after|since|following) (?:hurricane|typhoon|super typhoon|cyclone|tropical storm|storm) ([\p{L}][\p{L}'’-]*)/giu;

/**
 * Words that report a storm acting now ("batters", "makes landfall",
 * "strengthens", "warning"), right after its name: a headline with one is
 * current news even when it calls the storm by a name the storm lists do not
 * know (a local name such as PAGASA's). The past-storm rule leaves such
 * headlines alone.
 */
const CURRENT_ACTION =
  /\b(batters?|battered|battering|lash(es|ed|ing)?|pound(s|ed|ing)?|slams?|slammed|hits|strikes|landfall|nears|approach(es|ing)|heads? (for|toward|towards)|intensif(y|ies|ied|ying)|strengthens?|strengthening|weakens?|weakening|threatens?|threatening|forms?|formed|forming|upgraded|downgraded|warnings?|watch(es)?|alerts?|evacuat(e|es|ed|ing|ion|ions)|forecast|track|path|live)\b/;

/** A storm acting now: an action word within the three words after a named storm ("Super Typhoon Nando batters Luzon"). */
function stormActsNow(title) {
  const text = String(title ?? "");
  for (const m of text.matchAll(NAMED_STORM)) {
    const next = text.slice(m.index + m[0].length).toLowerCase().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
    if (CURRENT_ACTION.test(next)) return true;
  }
  return false;
}

/**
 * Title Case headlines ("Hurricane Expected To Strengthen") capitalise every
 * word, so the word after a storm class word cannot be told from a name: more
 * than half of the longer words after the first are capitalised.
 */
function isTitleCase(title) {
  const words = String(title ?? "").split(/\s+/).slice(1).filter((w) => /^\p{L}{4,}/u.test(w));
  return words.length >= 3 && words.filter((w) => /^\p{Lu}/u.test(w)).length / words.length > 0.5;
}

/**
 * "Hurricane Melissa", "Super Typhoon Champi", "Tropical Cyclone 01P": the
 * storm class word (any casing), then a capitalised name or a basin
 * designation. Words that follow a class word without being a name
 * ("Hurricane Center", "Typhoon Season", "Cyclone Hits") are not names.
 */
const NAMED_STORM = /\b(?:super typhoon|typhoon|hurricane|tropical storm|tropical cyclone|tropical depression|cyclone)\s+([\p{L}][\p{L}'’-]*|\d{1,2}[a-z])(?![\p{L}\p{N}])/giu;
/** Words after a storm class word that are not names; shared by both storm rules. */
const STORM_NAME_STOPWORDS = new Set([
  "center", "centre", "centers", "season", "seasons", "warning", "warnings", "watch", "watches", "hunter", "hunters", "relief", "recovery",
  "damage", "damages", "victims", "survivors", "strength", "category", "force", "forecast", "forecasts", "tracker", "path", "threat",
  "landfall", "alert", "alerts", "hits", "strikes", "slams", "makes", "passes", "batters", "lashes", "nears", "heads", "approaches",
  "live", "update", "updates", "insurance", "claims", "preparedness", "shelter", "shelters", "evacuation", "evacuations", "cleanup",
  "aftermath", "death", "deaths", "toll", "names", "name", "and", "the", "of", "in", "to", "as", "is", "could", "may", "will", "was", "were",
]);

/**
 * A captured word as a storm name: capitalised (or a designation such as 01P),
 * possessive dropped ("Melissa's" -> "melissa"), lower-cased; null when it is
 * not a name.
 */
function asStormName(word) {
  if (!/^(\p{Lu}|\d)/u.test(word)) return null;
  const name = word.replace(/['’]s?$/u, "").toLowerCase();
  return name && !STORM_NAME_STOPWORDS.has(name) ? name : null;
}

/** Lower-cased storm names in a title ("Hurricane Trudy, Typhoon Koguma" -> ["trudy", "koguma"]). Also used on EONET storm titles. */
export function stormNamesIn(title) {
  const names = new Set();
  for (const m of String(title ?? "").matchAll(NAMED_STORM)) {
    const name = asStormName(m[1]);
    if (name) names.add(name);
  }
  return [...names];
}

/** "melissa-hit" matches the current storm "melissa"; "choi-wan" matches "choi-wan". */
const isCurrentStorm = (name, storms) => storms.has(name) || storms.has(name.split("-")[0]);

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** Whole-word / whole-phrase match on lower-cased text. */
function has(text, term) {
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + term.length] ?? "";
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

const first = (text, terms) => terms.find((t) => has(text, t)) ?? null;

function normalise(s) {
  let t = String(s ?? "")
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/\s+/g, " ");
  for (const re of IDIOMS) t = t.replace(re, " ");
  return t;
}

/** Path segments of the article URL, lower-cased ("" segments dropped). */
function pathSegments(url) {
  try {
    return new URL(url).pathname.toLowerCase().split("/").filter(Boolean);
  } catch {
    return [];
  }
}

/** First excluded section/format in the URL path, else null. Only the leading segments name a section. */
export function excludedSection(url) {
  const segs = pathSegments(url).slice(0, 3);
  return segs.find((s) => EXCLUDED_SECTIONS.has(s)) ?? null;
}

/**
 * `marker: true` on a drop means an explicit marker decided it (section,
 * feature, sports, product, retrospective), not a missing hazard term.
 */
export function isDisasterNews(article, { now = new Date(), storms = null } = {}) {
  const section = excludedSection(article?.url);
  if (section) return { keep: false, marker: true, reason: `section "${section}"` };

  const headline = normalise(article?.title);
  const standfirst = normalise(article?.summary);

  const feature = headline.match(FEATURE_MARKERS);
  if (feature) return { keep: false, marker: true, reason: `feature/listing ("${feature[1]}")` };

  const sports = headline.match(SPORTS_MARKERS);
  if (sports) return { keep: false, marker: true, reason: `sports listing ("${sports[1]}")` };

  const product = headline.match(PRODUCT_MARKERS);
  if (product) return { keep: false, marker: true, reason: `product announcement ("${product[0]}")` };

  const retro = headline.match(RETRO_MARKERS);
  if (retro) return { keep: false, marker: true, reason: `retrospective ("${retro[1]}")` };

  const year = headline.match(YEAR);
  if (year && Number(year[1]) < now.getUTCFullYear()) return { keep: false, marker: true, reason: `historical ("${year[1]}")` };

  const sport = headline.match(SPORT_WORDS);
  if (sport && !first(headline, IMPACT)) return { keep: false, marker: true, reason: `sports ("${sport[1]}", no impact in the headline)` };

  // every "after/since/following <class> X" counts, not just the first ("after storm hits, a year after Hurricane Helene")
  for (const after of String(article?.title ?? "").matchAll(AFTER_NAMED_STORM)) {
    if (!asStormName(after[1])) continue;
    const rest = normalise(String(article.title).replace(after[0], " "));
    if (!first(rest, IMPACT) && !first(rest, STRONG)) return { keep: false, marker: true, reason: `retrospective ("${after[0].toLowerCase()}", no impact in the headline)` };
  }

  // Named storms only, none of them current (in the feed or closed in the last 14 days): a retrospective.
  // Without the storm list (EONET unreachable) the rule is skipped rather than guessed.
  // Skipped for headlines that report the storm acting now, and for Title Case headlines (names unreliable there).
  if (storms && !stormActsNow(article?.title) && !isTitleCase(article?.title)) {
    const named = stormNamesIn(article?.title);
    if (named.length && !named.some((n) => isCurrentStorm(n, storms))) {
      return { keep: false, marker: true, reason: `retrospective (storm "${named.join('", "')}" not active or recently closed)` };
    }
  }

  const strongHead = first(headline, STRONG);
  if (strongHead) return { keep: true, reason: `headline names "${strongHead}"` };

  const weakHead = first(headline, WEAK);
  if (weakHead) {
    // the weak phrase itself never counts as its own context ("heavy rain" is not impact for "heavy rain")
    const without = (text) => text.split(weakHead).join(" ");
    const impact = first(without(headline), IMPACT) ?? first(without(standfirst), IMPACT);
    if (impact) return { keep: true, reason: `headline "${weakHead}" with impact "${impact}"` };
    const strongStand = first(standfirst, STRONG);
    if (strongStand) return { keep: true, reason: `headline "${weakHead}", standfirst names "${strongStand}"` };
    return { keep: false, reason: `"${weakHead}" without disaster context` };
  }

  const strongStand = first(standfirst, STRONG);
  if (strongStand) {
    const impact = first(headline, IMPACT);
    if (impact) return { keep: true, reason: `standfirst names "${strongStand}", headline impact "${impact}"` };
    return { keep: false, reason: `hazard "${strongStand}" only in the standfirst` };
  }

  return { keep: false, reason: "no hazard term in the headline" };
}
