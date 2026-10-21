import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { linkArticlesToEvents, mentionsDisaster, slugWords } from "../src/services/newsLinking.js";
import { buildGuardianUrl, normalizeGuardianResult, createGuardianProvider } from "../src/services/newsProviders/guardian.provider.js";
import { createThrottle } from "../src/services/gdelt.js";
import { createNewsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

/** Live Guardian results of 2026-10-14 (see the fixture) must come out as disaster news only. */
const live = JSON.parse(readFileSync(new URL("./fixtures/guardian-live-2026-10-14.json", import.meta.url), "utf8"));
const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const titled = (list) => list.map((a) => a.title ?? a.webTitle);

describe("Guardian requests: articles only, matched on headline + standfirst", () => {
  it("asks the API for type=article, query-fields=headline,trailText and returns the standfirst", () => {
    const url = new URL(buildGuardianUrl({ q: "(flood) AND (nepal)", apiKey: "k", now: new Date("2026-10-14T10:00:00Z") }));
    expect(url.searchParams.get("type")).toBe("article");
    expect(url.searchParams.get("query-fields")).toBe("headline,trailText");
    expect(url.searchParams.get("show-fields")).toBe("trailText");
  });

  it("drops live blogs locally too (type liveblog, '– as it happened', '– business live', /live/ urls)", () => {
    const liveBlogs = [...live.group, ...live.general].filter((r) => r.type === "liveblog");
    expect(liveBlogs).toHaveLength(3);
    for (const r of liveBlogs) expect(normalizeGuardianResult(r)).toBeNull();
    // the same titles without the type field are still recognised by title / url
    for (const r of liveBlogs) expect(normalizeGuardianResult({ ...r, type: undefined })).toBeNull();
    expect(normalizeGuardianResult({ ...live.general[0], type: "gallery" })).toBeNull();
  });

  it("keeps the standfirst as plain text for the relevance check, never as cached content", async () => {
    const r = { ...live.general[5], fields: { trailText: "<p>Heavy <b>storm</b> surf and flooding&nbsp;hit the coast.</p>" } };
    const a = normalizeGuardianResult(r);
    expect(a.summary).toBe("Heavy storm surf and flooding hit the coast.");
    expect(a.title).toBe(live.general[5].webTitle);

    const provider = createGuardianProvider({
      apiKey: "k",
      fetchImpl: async () => ({ status: 200, ok: true, text: async () => JSON.stringify({ response: { results: [r] } }) }),
      throttle: createThrottle({ minGapMs: 0, sleep: async () => {} }),
      now: () => new Date("2026-10-14T12:00:00Z"),
    });
    const store = createMemoryNewsStore();
    const svc = createNewsService({ providers: [provider], store, loadEvents: async () => [], now: () => new Date("2026-10-14T12:00:00Z"), log: quiet });
    await svc.refresh();
    expect(svc.getNews().items[0]).not.toHaveProperty("summary");
    expect(store.saved.items[0]).not.toHaveProperty("summary");
  });
});

describe("general search: headline or standfirst must name a hazard", () => {
  it("eliminates the off-topic live articles and keeps the disaster ones", () => {
    const articles = live.general.map(normalizeGuardianResult).filter(Boolean); // live blogs already gone
    const kept = articles.filter(mentionsDisaster);
    expect(titled(kept)).toEqual([
      "Inside an abandoned theme park, empty since the flooding",
      "Huge surf and floods damage beachfront homes and piers on the central coast",
      "Wildfire driven by drought destroys nearly 300 homes on a southern island",
      "Hurricane Omar and Tropical Storm Lena leave five dead along the Pacific coast",
    ]);
    const dropped = titled(articles.filter((a) => !mentionsDisaster(a)));
    expect(dropped).toContain("Arctic shipping routes draw new interest from trading nations");
    expect(dropped).toContain("Hospital staffing, transit funding and a new school calendar | First Thing");
    expect(dropped).toHaveLength(10);
  });

  it("accepts a hazard word in the standfirst when the headline has none, whole words only", () => {
    expect(mentionsDisaster({ title: "Thousands flee as river rises", summary: "Flash flood warnings issued across the valley." })).toBe(true);
    expect(mentionsDisaster({ title: "Brainstorming session for the new budget" })).toBe(false); // "storm" inside a word
    expect(mentionsDisaster({ title: "Storm Rachel makes landfall" })).toBe(true);
  });

  it("the service applies the filter to general results of any provider (GDELT included)", async () => {
    const provider = {
      name: "gdelt",
      label: "GDELT",
      refreshIntervalMs: 1,
      retentionMs: null,
      searchGroup: async () => [],
      searchGeneral: async () => [
        { title: "Arctic shipping routes draw new interest from trading nations", url: "https://a.com/1", domain: "a.com", publishedAt: null, image: null, provider: "gdelt" },
        { title: "Quake rattles Hokkaido", url: "https://a.com/2", domain: "a.com", publishedAt: null, image: null, provider: "gdelt" },
      ],
    };
    const svc = createNewsService({ providers: [provider], store: createMemoryNewsStore(), loadEvents: async () => [], now: () => new Date("2026-10-14T12:00:00Z"), log: quiet });
    await svc.refresh();
    expect(titled(svc.getNews().items)).toEqual(["Quake rattles Hokkaido"]);
  });
});

describe("linking by headline and story slug only (section segments ignored)", () => {
  it("strips sections, dates, ids, format markers and words repeated from the section path", () => {
    expect(slugWords("https://example.com/australia-news/live/2026/oct/14/australia-news-live-senate-water-rights")).toEqual(["senate", "water", "rights"]);
    expect(slugWords("https://example.com/us-news/2026/oct/13/central-coast-storm-floods")).toEqual(["central", "coast", "storm", "floods"]);
    expect(slugWords("https://site.com/news/world/asia/12345/kushiro-quake.html")).toEqual(["kushiro", "quake"]);
    expect(slugWords("https://example.com/world/live")).toEqual([]);
    expect(slugWords("not a url")).toEqual([]);
  });

  it("does not link the australia-news live blogs to 'Wildfire in Australia', but keeps the Hunter region fire-ban article linked", () => {
    const event = live.event;
    // even if a live blog slipped past the provider guard, the section path must not link it
    const [councilBlog, budgetBlog, fireBan] = live.group.map((r) => ({ title: r.webTitle, url: r.webUrl }));
    const linked = linkArticlesToEvents([councilBlog, budgetBlog, fireBan], [event, { id: 9, type: "wildfire", locationText: "Wildfire in Botswana" }]);
    expect(linked.map((a) => a.event?.id ?? null)).toEqual([null, null, null]); // multi-event group: no place word in headline/slug

    // the real pipeline: live blogs removed by the provider, the fire-ban article linked as the single event of its group
    const normalized = live.group.map(normalizeGuardianResult).filter(Boolean);
    expect(titled(normalized)).toEqual(["Total fire ban declared for the Hunter region as heat and dry lightning raise the bushfire risk"]);
    const [fireBanArticle] = linkArticlesToEvents(normalized, [event], { single: true });
    expect(fireBanArticle.event?.id).toBe(event.id);
  });

  it("still links by real slug words (GDELT-style urls)", () => {
    const [a] = linkArticlesToEvents([{ title: "Tsunami advisory lifted", url: "https://b.com/papua-new-guinea-quake-kokopo" }], [{ id: 3, type: "earthquake", locationText: "M 6.0 - 126 km S of Kokopo, Papua New Guinea" }]);
    expect(a.event?.id).toBe(3);
  });
});
