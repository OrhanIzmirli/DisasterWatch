import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { isDisasterNews, excludedSection } from "../src/services/newsRelevance.js";
import { normalizeGuardianResult } from "../src/services/newsProviders/guardian.provider.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

const fixture = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const keep = (title, extra = {}) => isDisasterNews({ title, url: "https://news.example.com/world/2026/oct/16/story", ...extra }).keep;

describe("relevance filter on today's live panel (production, 2026-10-16)", () => {
  it("drops the AI technology story and the 'perfect storm' fishing feature, keeps the disaster reports", () => {
    const { items } = fixture("news-live-2026-10-16.json");
    const shown = items.filter((a) => isDisasterNews(a).keep).map((a) => a.title);
    expect(shown).toEqual([
      "Hurricane Simon and Tropical Storm Rachel kill five people on Mexico’s Pacific coast",
      "Indonesia wildfire fuelled by El Niño razes almost 300 homes ",
    ]);
    const ai = items.find((a) => a.title.startsWith("Companies rushed in on AI"));
    expect(isDisasterNews(ai)).toEqual({ keep: false, reason: 'section "technology"' });
    const fishing = items.find((a) => a.title.startsWith("A perfect storm"));
    expect(isDisasterNews(fishing).keep).toBe(false);
  });

  it("keeps only the disaster stories of the 2026-10-14 Guardian sample", () => {
    const live = fixture("guardian-live-2026-10-14.json");
    const shown = [...live.group, ...live.general]
      .map(normalizeGuardianResult)
      .filter(Boolean)
      .filter((a) => isDisasterNews(a).keep)
      .map((a) => a.title);
    expect(shown).toEqual([
      "Total fire ban declared for Sydney as heat and dry lightning raise the bushfire risk",
      "Huge surf and floods damage California beachfront homes and piers",
      "Wildfire driven by El Niño destroys nearly 300 homes in Indonesia",
      "Hurricane Simon and Tropical Storm Rachel leave five dead on Mexico's Pacific coast",
    ]);
  });
});

describe("hazard terms", () => {
  it("keeps headlines that name a hazard outright", () => {
    for (const t of [
      "Magnitude 6.9 earthquake strikes off Kamchatka",
      "Quake rattles Hokkaido",
      "Tsunami advisory lifted for Pacific coast",
      "Bushfire threatens homes north of Perth",
      "Typhoon Choi-wan heads for Okinawa",
      "Cyclone Rachel weakens over open water",
      "Tornado tears through Oklahoma town",
      "Flooding cuts off villages in Nepal",
      "Landslide buries road in Kerala",
      "Volcano on the Reykjanes peninsula erupts again",
      "Flood watch issued for the Ohio valley",
      "Tropical Storm Rachel forms in the eastern Pacific",
    ]) expect(keep(t), t).toBe(true);
  });

  it("needs disaster context for everyday words (storm, flood, tremor)", () => {
    expect(keep("Storm kills three in Bavaria")).toBe(true);
    expect(keep("Storm Amy brings 90mph winds to Scotland")).toBe(true);
    expect(keep("Tremors felt across Lima after magnitude 5.8 shock")).toBe(true);
    expect(keep("Flood leaves thousands stranded in Assam")).toBe(true);
    expect(keep("Storm clouds gather over the budget")).toBe(false);
    expect(keep("Tremors in the bond market as yields climb")).toBe(false);
    expect(keep("A flood in the basement of the museum")).toBe(false);
  });

  it("does not treat building fires or other evacuations as hazard news", () => {
    expect(keep("Fire at apartment block kills four")).toBe(false);
    expect(keep("Blaze guts historic theatre")).toBe(false);
    expect(keep("Evacuation after gas leak at shopping centre")).toBe(false);
  });

  it("accepts a hazard named only in the standfirst when the headline carries impact", () => {
    expect(keep("Thousands flee as river rises", { summary: "Flash flood warnings were issued across the valley." })).toBe(true);
    expect(keep("What the new climate data means for you", { summary: "Wildfires and floods are getting worse." })).toBe(false);
  });
});

describe("idioms, names and non-news sections", () => {
  it("ignores figures of speech and names that contain a hazard word", () => {
    for (const t of [
      "A perfect storm: how El Niño is devastating the fishing industry",
      "Minister faces storm of criticism over visa plan",
      "Firestorm over the new stadium deal",
      "Brainstorming session for the new budget",
      "How small firms can weather the storm",
      "K-pop band takes America by storm",
      "Senator storms out of hearing",
      "A political earthquake in the Dutch election",
      "Flood of applications for the new visa",
      "Rumour spread like wildfire on social media",
      "Carolina Hurricanes beat Rangers in overtime",
      "RAF sends Eurofighter Typhoon jets to Poland",
      "Storm Shadow missiles delivered to Ukraine",
    ]) expect(keep(t), t).toBe(false);
  });

  it("drops non-news sections and formats, even with a hazard word", () => {
    expect(excludedSection("https://www.theguardian.com/sport/2026/oct/16/hurricanes-win")).toBe("sport");
    expect(excludedSection("https://www.theguardian.com/world/2026/oct/16/quake")).toBeNull();
    expect(isDisasterNews({ title: "Insurers count the cost of Hurricane Simon", url: "https://www.theguardian.com/business/2026/oct/16/insurers" }).keep).toBe(false);
    expect(isDisasterNews({ title: "The floods were a warning we ignored", url: "https://www.theguardian.com/commentisfree/2026/oct/16/floods" }).keep).toBe(false);
    expect(isDisasterNews({ title: "Inside an abandoned Thai theme park, empty since the flooding", url: "https://www.theguardian.com/world/ng-interactive/2026/oct/14/park" }).keep).toBe(false);
  });

  it("drops GDELT body-text matches whose headline names no hazard", () => {
    expect(keep("India and Myanmar sign MoUs on five quick impact projects")).toBe(false);
  });

  it("drops reviews and TV listings whose title contains a hazard word (GDELT, 2026-10-16)", () => {
    expect(keep("BBC documentary Wildfire - A Warning From the Midland screened tonight")).toBe(false);
    expect(keep("Twister review: a tornado of a sequel")).toBe(false);
    // the real GDELT stories of the same day stay
    expect(keep("El Nino rains flood South America , sending residents fleeing and cattle swimming")).toBe(true);
    expect(keep("Guam faces third powerful typhoon in months as Champi approaches")).toBe(true);
    expect(keep("Malibu wildfire rages , triggering evacuations in Southern California")).toBe(true);
  });
});

describe("the service filters every search, not only the general one", () => {
  it("drops an off-topic article returned by a group search (it used to pass unchecked)", async () => {
    const mk = (title, url) => ({ title, url, domain: "theguardian.com", publishedAt: "2026-10-16T08:00:00.000Z", image: null, provider: "guardian" });
    const provider = {
      name: "guardian",
      label: "The Guardian",
      refreshIntervalMs: 1,
      retentionMs: null,
      searchGroup: async () => [
        mk("Companies rushed in on AI. Now some are pulling back", "https://www.theguardian.com/technology/2026/oct/13/ai-companies-rushed-workers-fallout"),
        mk("Hurricane Simon kills five in Mexico", "https://www.theguardian.com/world/2026/oct/13/simon"),
      ],
      searchGeneral: async () => [],
    };
    const events = [{ id: 1, type: "storm", severity: "high", location: "Hurricane Simon", timeMinutesAgo: 60, details: { cleanTitle: "Hurricane Simon" } }];
    const svc = createNewsService({ providers: [provider], store: createMemoryNewsStore(), loadEvents: async () => events, now: () => new Date("2026-10-16T12:00:00Z"), log: quiet });
    await svc.refresh();
    expect(svc.getNews().items.map((a) => a.title)).toEqual(["Hurricane Simon kills five in Mexico"]);
  });
});
