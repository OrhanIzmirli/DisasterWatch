/**
 * News in other languages (src/services/newsLanguages.js) and the language
 * and country filters of GET /news. Every headline here is invented.
 */
import { describe, it, expect, vi } from "vitest";
import request from "supertest";
import { createTestApp } from "./helpers.js";
import { GDELT_LANGUAGE_FILTER, isDisasterNewsIn, languageCode } from "../src/services/newsLanguages.js";
import { isDisasterNews } from "../src/services/newsRelevance.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

const NOW = new Date("2026-11-08T10:00:00Z");

describe("languages", () => {
  it("maps GDELT language names to codes", () => {
    expect(["English", "Turkish", "spanish", "tr", "Japanese", "", null].map(languageCode)).toEqual(["en", "tr", "es", "tr", null, null, null]);
    expect(GDELT_LANGUAGE_FILTER).toBe("(sourcelang:english OR sourcelang:turkish OR sourcelang:spanish OR sourcelang:french OR sourcelang:german OR sourcelang:portuguese)");
  });

  it("Turkish and German match word starts (suffixes, compounds)", () => {
    expect(isDisasterNewsIn("tr", "Örnekköy'de depremde hasar gören evler").keep).toBe(true);
    expect(isDisasterNewsIn("tr", "ÖRNEK İLİNDE ORMAN YANGINI SÜRÜYOR").keep).toBe(true);
    expect(isDisasterNewsIn("tr", "Seçim öncesi siyasi fırtına").keep).toBe(false); // a storm figure of speech: weak words never count
    expect(isDisasterNewsIn("de", "Waldbrandgefahr im Beispieltal steigt").keep).toBe(true);
    expect(isDisasterNewsIn("de", "Hochwasserlage in Beispielstadt angespannt").keep).toBe(true);
  });

  it("Spanish, French and Portuguese match whole words", () => {
    expect(isDisasterNewsIn("es", "Sismo de magnitud 6 sacude la región de Ejemplo").keep).toBe(true);
    expect(isDisasterNewsIn("es", "Inundaciones dejan miles de evacuados").keep).toBe(true);
    expect(isDisasterNewsIn("fr", "Un séisme frappe la côte d'Exemple").keep).toBe(true);
    expect(isDisasterNewsIn("fr", "Les crues menacent la vallée").keep).toBe(true);
    expect(isDisasterNewsIn("pt", "Enchentes deixam desalojados em Exemplo").keep).toBe(true);
    expect(isDisasterNewsIn("es", "Huracanazo de goles en el clásico").keep).toBe(false); // not the whole word
    expect(isDisasterNewsIn("ja", "x")).toBeNull();
  });

  it("isDisasterNews applies the stricter rule to other languages only", () => {
    expect(isDisasterNews({ title: "Deprem sonrası arama kurtarma sürüyor", url: "https://example.com/haber/1", language: "tr" }, { now: NOW }).keep).toBe(true);
    expect(isDisasterNews({ title: "2019 depreminin yıl dönümü", url: "https://example.com/haber/2", language: "tr" }, { now: NOW })).toMatchObject({ keep: false, reason: 'historical ("2019")' });
    expect(isDisasterNews({ title: "Sismo en la liga de fútbol", url: "https://example.com/deportes/x", language: "es" }, { now: NOW }).keep).toBe(true); // section "deportes" is not English: the strong word decides
    expect(isDisasterNews({ title: "Sismo", url: "https://example.com/sport/x", language: "es" }, { now: NOW })).toMatchObject({ keep: false, reason: 'section "sport"' });
    expect(isDisasterNews({ title: "地震", url: "https://example.com/x", language: "japanese" }, { now: NOW })).toMatchObject({ keep: false, reason: 'language "japanese" is not read' });
    // English (and articles without a language) keep the full English rules
    expect(isDisasterNews({ title: "Earthquake damages homes in Exampleton", url: "https://example.com/world/1" }, { now: NOW }).keep).toBe(true);
    expect(isDisasterNews({ title: "A perfect storm for the markets", url: "https://example.com/world/2", language: "en" }, { now: NOW }).keep).toBe(false);
  });
});

describe("GET /news language and country filters", () => {
  const T0 = new Date("2026-11-08T09:00:00Z");
  const art = (title, url, extra) => ({ title, url, domain: new URL(url).hostname, publishedAt: "2026-11-08T08:00:00.000Z", image: null, provider: "gdelt", ...extra });
  const provider = {
    name: "gdelt",
    label: "GDELT",
    refreshIntervalMs: 15 * 60_000,
    retentionMs: null,
    maxGroupSearches: 0,
    searchGroup: vi.fn(async () => []),
    searchGeneral: vi.fn(async () => [
      art("Earthquake damages homes in Exampleton, Japan", "https://example.com/world/1", { language: "en", sourceCountry: "United Kingdom" }),
      art("Japonya'da deprem: hasar tespit çalışmaları sürüyor", "https://example.com/dunya/2", { language: "tr", sourceCountry: "Turkey" }),
      art("Inundaciones en Ejemplo dejan evacuados", "https://example.com/mundo/3", { language: "es", sourceCountry: "Spain" }),
    ]),
  };
  const events = [{ id: 1, type: "earthquake", severity: "high", timeMinutesAgo: 60, location: "M 6.4 - near Exampleton, Japan", lat: 35, lng: 139, country: "Japan", details: { cleanTitle: "M 6.4 - near Exampleton, Japan", occurredAt: "2026-11-08T07:00:00.000Z" } }];

  it("keeps the language and publisher country, counts languages and filters by them", async () => {
    const svc = createNewsService({ providers: [provider], store: createMemoryNewsStore(), loadEvents: async () => events, now: () => T0, log: { log() {}, warn() {}, error() {} } });
    await svc.refresh();
    const all = svc.getNews();
    expect(all.items.map((a) => [a.language, a.sourceCountry])).toEqual([
      ["en", "United Kingdom"],
      ["tr", "Turkey"],
      ["es", "Spain"],
    ]);
    expect(all.languages).toEqual({ en: 1, tr: 1, es: 1 });
    expect(svc.getNews({ language: "tr" }).items.map((a) => a.url)).toEqual(["https://example.com/dunya/2"]);
    expect(svc.getNews({ language: "tr" }).languages).toEqual({ en: 1, tr: 1, es: 1 }); // counted before the language filter
    const jp = svc.getNews({ country: "JP" });
    expect(jp.items.map((a) => a.url)).toEqual(["https://example.com/world/1", "https://example.com/dunya/2"]); // linked to the event; named in Turkish
  });

  it("the route validates lang and country", async () => {
    const app = createTestApp();
    expect((await request(app).get("/news?lang=xx")).status).toBe(400);
    expect((await request(app).get("/news?country=Japan")).status).toBe(400);
    expect([200, 503]).toContain((await request(app).get("/news?lang=tr&country=jp")).status);
  });
});
