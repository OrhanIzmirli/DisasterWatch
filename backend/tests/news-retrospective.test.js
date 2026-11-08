/**
 * Side stories about past disasters, and Turkish place names whose apostrophe
 * GDELT drops. Every headline here is invented.
 */
import { describe, it, expect, vi } from "vitest";
import { isDisasterNews } from "../src/services/newsRelevance.js";
import { isDisasterNewsIn } from "../src/services/newsLanguages.js";
import { headlineCountry } from "../src/services/newsLocation.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

const NOW = new Date("2026-11-08T10:00:00Z");
const check = (title, opts) => isDisasterNews({ title, url: "https://example.com/world/1", language: "en" }, { now: NOW, ...opts });
const tr = (title) => headlineCountry({ title, provider: "gdelt", language: "tr" });

describe("retrospectives, English", () => {
  it.each([
    "Exampleton marks anniversary of the great earthquake",
    "Five years after the tsunami, a town starts over",
    "School rebuilt after the earthquake opens its doors",
    "Library built after the flood wins an award",
  ])("dropped: %s", (title) => expect(check(title).keep).toBe(false));

  it.each([
    "New quake strikes Exampleton three years after the last one",
    "Another earthquake hits on the anniversary of the disaster",
    "Earthquake strikes Exampleland, years after the 2020 flood",
    "Shelters set up after earthquake in Exampleton",
  ])("kept, a new event: %s", (title) => expect(check(title).keep).toBe(true));

  it("keeps a look back when the article is linked to a current event", () => {
    const title = "Exampleton earthquake comes five years after the last disaster";
    expect(check(title).keep).toBe(false);
    expect(check(title, { linked: true }).keep).toBe(true);
    expect(check("The 2019 earthquake returned to Exampleton", { linked: true }).keep).toBe(true);
  });
});

describe("retrospectives, other languages", () => {
  it.each([
    ["tr", "Örnekilde deprem sonrası kurulan atık su tesisi açıldı"],
    ["tr", "Örnek depremlerini yaşayan iki kadın gönüllü oldu"],
    ["tr", "Büyük depremin yıl dönümünde anma töreni"],
    ["tr", "Depremin üzerinden üç yıl geçti"],
    ["es", "Aniversario del terremoto de Ejemplo"],
    ["es", "Cinco años después del huracán, la ciudad renace"],
    ["fr", "Trois ans après le séisme, une association revient à Exemple"],
    ["de", "Jahrestag des Erdbebens in Beispielstadt"],
    ["pt", "Dez anos depois do terremoto, a vila recomeça"],
  ])("%s dropped: %s", (lang, title) => expect(isDisasterNewsIn(lang, title).keep).toBe(false));

  it.each([
    ["tr", "Örnekilde yeni deprem: üç yıl sonra aynı korku"],
    ["tr", "Son dakika: yıl dönümünde deprem"],
    ["tr", "Deprem sonrası yapılan ilk açıklama"], // today's statement, not a side story
    ["es", "Nuevo sismo a cinco años del terremoto de Ejemplo"],
    ["fr", "Nouveau séisme trois ans après la catastrophe"],
    ["de", "Erneut Erdbeben, zwei Jahre nach der Katastrophe"],
    ["pt", "Novo terremoto dez anos depois da tragédia"],
  ])("%s kept: %s", (lang, title) => expect(isDisasterNewsIn(lang, title).keep).toBe(true));

  it("keeps a look back when the article is linked to a current event", () => {
    const title = "Örnekilde deprem sonrası kurulan çadır kent doldu";
    expect(isDisasterNewsIn("tr", title).keep).toBe(false);
    expect(isDisasterNewsIn("tr", title, { linked: true }).keep).toBe(true);
    const year = { title: "Örnekilde deprem 2023 felaketini hatırlattı", url: "https://example.com/dunya/1", language: "tr" };
    expect(isDisasterNews(year, { now: NOW }).keep).toBe(false);
    expect(isDisasterNews(year, { now: NOW, linked: true }).keep).toBe(true);
  });
});

describe("the service links before it judges", () => {
  const T0 = new Date("2026-11-08T09:00:00Z");
  const quiet = { log() {}, warn() {}, error() {} };
  const events = [{ id: 1, type: "earthquake", severity: "high", timeMinutesAgo: 60, location: "M 6.4 - near Exampleton, Japan", lat: 35, lng: 139, country: "Japan", details: { cleanTitle: "M 6.4 - near Exampleton, Japan", occurredAt: "2026-11-08T07:00:00.000Z" } }];
  const art = (title, url, provider = "gdelt") => ({ title, url, domain: "example.com", publishedAt: "2026-11-08T08:00:00.000Z", image: null, provider, language: "en", sourceCountry: null });
  const provider = (articles) => ({ name: "gdelt", label: "GDELT", refreshIntervalMs: 900000, retentionMs: null, maxGroupSearches: 0, searchGroup: vi.fn(async () => []), searchGeneral: vi.fn(async () => articles) });

  it("keeps a look back about a current event and drops an unrelated one", async () => {
    const svc = createNewsService({
      providers: [provider([art("Exampleton earthquake comes five years after the last disaster", "https://example.com/world/1"), art("Five years after the earthquake, Otherville recovers", "https://example.com/world/2")])],
      store: createMemoryNewsStore(),
      loadEvents: async () => events,
      now: () => T0,
      log: quiet,
    });
    await svc.refresh();
    expect(svc.getNews().items.map((a) => a.url)).toEqual(["https://example.com/world/1"]);
  });

  it("a cached look back is judged by its link, and GDACS lists do not count as one", async () => {
    const store = createMemoryNewsStore();
    const relatedEvent = { id: 1, type: "earthquake", severity: "high", location: "Exampleton", lat: 35, lng: 139, country: "Japan" };
    const title = "Exampleton earthquake comes five years after the last disaster";
    await store.save(
      [
        { ...art(title, "https://example.com/world/1"), relatedEvent, location: null, expiresAt: null, fetchedAt: T0.toISOString() },
        { ...art("Anniversary of the Otherville flood", "https://example.com/world/2", "gdacs"), relatedEvent, location: null, expiresAt: null, fetchedAt: T0.toISOString() },
      ],
      T0
    );
    const svc = createNewsService({ providers: [], store, loadEvents: async () => [], now: () => T0, log: quiet });
    await svc.restore();
    expect(svc.getNews().items.map((a) => a.url)).toEqual(["https://example.com/world/1"]);
  });
});

describe("Turkish place names without the apostrophe", () => {
  it.each([
    ["Japonyada deprem: hasar var", "JP"],
    ["Endonezyadan yardım çağrısı sel nedeniyle", "ID"],
    ["Orman yangını Türkiyeye sıçradı", "TR"],
    ["Japonyanın kuzeyinde deprem", "JP"],
    ["Japonyadaki depremde yaralılar var", "JP"],
    ["Japonyaya tsunami uyarısı", "JP"],
    ["TÜRKİYEDE ORMAN YANGINI", "TR"],
    ["Irakta sel felaketi", "IQ"],
    ["Hindistanda sel baskını", "IN"],
    ["Kanadadan orman yangını haberi", "CA"],
    ["Norveçte heyelan", "NO"],
    ["Ürdünde sel felaketi", "JO"],
    ["Güney Korede deprem", "KR"],
    ["Malatyada deprem korkusu", "TR"],
    ["Hatayda deprem oldu", "TR"],
    ["Diyarbakırda sel baskını", "TR"],
    ["ABDde kasırga", "US"],
    ["ABD'de kasırga", "US"],
    ["ABDye kasırga uyarısı", "US"],
    ["Nijeryada sel felaketi", "NG"], // not Niger
    ["Romanyanın kuzeyinde sel felaketi", "RO"],
    ["Japonya'da deprem", "JP"], // the apostrophe still works
  ])("%s -> %s", (title, code) => expect(tr(title)).toBe(code));

  it.each([
    "Cadde sular altında kaldı, sel felaketi",
    "Malide deprem",
    "Mali'de deprem",
    "Deprem bölgesine mali yardım",
    "Sabah saatlerinde deprem oldu",
    "Sabahtan beri orman yangını sürüyor",
    "Yardım teklifi kabul edildi, deprem bölgesi",
    "Türkiyeden Japonyaya deprem yardımı", // two countries
  ])("no country: %s", (title) => expect(tr(title)).toBeNull());
});
