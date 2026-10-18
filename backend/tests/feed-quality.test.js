import { describe, it, expect, vi } from "vitest";
import { isDisasterNews, stormNamesIn } from "../src/services/newsRelevance.js";
import { urlDate, withUrlDate } from "../src/services/newsLinking.js";
import { createGdeltProvider } from "../src/services/newsProviders/gdelt.provider.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";
import { createStormContext, currentStormNames, STORM_CACHE_MS } from "../src/services/stormContext.js";
import { createFeedService } from "../src/services/feed.service.js";
import { eventSubtitle, withSubtitles } from "../src/utils/eventSubtitle.js";

// Headlines are paraphrased, links are example.com.
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const NOW = new Date("2026-10-18T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const verdict = (title, opts = {}) => isDisasterNews({ title, url: "https://news.example.com/world/story" }, { now: NOW, ...opts });

describe("(a) GDELT publication date from the article URL", () => {
  it("reads /YYYY/MM/DD/, YYYY-MM-DD and a /YYYYMMDD/ segment", () => {
    expect(urlDate("https://news.example.com/2024/08/02/storm-may-develop/", NOW).toISOString()).toBe("2024-08-02T12:00:00.000Z");
    expect(urlDate("https://news.example.com/news/2026-10-16-floods-hit-coast", NOW).toISOString()).toBe("2026-10-16T12:00:00.000Z");
    expect(urlDate("https://news.example.com/archive/20250115/quake", NOW).toISOString()).toBe("2025-01-15T12:00:00.000Z");
  });

  it("ignores URLs without a date, impossible dates, far-future dates and long numeric ids", () => {
    expect(urlDate("https://news.example.com/news/26645959.flooding-story/", NOW)).toBeNull();
    expect(urlDate("https://news.example.com/2026/02/30/story", NOW)).toBeNull();
    expect(urlDate("https://news.example.com/2026/12/01/story", NOW)).toBeNull();
    expect(urlDate("https://news.example.com/articles/2026101812345", NOW)).toBeNull();
    expect(urlDate("not a url", NOW)).toBeNull();
  });

  it("uses the URL day only when it is earlier than GDELT's seen date", () => {
    const seen = "2026-10-18T06:45:00.000Z";
    expect(withUrlDate({ url: "https://news.example.com/2024/08/02/story/", publishedAt: seen }, NOW).publishedAt).toBe("2024-08-02T23:59:59.000Z");
    // same day: the seen time is more precise
    expect(withUrlDate({ url: "https://news.example.com/2026/10/18/story/", publishedAt: seen }, NOW).publishedAt).toBe(seen);
    expect(withUrlDate({ url: "https://news.example.com/news/story", publishedAt: seen }, NOW).publishedAt).toBe(seen);
  });

  it("the end of the URL day never ages a page seen just after midnight UTC by half a day", () => {
    // US evening article on the 15th, seen 01:20 UTC on the 16th
    expect(withUrlDate({ url: "https://news.example.com/2026/10/15/story/", publishedAt: "2026-10-16T01:20:00.000Z" }, NOW).publishedAt).toBe("2026-10-15T23:59:59.000Z");
  });

  it("the GDELT provider applies it to every article", async () => {
    const client = { searchArticles: async () => [{ url: "https://news.example.com/2024/08/02/storm-may-develop/", title: "Storm may develop this weekend", seendate: "20261018T064500Z" }] };
    const [a] = await createGdeltProvider({ client }).searchGeneral();
    expect(a.publishedAt).toBe("2024-08-02T23:59:59.000Z");
    expect(a.provider).toBe("gdelt");
  });

  const T = new Date("2026-10-18T12:00:00Z");
  const fakeGdelt = (articles) => [{ name: "gdelt", label: "GDELT", refreshIntervalMs: 1, retentionMs: null, searchGroup: async () => [], searchGeneral: async () => articles }];
  const gdelt = (title, url, publishedAt = "2026-10-18T06:00:00.000Z") => ({ title, url, domain: "news.example.com", publishedAt, image: null, provider: "gdelt" });

  it("drops a GDELT article older than 72 h and dates the rest from the URL (the shown 'x ago')", async () => {
    const svc = createNewsService({
      providers: fakeGdelt([
        gdelt("Hurricane center says storm likely to develop", "https://news.example.com/2024/08/02/storm-likely-to-develop/"),
        gdelt("Flash floods sweep through valley towns", "https://news.example.com/2026/10/16/flash-floods-valley/"),
        gdelt("Earthquake shakes coastal city", "https://news.example.com/world/quake-coastal-city"),
      ]),
      store: createMemoryNewsStore(),
      loadEvents: async () => [],
      now: () => T,
      log: quiet,
    });
    await svc.refresh();
    const items = svc.getNews().items;
    expect(items.map((a) => a.title)).toEqual(["Earthquake shakes coastal city", "Flash floods sweep through valley towns"]);
    expect(items.find((a) => a.title.startsWith("Flash")).publishedAt).toBe("2026-10-16T23:59:59.000Z");
    expect(items.find((a) => a.title.startsWith("Earthquake")).publishedAt).toBe("2026-10-18T06:00:00.000Z");
  });

  it("re-dates and drops cached GDELT rows restored from the database (cached before the rule)", async () => {
    const store = createMemoryNewsStore();
    const row = (over) => ({ ...gdelt("x", "https://news.example.com/x"), relatedEvent: null, location: null, fetchedAt: "2026-10-18T07:00:00.000Z", expiresAt: "2026-10-21T07:00:00.000Z", ...over });
    await store.save(
      [
        row({ title: "Hurricane center says storm likely to develop", url: "https://news.example.com/2024/08/02/storm-likely-to-develop/" }),
        row({ title: "Flash floods sweep through valley towns", url: "https://news.example.com/2026/10/17/flash-floods-valley/" }),
      ],
      "2026-10-18T07:00:00.000Z"
    );
    const svc = createNewsService({ providers: fakeGdelt([]), store, loadEvents: async () => [], now: () => T, log: quiet });
    await svc.restore();
    const items = svc.getNews().items;
    expect(items.map((a) => a.title)).toEqual(["Flash floods sweep through valley towns"]);
    expect(items[0].publishedAt).toBe("2026-10-17T23:59:59.000Z");
  });

  it("other providers keep their own dates (no URL-date or 72 h rule)", async () => {
    const providers = [{ name: "gdacs", label: "GDACS", refreshIntervalMs: 1, retentionMs: null, searchGroup: async () => [], searchGeneral: async () => [{ title: "Floods kill two in the capital", url: "https://news.example.com/2026/10/14/floods-capital/", domain: "news.example.com", publishedAt: "2026-10-14T04:24:00.000Z", image: null, provider: "gdacs" }] }];
    const svc = createNewsService({ providers, store: createMemoryNewsStore(), loadEvents: async () => [], now: () => T, log: quiet });
    await svc.refresh();
    expect(svc.getNews().items.map((a) => a.publishedAt)).toEqual(["2026-10-14T04:24:00.000Z"]);
  });
});

describe("(b) 'after / since / following Hurricane X' in any casing", () => {
  it("drops the retrospective whatever the casing", () => {
    expect(verdict("Commissioner announces removal of abandoned vessel Following Hurricane Beryl").keep).toBe(false);
    expect(verdict("Commissioner announces removal of abandoned vessel FOLLOWING HURRICANE BERYL").keep).toBe(false);
    // an all-lower-case name is not read as a name (the price of not mistaking "after storm brings" for one)
    expect(verdict("Commissioner announces removal of abandoned vessel following hurricane beryl").keep).toBe(true);
    expect(verdict("Town rebuilds its library AFTER HURRICANE IAN").keep).toBe(false);
    expect(verdict("Commissioner announces removal of abandoned vessel Following Hurricane Beryl").reason).toMatch(/^retrospective/);
  });

  it("keeps it with impact in the headline, and 'Following Hurricane Season' is not a name", () => {
    expect(verdict("Thousands evacuated Following Hurricane Trudy landfall").keep).toBe(true);
    expect(verdict("Insurers brace Following Hurricane Season forecast of strong winds").keep).toBe(true);
  });

  it("a lower-case word after 'after storm' is not a name (no regression on current reports)", () => {
    // the committed draft read "brings" as a storm name and dropped this as a retrospective
    expect(verdict("Schools close after storm brings snow and power cuts").keep).toBe(true);
    expect(verdict("Schools close after storm brings heavy snow").reason).not.toMatch(/^retrospective/);
    expect(verdict("Power still out in thousands of homes since storm knocked lines down").keep).toBe(true);
  });
});

describe("(c) headlines about storms that are not current", () => {
  it("extracts storm names and leaves non-names out", () => {
    expect(stormNamesIn("FSC scrutinises outstanding Hurricane Melissa claims")).toEqual(["melissa"]);
    expect(stormNamesIn("Super Typhoon Champi passes near Guam; Typhoon Koguma weakens")).toEqual(["champi", "koguma"]);
    expect(stormNamesIn("Tropical Cyclone 01P strengthens")).toEqual(["01p"]);
    expect(stormNamesIn("National Hurricane Center Advises On The Week")).toEqual([]);
    expect(stormNamesIn("Typhoon Season Begins Early")).toEqual([]);
    expect(stormNamesIn("Cyclone hits the coast")).toEqual([]);
    expect(stormNamesIn("Hurricane Insurance Claims Rise")).toEqual([]);
  });

  const storms = new Set(["trudy", "champi"]);

  it("drops a headline naming only an inactive storm (insurance about a past storm included)", () => {
    const v = verdict("FSC scrutinises outstanding Hurricane Melissa claims", { storms });
    expect(v.keep).toBe(false);
    expect(v.reason).toBe('retrospective (storm "melissa" not active or recently closed)');
    expect(verdict("Boxing club displaced by Hurricane Ida now trains kids for free", { storms }).keep).toBe(false);
  });

  it("keeps follow-up and insurance news about a current storm", () => {
    expect(verdict("Insured losses from Hurricane Trudy estimated at 2 billion", { storms }).keep).toBe(true);
    expect(verdict("Super Typhoon Champi passes near Guam with dangerous winds", { storms }).keep).toBe(true);
  });

  it("name repeat: the same name under another storm class still matches the current storm", () => {
    // "Hurricane Trudy" in the feed; the article still calls it a tropical storm
    expect(verdict("Tropical Storm Trudy brings heavy rain to the coast", { storms }).keep).toBe(true);
    // a reused name cannot be told apart without a year; a past year is caught by the historical rule
    expect(verdict("Hurricane Trudy of 2020 remembered by fishermen", { storms }).keep).toBe(false);
  });

  it("a possessive or a hyphenated suffix still matches the current storm", () => {
    const current = new Set(["melissa", "choi-wan"]);
    expect(stormNamesIn("Hurricane Melissa's death toll rises")).toEqual(["melissa"]);
    expect(verdict("Hurricane Melissa's death toll rises", { storms: current }).keep).toBe(true);
    expect(verdict("Hurricane Melissa’s winds topple trees", { storms: current }).keep).toBe(true);
    expect(verdict("Hurricane Melissa-hit towns wait for aid", { storms: current }).keep).toBe(true);
    expect(verdict("Typhoon Choi-wan lashes the coast", { storms: current }).keep).toBe(true);
    expect(stormNamesIn("HURRICANE MELISSA NEARS COAST")).toEqual(["melissa"]);
  });

  it("keeps a headline that names a current storm next to a past one", () => {
    expect(verdict("Hurricane Trudy follows the path of Hurricane Ida", { storms }).keep).toBe(true);
  });

  it("is skipped when the storm list is unknown (EONET unreachable)", () => {
    expect(verdict("FSC scrutinises outstanding Hurricane Melissa claims", { storms: null }).keep).toBe(true);
  });

  const storm = (title, closed) => ({ title, closed, categories: [{ id: "severeStorms" }] });

  it("current = open or closed within 14 days (EONET closed dates)", () => {
    const names = currentStormNames(
      [
        storm("Hurricane Trudy", null),
        storm("Typhoon Koguma", new Date(NOW.getTime() - 13 * DAY).toISOString()),
        storm("Hurricane Melissa", new Date(NOW.getTime() - 15 * DAY).toISOString()),
        { title: "Wildfire Ida", closed: null, categories: [{ id: "wildfires" }] },
      ],
      NOW
    );
    expect([...names].sort()).toEqual(["koguma", "trudy"]);
  });

  it("the 14-day edge: closed exactly 14 days ago still counts, a minute later it does not", () => {
    const at14 = new Date(NOW.getTime() - 14 * DAY).toISOString();
    expect(currentStormNames([storm("Hurricane Melissa", at14)], NOW).has("melissa")).toBe(true);
    expect(currentStormNames([storm("Hurricane Melissa", at14)], new Date(NOW.getTime() + 60_000)).has("melissa")).toBe(false);
  });

  it("the storm list is cached for an hour, survives an EONET failure for a while, then turns unknown", async () => {
    let t = NOW.getTime();
    const fetchEvents = vi.fn(async () => [storm("Hurricane Trudy", null)]);
    const ctx = createStormContext({ fetchEvents, now: () => new Date(t), log: quiet });
    expect([...(await ctx.names())]).toEqual(["trudy"]);
    t += STORM_CACHE_MS - 1;
    await ctx.names();
    expect(fetchEvents).toHaveBeenCalledTimes(1);
    t += 2;
    fetchEvents.mockRejectedValueOnce(new Error("EONET 503"));
    expect([...(await ctx.names())]).toEqual(["trudy"]);
    t += 7 * 3600 * 1000;
    fetchEvents.mockRejectedValueOnce(new Error("EONET 503"));
    expect(await ctx.names()).toBeNull();
  });

  it("an EONET answer with no events at all is a failure, not 'no storms'", async () => {
    const ctx = createStormContext({ fetchEvents: async () => [], now: () => NOW, log: quiet });
    expect(await ctx.names()).toBeNull();
    // off-season: events of other categories but no storm -> an empty list is a real answer
    const offSeason = createStormContext({ fetchEvents: async () => [{ title: "Wildfire in Chile", closed: null, categories: [{ id: "wildfires" }] }], now: () => NOW, log: quiet });
    expect([...(await offSeason.names())]).toEqual([]);
  });

  it("after a restart the list is fetched again from EONET (nothing kept in memory only)", async () => {
    const fetchEvents = vi.fn(async () => [storm("Hurricane Trudy", null), storm("Typhoon Koguma", new Date(NOW.getTime() - 3 * DAY).toISOString())]);
    const fresh = createStormContext({ fetchEvents, now: () => NOW, log: quiet });
    expect([...(await fresh.names())].sort()).toEqual(["koguma", "trudy"]);
  });

  it("the news service drops past-storm articles and keeps current ones; feed storms count as current", async () => {
    const T = NOW;
    const article = (title) => ({ title, url: `https://news.example.com/world/${title.length}`, domain: "news.example.com", publishedAt: "2026-10-18T06:00:00.000Z", image: null, provider: "gdelt" });
    const providers = [{ name: "gdelt", label: "GDELT", refreshIntervalMs: 1, retentionMs: null, searchGroup: async () => [], searchGeneral: async () => [
      article("FSC scrutinises outstanding Hurricane Melissa claims"),
      article("Insured losses from Hurricane Trudy estimated at 2 billion"),
      article("Typhoon Koguma batters the islands"),
    ] }];
    const stormContext = { names: async () => new Set(["trudy"]) };
    const feedStorm = { id: 7, type: "storm", severity: "medium", location: "Typhoon Koguma", lat: 38, lng: 157, details: { cleanTitle: "Typhoon Koguma", status: "open" } };
    // closed 25 days ago: still in the 30-day feed, but not current (EONET's list decides for closed storms)
    const oldStorm = { id: 8, type: "storm", severity: "low", location: "Hurricane Melissa", lat: 18, lng: -77, details: { cleanTitle: "Hurricane Melissa", status: "closed" } };
    const svc = createNewsService({ providers, store: createMemoryNewsStore(), loadEvents: async () => [feedStorm, oldStorm], stormContext, now: () => T, log: quiet });
    await svc.refresh();
    expect(svc.getNews().items.map((a) => a.title).sort()).toEqual(["Insured losses from Hurricane Trudy estimated at 2 billion", "Typhoon Koguma batters the islands"]);
  });
});

describe("(d) /life/ section", () => {
  it("is excluded", () => {
    const v = isDisasterNews({ title: "City finds room for faith after earthquake leaves churches in ruins", url: "https://news.example.com/life/faith-after-earthquake/" }, { now: NOW });
    expect(v).toMatchObject({ keep: false, reason: 'section "life"' });
  });
});

describe("(B) subtitle for same-titled feed events", () => {
  const fire = (id, lat, lng, areaHa, occurredAt) => ({ id, type: "wildfire", lat, lng, title: "Wildfire in Australia", details: { cleanTitle: "Wildfire in Australia", areaHa, occurredAt } });

  it("formats approximate coordinates, area and start date", () => {
    expect(eventSubtitle(fire(1, -18.1533, 131.5826, 7652, "2026-10-14T00:00:00Z"))).toBe("≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct");
    expect(eventSubtitle({ lat: 38.3, lng: -157.2, details: { occurredAt: "2026-10-12T09:00:00Z" } })).toBe("≈ 38.3°N 157.2°W · since 12 Oct");
  });

  it("leaves the area out when there is none", () => {
    expect(eventSubtitle(fire(1, -12.4, 134.6, null, "2026-10-11T00:00:00Z"))).toBe("≈ 12.4°S 134.6°E · since 11 Oct");
  });

  it("only events whose title repeats get one; the title is untouched", () => {
    const items = withSubtitles([fire(1, -18.2, 131.6, 7652, "2026-10-14T00:00:00Z"), fire(2, -16.5, 142.5, 7043, "2026-10-14T00:00:00Z"), { id: 3, title: "Hurricane Trudy", lat: 17.9, lng: -105.5, details: { cleanTitle: "Hurricane Trudy" } }]);
    expect(items.map((e) => e.subtitle ?? null)).toEqual(["≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct", "≈ 16.5°S 142.5°E · 7,043 ha · since 14 Oct", null]);
    expect(items.map((e) => e.title)).toEqual(["Wildfire in Australia", "Wildfire in Australia", "Hurricane Trudy"]);
  });

  it("counts repeats over the whole window, not just the returned page", () => {
    const all = [fire(1, -18.2, 131.6, 7652, "2026-10-14T00:00:00Z"), fire(2, -16.5, 142.5, 7043, "2026-10-14T00:00:00Z")];
    expect(withSubtitles(all.slice(0, 1), all)[0].subtitle).toBe("≈ 18.2°S 131.6°E · 7,652 ha · since 14 Oct");
  });

  it("the public feed carries it as its own field", async () => {
    const eonet = (id, lng) => ({ id, title: "Wildfire in Australia 1032865", categories: [{ id: "wildfires", title: "Wildfires" }], geometry: [{ date: new Date(Date.now() - 3600_000).toISOString(), type: "Point", coordinates: [lng, -18.2], magnitudeValue: 7652, magnitudeUnit: "hectares" }], sources: [] });
    const svc = createFeedService({ fetchNasa: async () => [eonet("EONET_1", 131.6), eonet("EONET_2", 142.5)], fetchUsgs: async () => [], log: quiet });
    const { items } = await svc.getFeed();
    expect(items).toHaveLength(2);
    expect(items.every((e) => typeof e.subtitle === "string" && e.subtitle.startsWith("≈ 18.2°S"))).toBe(true);
    expect(items[0].subtitle).not.toBe(items[1].subtitle);
    expect(items.every((e) => e.details.cleanTitle === "Wildfire in Australia")).toBe(true);
  });
});
