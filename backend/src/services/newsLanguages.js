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

/**
 * Per language (lower case):
 *   terms       strong hazard terms;
 *   figurative  phrases removed before matching ("siyasi deprem", "Erdrutschsieg");
 *   context     show, election and sport words: with one of them the headline
 *               must also report what happened, or a hazard word is a title or a figure of speech;
 *   report      word starts that report impact or a disruption (always matched as word starts);
 *   retrospective  phrases of a piece that looks back at a past disaster (word starts);
 *   fresh       phrases that report a new event, which outweigh a look back (word starts).
 */
export const STRONG_TERMS = {
  tr: {
    mode: STEM,
    terms: ["deprem", "artçı sarsıntı", "tsunami", "orman yangın", "kasırga", "tayfun", "siklon", "tropik fırtına", "tropikal fırtına", "sel felaket", "sel bask", "su bask", "taşkın", "heyelan", "yanardağ", "volkan", "doğal afet"],
    figurative: ["siyasi deprem", "siyasette deprem", "seçim deprem", "transfer deprem", "deprem etkisi", "deprem gibi", "tsunami gibi", "siyasi kasırga", "kasırga gibi"],
    context: ["film", "netflix", "dizi", "tiyatro", "konser", "belgesel", "seçim", "futbol", "maç", "lig", "transfer", "şampiyon"],
    report: ["ölü", "öldü", "yaralı", "hasar", "tahliye", "kayıp", "iptal", "ertelen", "yıkıl", "can kayb"],
    retrospective: ["yıl dönüm", "yıldönüm", "yıl sonra", "yıl önce", "yıl geçti", "yıl oldu", "sonrası kurul", "sonrası inşa", "ardından kurul", "anma tören", "anıldı", "anısına", "unutul", "unutma", "depremi yaşa", "depremini yaşa", "depremlerini yaşa"],
    fresh: ["yeni deprem", "yeni sel", "son dakika", "bugün", "az önce", "bu sabah", "bu gece", "meydana geldi"],
  },
  de: {
    mode: STEM,
    terms: ["erdbeben", "nachbeben", "tsunami", "waldbr", "buschfeuer", "flächenbrand", "hurrikan", "taifun", "zyklon", "tropensturm", "überschwemmung", "hochwasser", "sturzflut", "erdrutsch", "vulkanausbruch", "naturkatastroph"],
    figurative: ["politisches erdbeben", "politische erdbeben", "erdrutschsieg", "erdrutschartig", "wie ein erdbeben", "wie ein tsunami", "wie ein hurrikan"],
    context: ["film", "netflix", "theater", "konzert", "dokumentation", "wahl", "bundesliga", "fußball", "liga"],
    report: ["tote", "verletz", "schäden", "schaden", "evakuier", "vermisst", "opfer", "abgesagt", "verschoben", "zerstör"],
    retrospective: ["jahrestag", "jahre nach", "jahre später", "gedenk", "erinnerung an"],
    fresh: ["neues erdbeben", "neue erdbeben", "erneut", "heute", "aktuell"],
  },
  es: {
    mode: WORD,
    terms: [
      "terremoto", "terremotos", "sismo", "sismos", "seísmo", "seísmos", "réplica sísmica", "maremoto", "tsunami",
      "incendio forestal", "incendios forestales", "huracán", "huracanes", "tifón", "tifones", "ciclón", "ciclones", "tormenta tropical",
      "inundación", "inundaciones", "riada", "riadas", "deslizamiento de tierra", "deslave", "erupción", "volcán", "desastre natural",
    ],
    figurative: ["terremoto político", "terremoto electoral", "terremoto financiero", "tsunami político", "tsunami electoral", "tsunami de votos", "tsunami de críticas", "como un terremoto", "como un huracán", "erupción cutánea", "erupciones cutáneas"],
    context: ["película", "películas", "netflix", "teatro", "concierto", "conciertos", "documental", "novela", "elecciones", "electoral", "candidato", "candidata", "votos", "fútbol", "liga", "gol", "goles"],
    report: ["muert", "herid", "daño", "evacu", "desaparecid", "víctima", "damnificad", "cancel", "suspend", "aplaz", "destru"],
    retrospective: ["aniversario", "años después", "años del terremoto", "años del sismo", "años del huracán", "años desde", "años tras", "conmemor", "a un año", "a dos años", "a tres años", "a cinco años", "a diez años"],
    fresh: ["nuevo sismo", "nuevo terremoto", "nueva réplica", "hoy", "última hora"],
  },
  fr: {
    mode: WORD,
    terms: [
      "séisme", "séismes", "tremblement de terre", "tremblements de terre", "réplique", "tsunami",
      "incendie de forêt", "incendies de forêt", "feu de forêt", "feux de forêt", "ouragan", "ouragans", "typhon", "typhons", "cyclone", "cyclones", "tempête tropicale",
      "inondation", "inondations", "crue", "crues", "glissement de terrain", "éruption", "volcan", "catastrophe naturelle",
    ],
    figurative: ["séisme politique", "séisme électoral", "tsunami politique", "tsunami électoral", "comme un séisme", "comme un ouragan", "éruption cutanée", "éruptions cutanées"],
    context: ["film", "films", "netflix", "théâtre", "concert", "concerts", "documentaire", "roman", "attraction", "élections", "électoral", "électorale", "candidat", "candidate", "football", "ligue", "championnat", "match"],
    report: ["mort", "bless", "dégât", "évacu", "disparu", "victime", "sinistré", "annul", "reporté", "suspend", "détrui"],
    retrospective: ["anniversaire", "ans après", "an après", "commémor"],
    fresh: ["nouveau séisme", "aujourd'hui", "ce matin", "dernière minute"],
  },
  pt: {
    mode: WORD,
    terms: [
      "terremoto", "terremotos", "sismo", "sismos", "abalo sísmico", "tsunami",
      "incêndio florestal", "incêndios florestais", "queimada", "queimadas", "furacão", "furacões", "tufão", "ciclone", "ciclones", "tempestade tropical",
      "inundação", "inundações", "enchente", "enchentes", "deslizamento", "deslizamentos", "erupção", "vulcão", "desastre natural",
    ],
    figurative: ["terremoto político", "terremoto eleitoral", "tsunami político", "tsunami eleitoral", "como um terremoto", "como um furacão", "erupção cutânea", "erupções cutâneas"],
    context: ["filme", "filmes", "netflix", "teatro", "concerto", "concertos", "documentário", "novela", "eleições", "eleitoral", "candidato", "candidata", "votos", "futebol", "campeonato", "jogo"],
    report: ["mort", "ferid", "dano", "evacu", "desaparecid", "vítima", "desabrigad", "desalojad", "cancel", "suspens", "adiad", "destru"],
    retrospective: ["aniversário", "anos depois", "anos após", "anos do terremoto", "anos da tragédia", "relembr"],
    fresh: ["novo terremoto", "novo sismo", "hoje", "última hora"],
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

const lowered = (language, title) => String(title ?? "").toLocaleLowerCase(language).replace(/\s+/g, " ");

/** Does the headline report a new event ("yeni deprem", "hoy")? False for a language without rules. */
export function reportsNewEventIn(language, title) {
  const rule = STRONG_TERMS[language];
  if (!rule) return false;
  const text = lowered(language, title);
  return rule.fresh.some((t) => matches(text, t, STEM));
}

/**
 * Relevance of a headline in a language other than English.
 * A piece that looks back at a past disaster is dropped unless it reports a
 * new event or `linked` says it is tied to a current feed event.
 * -> { keep, reason }; null when the language has no rule (the article is then dropped by the caller).
 */
export function isDisasterNewsIn(language, title, { linked = false } = {}) {
  const rule = STRONG_TERMS[language];
  if (!rule) return null;
  let text = lowered(language, title);
  for (const phrase of rule.figurative) text = text.split(phrase).join(" ");
  const hit = rule.terms.find((t) => matches(text, t, rule.mode));
  if (!hit) return { keep: false, reason: `no ${LANGUAGE_NAMES[language]} hazard term in the headline` };
  const show = rule.context.find((t) => matches(text, t, rule.mode));
  if (show && !rule.report.some((t) => matches(text, t, STEM))) return { keep: false, marker: true, reason: `show, election or sport ("${show}", no impact in the headline)` };
  const past = rule.retrospective.find((t) => matches(text, t, STEM));
  if (past && !linked && !reportsNewEventIn(language, title)) return { keep: false, marker: true, reason: `retrospective ("${past}")` };
  return { keep: true, reason: `${LANGUAGE_NAMES[language]} headline names "${hit}"` };
}
