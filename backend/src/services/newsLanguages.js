/**
 * News languages beyond English (docs/news.md, "Languages").
 *
 * GDELT is asked for articles in the languages below; each article keeps its
 * language and the country of its publisher. The English relevance rules
 * (newsRelevance.js: sections, idioms, weak terms with impact context, ...) do
 * not carry over to other languages, so a non-English article passes a
 * stricter rule instead: its headline must name a STRONG hazard term of its
 * own language. Weak words (storm, flood alone) never count there, which
 * keeps figures of speech out at the price of some real reports.
 *
 * Turkish and German build words by suffixes and compounds ("depremde",
 * "Waldbrandgefahr"), so their terms match the start of a word; Spanish,
 * French and Portuguese terms match whole words, plurals listed.
 */

/** GDELT `language` value -> ISO 639-1 code, for the languages DisasterWatch reads. */
export const NEWS_LANGUAGES = {
  english: "en",
  turkish: "tr",
  spanish: "es",
  french: "fr",
  german: "de",
  portuguese: "pt",
};

export const LANGUAGE_NAMES = { en: "English", tr: "Turkish", es: "Spanish", fr: "French", de: "German", pt: "Portuguese" };

/** GDELT query part: (sourcelang:english OR sourcelang:turkish OR ...) */
export const GDELT_LANGUAGE_FILTER = `(${Object.keys(NEWS_LANGUAGES)
  .map((l) => `sourcelang:${l}`)
  .join(" OR ")})`;

/** A GDELT language name ("Turkish") or code ("tr") -> code, or null when DisasterWatch does not read it. */
export function languageCode(value) {
  const v = String(value ?? "").trim().toLowerCase();
  if (!v) return null;
  if (NEWS_LANGUAGES[v]) return NEWS_LANGUAGES[v];
  return Object.values(NEWS_LANGUAGES).includes(v) ? v : null;
}

const STEM = "stem"; // matches the start of a word
const WORD = "word"; // matches a whole word or phrase

/** Strong hazard terms per language (lower case). */
export const STRONG_TERMS = {
  tr: {
    mode: STEM,
    terms: ["deprem", "artçı sarsıntı", "tsunami", "orman yangın", "kasırga", "tayfun", "siklon", "tropik fırtına", "tropikal fırtına", "sel felaket", "sel bask", "su bask", "taşkın", "heyelan", "yanardağ", "volkan", "doğal afet"],
  },
  de: {
    mode: STEM,
    terms: ["erdbeben", "nachbeben", "tsunami", "waldbr", "buschfeuer", "flächenbrand", "hurrikan", "taifun", "zyklon", "tropensturm", "überschwemmung", "hochwasser", "sturzflut", "erdrutsch", "vulkanausbruch", "naturkatastroph"],
  },
  es: {
    mode: WORD,
    terms: [
      "terremoto", "terremotos", "sismo", "sismos", "seísmo", "seísmos", "réplica sísmica", "maremoto", "tsunami",
      "incendio forestal", "incendios forestales", "huracán", "huracanes", "tifón", "tifones", "ciclón", "ciclones", "tormenta tropical",
      "inundación", "inundaciones", "riada", "riadas", "deslizamiento de tierra", "deslave", "erupción", "volcán", "desastre natural",
    ],
  },
  fr: {
    mode: WORD,
    terms: [
      "séisme", "séismes", "tremblement de terre", "tremblements de terre", "réplique", "tsunami",
      "incendie de forêt", "incendies de forêt", "feu de forêt", "feux de forêt", "ouragan", "ouragans", "typhon", "typhons", "cyclone", "cyclones", "tempête tropicale",
      "inondation", "inondations", "crue", "crues", "glissement de terrain", "éruption", "volcan", "catastrophe naturelle",
    ],
  },
  pt: {
    mode: WORD,
    terms: [
      "terremoto", "terremotos", "sismo", "sismos", "abalo sísmico", "tsunami",
      "incêndio florestal", "incêndios florestais", "queimada", "queimadas", "furacão", "furacões", "tufão", "ciclone", "ciclones", "tempestade tropical",
      "inundação", "inundações", "enchente", "enchentes", "deslizamento", "deslizamentos", "erupção", "vulcão", "desastre natural",
    ],
  },
};

const WORD_CHAR = /[\p{L}\p{N}]/u;

function matches(text, term, mode) {
  let from = 0;
  for (;;) {
    const i = text.indexOf(term, from);
    if (i === -1) return false;
    const before = i === 0 ? "" : text[i - 1];
    const after = text[i + term.length] ?? "";
    if (!WORD_CHAR.test(before) && (mode === STEM || !WORD_CHAR.test(after))) return true;
    from = i + 1;
  }
}

/**
 * Relevance of a headline in a language other than English.
 * -> { keep, reason }; null when the language has no rule (the article is then dropped by the caller).
 */
export function isDisasterNewsIn(language, title) {
  const rule = STRONG_TERMS[language];
  if (!rule) return null;
  const text = String(title ?? "")
    .toLocaleLowerCase(language)
    .replace(/\s+/g, " ");
  const hit = rule.terms.find((t) => matches(text, t, rule.mode));
  return hit ? { keep: true, reason: `${LANGUAGE_NAMES[language]} headline names "${hit}"` } : { keep: false, reason: `no ${LANGUAGE_NAMES[language]} hazard term in the headline` };
}
