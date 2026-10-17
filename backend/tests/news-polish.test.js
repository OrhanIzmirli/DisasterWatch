import { describe, it, expect, vi } from "vitest";
import { isDisasterNews } from "../src/services/newsRelevance.js";
import { confirmLocation, namesCountry, withLocation } from "../src/services/newsLocation.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

// Headlines are paraphrased, links are example.com.
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-10-17T12:00:00Z");
const verdict = (title) => isDisasterNews({ title, url: "https://news.example.com/world/2026/oct/17/story" }, { now: NOW });
const keep = (title) => verdict(title).keep;

const CHINA_FIRE = { id: 21, type: "wildfire", severity: "low", location: "Forest fire in China", lat: 25, lng: 100, country: "China" };
const TURKIYE_FLOOD = { id: 11, type: "flood", severity: "low", location: "Flood in Türkiye", lat: 41, lng: 28.9, country: "Türkiye" };
const PADANG_FLOOD = { id: 31, type: "flood", severity: "low", location: "Flood in Padang, Indonesia", lat: -0.9, lng: 100.4, country: "Indonesia" };
const gdacsArticle = (title, relatedEvent, url = "https://news.example.com/world/story") => ({ title, url, provider: "gdacs", relatedEvent });
const located = (code, region) => ({ countries: [code], regions: [region], source: "event" });

describe("GDACS articles keep the event's country only when they name it", () => {
  it("drops an inherited country the headline does not support (noisy GDACS list)", () => {
    const a = gdacsArticle("Neighbour offers to help Indonesia fight forest fires", CHINA_FIRE);
    expect(namesCountry(a, "CN")).toBe(false);
    expect(confirmLocation(a, located("CN", "asia"))).toBeNull();
  });

  it("keeps it when the headline names the country, an alias, a demonym or a place of the event label", () => {
    expect(confirmLocation(gdacsArticle("Floods in Turkey leave four dead", TURKIYE_FLOOD), located("TR", "europe"))).toEqual(located("TR", "europe"));
    expect(confirmLocation(gdacsArticle("Türkiye's worst floods in decades", TURKIYE_FLOOD), located("TR", "europe"))).not.toBeNull();
    expect(confirmLocation(gdacsArticle("Turkish officials count flood damage", TURKIYE_FLOOD), located("TR", "europe"))).not.toBeNull();
    expect(confirmLocation(gdacsArticle("Aid reaches Padang flood survivors", PADANG_FLOOD), located("ID", "asia"))).not.toBeNull();
    // the story slug counts too
    expect(confirmLocation(gdacsArticle("Floods leave four dead", TURKIYE_FLOOD, "https://news.example.com/world/turkey-floods-four-dead"), located("TR", "europe"))).not.toBeNull();
  });

  it("prefers unlocated when the headline names no country at all", () => {
    expect(confirmLocation(gdacsArticle("Teenager dies as heavy rain floods the city", TURKIYE_FLOOD), located("TR", "europe"))).toBeNull();
  });

  it("a city of the event's country confirms it", () => {
    expect(confirmLocation(gdacsArticle("Worst floods in decades leave four dead in Istanbul", TURKIYE_FLOOD), located("TR", "europe"))).toEqual(located("TR", "europe"));
    expect(confirmLocation(gdacsArticle("Floods leave four dead", TURKIYE_FLOOD, "https://news.example.com/world/ankara-floods-four-dead"), located("TR", "europe"))).not.toBeNull();
  });

  it("a city of another country contradicts it, even when the country is named", () => {
    expect(confirmLocation(gdacsArticle("Smoke from forest fires reaches Jakarta", CHINA_FIRE), located("CN", "asia"))).toBeNull();
    expect(confirmLocation(gdacsArticle("China sends firefighters as smoke chokes Kuala Lumpur", CHINA_FIRE), located("CN", "asia"))).toBeNull();
  });

  it("an ambiguous city (Tripoli: Libya and Lebanon) neither confirms nor contradicts", () => {
    const LIBYA_FLOOD = { id: 41, type: "flood", severity: "low", location: "Flood in Libya", lat: 32.9, lng: 13.2, country: "Libya" };
    expect(confirmLocation(gdacsArticle("Tripoli authorities open an inquiry into flood damage", LIBYA_FLOOD), located("LY", "africa"))).toBeNull();
    expect(confirmLocation(gdacsArticle("Two die as rains flood Libya's capital Tripoli", LIBYA_FLOOD), located("LY", "africa"))).toEqual(located("LY", "africa"));
  });

  it("applies the same check to the GDACS report's country (event without one)", () => {
    const a = { ...gdacsArticle("Bushfire threatens homes", { ...CHINA_FIRE, country: null }), gdacsPlace: { countries: ["AU"], lat: -16, lng: 145 } };
    expect(withLocation(a).location).toBeNull();
    expect(withLocation({ ...a, title: "Bushfire threatens Australian homes" }).location).toEqual({ countries: ["AU"], regions: ["oceania"], source: "gdacs" });
  });

  it("leaves other providers' placements alone", () => {
    const g = { title: "Floods leave four dead", url: "https://news.example.com/a", provider: "gdelt", relatedEvent: TURKIYE_FLOOD };
    expect(confirmLocation(g, located("TR", "europe"))).toEqual(located("TR", "europe"));
    const tags = { countries: ["MX"], regions: ["americas"], source: "guardian-tags" };
    expect(confirmLocation({ ...g, provider: "gdacs" }, tags)).toBe(tags);
  });
});

describe("historical markers and sports-team uses of hazard words", () => {
  it("drops a past 4-digit year, 'N years ago' and 'World Series'", () => {
    expect(verdict("Newsrooms revisit the 2025 island floods").reason).toBe('historical ("2025")');
    expect(keep("The 1906 earthquake that reshaped the city")).toBe(false);
    expect(keep("How a brewery flood killed eight people 200 years ago")).toBe(false);
    expect(keep("The World Series earthquake that brought down highways")).toBe(false);
    expect(keep("Flood anniversary marked with a vigil")).toBe(false);
  });

  it("keeps current reports with a year or a count", () => {
    expect(keep("2026 monsoon floods kill 40 in the north")).toBe(true);
    expect(keep("Wildfire destroys 1900 homes as winds rise")).toBe(true);
    expect(keep("Magnitude 6.1 earthquake strikes off the coast")).toBe(true);
  });

  it("drops team names next to a league or sport word, keeps impact on a stadium", () => {
    expect(verdict("City Hurricanes open the volleyball league campaign with a win").reason).toBe('sports ("volleyball", no impact in the headline)');
    expect(keep("Storm edge Lynx in the basketball playoffs")).toBe(false);
    expect(keep("Cyclones top the rugby championship table")).toBe(false);
    expect(keep("Hurricane damages football stadium, matches called off")).toBe(true);
  });
});

describe("the rules run again on cached articles", () => {
  const T = new Date("2026-10-17T12:00:00Z");
  const cached = (over) => ({ domain: "news.example.com", publishedAt: "2026-10-17T08:00:00.000Z", image: null, relatedEvent: null, location: null, fetchedAt: "2026-10-17T08:00:00.000Z", expiresAt: "2026-10-19T08:00:00.000Z", ...over });

  async function restoredService(items) {
    const store = createMemoryNewsStore();
    await store.save(items, "2026-10-17T08:00:00.000Z");
    const providers = ["gdelt", "guardian", "gdacs"].map((name) => ({ name, label: name, refreshIntervalMs: 1, retentionMs: null, searchGroup: async () => [], searchGeneral: async () => [] }));
    const svc = createNewsService({ providers, store, loadEvents: async () => [], now: () => T, log: quiet });
    await svc.restore();
    return svc;
  }

  it("drops pre-deploy junk restored from the database at once, not after it expires", async () => {
    const svc = await restoredService([
      cached({ title: "Visitors queue to try a pretend typhoon as dark tourism grows", url: "https://news.example.com/world/pretend-typhoon", provider: "guardian" }),
      cached({ title: "City Hurricanes open the volleyball league campaign", url: "https://news.example.com/world/hurricanes-volleyball", provider: "gdelt" }),
      cached({ title: "Typhoon makes landfall, thousands evacuated", url: "https://news.example.com/world/typhoon-landfall", provider: "gdelt" }),
    ]);
    expect(svc.getNews().items.map((a) => a.title)).toEqual(["Typhoon makes landfall, thousands evacuated"]);
    expect(svc.status().providers.guardian.articles).toBe(0);
  });

  it("re-checks a cached GDACS location", async () => {
    const svc = await restoredService([
      cached({ title: "Neighbour offers to help Indonesia fight forest fires", url: "https://news.example.com/world/help-fires", provider: "gdacs", relatedEvent: CHINA_FIRE, location: located("CN", "asia") }),
      cached({ title: "Floods in Turkey leave four dead", url: "https://news.example.com/world/turkey-floods", provider: "gdacs", relatedEvent: TURKIYE_FLOOD, location: located("TR", "europe") }),
    ]);
    const byTitle = Object.fromEntries(svc.getNews().items.map((a) => [a.title, a.location]));
    expect(byTitle["Neighbour offers to help Indonesia fight forest fires"]).toBeNull();
    expect(byTitle["Floods in Turkey leave four dead"]).toEqual(located("TR", "europe"));
    expect(svc.getNews({ region: "asia" }).items).toEqual([]);
    expect(svc.status().providers.gdacs).toMatchObject({ articles: 2, located: 1 });
  });

  it("keeps a cached Guardian article that was kept on its (uncached) standfirst", async () => {
    const svc = await restoredService([cached({ title: "Thousands flee as river rises", url: "https://news.example.com/world/river-rises", provider: "guardian" })]);
    expect(svc.getNews().items.map((a) => a.title)).toEqual(["Thousands flee as river rises"]);
  });
});
