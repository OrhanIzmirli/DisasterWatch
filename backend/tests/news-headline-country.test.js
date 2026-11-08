/**
 * Placing a GDELT article by the one country its headline names
 * (src/services/newsLocation.js). Every headline here is invented.
 */
import { describe, it, expect } from "vitest";
import { headlineCountry, resolveLocation, withLocation } from "../src/services/newsLocation.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

const gdelt = (title, language = "en") => ({ title, url: "https://example.com/world/1", provider: "gdelt", language });

describe("headlineCountry", () => {
  it("reads the country name in the article's own language", () => {
    expect(headlineCountry(gdelt("Earthquake damages homes in Japan"))).toBe("JP");
    expect(headlineCountry(gdelt("Japonya'da deprem: hasar tespit ediliyor", "tr"))).toBe("JP");
    expect(headlineCountry(gdelt("TÜRKİYE'DE ORMAN YANGINI SÜRÜYOR", "tr"))).toBe("TR");
    expect(headlineCountry(gdelt("Sismo sacude el sur de México", "es"))).toBe("MX");
    expect(headlineCountry(gdelt("Un séisme frappe le Japon", "fr"))).toBe("JP");
    expect(headlineCountry(gdelt("Waldbrand in der Türkei breitet sich aus", "de"))).toBe("TR");
    expect(headlineCountry(gdelt("Terremoto atinge o Japão", "pt"))).toBe("JP");
  });

  it("knows unambiguous cities, US states and English aliases", () => {
    expect(headlineCountry(gdelt("Flooding cuts roads around Kathmandu"))).toBe("NP");
    expect(headlineCountry(gdelt("Wildfire forces evacuations in California"))).toBe("US");
    expect(headlineCountry(gdelt("Floods in New Jersey close schools"))).toBe("US");
    expect(headlineCountry(gdelt("Typhoon nears Hong Kong"))).toBe("HK");
    expect(headlineCountry(gdelt("Istanbul quake felt across Turkey"))).toBe("TR"); // a city and its own country are one place
  });

  it("leaves a headline naming two countries unlocated", () => {
    expect(headlineCountry(gdelt("Japan sends rescuers to Peru after earthquake"))).toBeNull();
    expect(headlineCountry(gdelt("Istanbul team flies to Nepal after quake"))).toBeNull();
  });

  it("takes the longest name and whole words only", () => {
    expect(headlineCountry(gdelt("Earthquake shakes Papua New Guinea"))).toBe("PG"); // not also Guinea
    expect(headlineCountry(gdelt("Floods in South Sudan displace thousands"))).toBe("SS"); // not also Sudan
    expect(headlineCountry(gdelt("Floods reach northern Romania"))).toBe("RO"); // not Oman
  });

  it("does not read places that only contain a country, or misleading words", () => {
    expect(headlineCountry(gdelt("Hurricane strengthens in the Gulf of Mexico"))).toBeNull();
    expect(headlineCountry(gdelt("Huracán avanza por el golfo de México", "es"))).toBeNull();
    expect(headlineCountry(gdelt("Typhoon crosses the South China Sea"))).toBeNull();
    expect(headlineCountry(gdelt("Earthquake in the Indian Ocean"))).toBeNull(); // demonyms never place
    expect(headlineCountry(gdelt("Tornado damages homes in Georgia"))).toBeNull(); // state or country
    expect(headlineCountry(gdelt("Sabah saatlerinde deprem oldu", "tr"))).toBeNull();
    expect(headlineCountry(gdelt("Deprem bölgesine mali yardım", "tr"))).toBeNull();
    expect(headlineCountry(gdelt("Incêndio florestal destrói madeira", "pt"))).toBeNull();
  });

  it("applies to GDELT only", () => {
    expect(headlineCountry({ title: "Earthquake in Japan", provider: "gdacs" })).toBeNull();
    expect(headlineCountry({ title: "Earthquake in Japan", provider: "guardian" })).toBeNull();
  });
});

describe("placing the article", () => {
  it("is the last resort, after a linked event", () => {
    const linked = { ...gdelt("Earthquake felt in Japan"), relatedEvent: { country: "Peru", lng: -75 } };
    expect(resolveLocation(linked)).toEqual({ countries: ["PE"], regions: ["americas"], source: "event" });
    expect(resolveLocation(gdelt("Earthquake felt in Japan"))).toEqual({ countries: ["JP"], regions: ["asia"], source: "headline" });
  });

  it("gives an article with no place in its headline no location", () => {
    expect(withLocation(gdelt("A week of earthquakes and floods")).location).toBeNull();
  });

  it("reaches the articles already in the cache", async () => {
    const T0 = new Date("2026-11-08T09:00:00Z");
    const store = createMemoryNewsStore();
    await store.save(
      [
        { ...gdelt("Earthquake damages homes in Japan"), domain: "example.com", publishedAt: "2026-11-08T08:00:00.000Z", image: null, relatedEvent: null, location: null, expiresAt: null, fetchedAt: T0.toISOString() },
        { ...gdelt("Flood warnings issued for the coast"), url: "https://example.com/world/2", domain: "example.com", publishedAt: "2026-11-08T08:00:00.000Z", image: null, relatedEvent: null, location: null, expiresAt: null, fetchedAt: T0.toISOString() },
      ],
      T0
    );
    const svc = createNewsService({ providers: [], store, loadEvents: async () => [], now: () => T0, log: { log() {}, warn() {}, error() {} } });
    await svc.restore();
    expect(svc.getNews({ country: "JP" }).items.map((a) => a.url)).toEqual(["https://example.com/world/1"]);
    expect(svc.getNews().items).toHaveLength(2); // the unplaced one is still listed
  });
});
