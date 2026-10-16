import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import request from "supertest";
import { createTestApp } from "./helpers.js";
import { REGIONS, COUNTRY_REGION, regionsOfCountry, countryCode, guardianTagPlace, resolveLocation } from "../src/services/newsLocation.js";
import { createGdacsNewsProvider, normalizeEmmArticle, gdacsRefOfFeedEvent, buildGdacsNewsUrl } from "../src/services/newsProviders/gdacs.provider.js";
import { createGdacsClient, parseGdacsPlace } from "../src/services/gdacs.js";
import { normalizeGuardianResult, buildGuardianUrl } from "../src/services/newsProviders/guardian.provider.js";
import { createNewsService, newsService } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const T = new Date("2026-10-16T20:00:00Z");
const EMM = JSON.parse(readFileSync(new URL("./fixtures/gdacs-emm-sample.json", import.meta.url), "utf8")).items;

const gdacsSource = (eventtype, eventid) => ({ name: "GDACS", url: `https://www.gdacs.org/report.aspx?eventtype=${eventtype}&eventid=${eventid}` });
/** Feed events in the normalised shape (GET /disasters). */
const FLOOD = {
  id: 11,
  type: "flood",
  severity: "low",
  timeMinutesAgo: 900,
  location: "Flood in Türkiye 1104230",
  lat: 41.0,
  lng: 28.9,
  country: "Türkiye",
  details: { cleanTitle: "Flood in Türkiye", occurredAt: "2026-10-14T00:00:00.000Z", sources: [gdacsSource("FL", "1104230")] },
};
const FIRE_NO_COUNTRY = {
  id: 12,
  type: "wildfire",
  severity: "low",
  timeMinutesAgo: 1200,
  location: "Wildfire 1032806",
  lat: -16.5,
  lng: 145.2,
  country: null,
  details: { cleanTitle: "Wildfire", occurredAt: "2026-10-14T00:00:00.000Z", sources: [gdacsSource("WF", "1032806")] },
};
const QUAKE = {
  id: 13,
  type: "earthquake",
  severity: "medium",
  timeMinutesAgo: 60,
  location: "M 5.9 - Fiji region",
  lat: -17,
  lng: 178,
  country: "Fiji",
  details: { cleanTitle: "M 5.9 - Fiji region", occurredAt: "2026-10-16T18:00:00.000Z", sources: [] },
};

const jsonRes = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => (typeof body === "string" ? body : JSON.stringify(body)) });
const fakeGdacs = (places) => ({ getPlace: vi.fn(async (ref) => places[`${ref.eventtype}:${ref.eventid}`] ?? null) });
const noThrottle = (fn) => fn();
const openGate = { run: (fn) => fn() };

describe("GDACS media news provider", () => {
  it("maps an EMM item to a link-out article: headline as sent (doubled apostrophes undone), UTC date, domain, no image, no text", () => {
    expect(normalizeEmmArticle(EMM[0])).toEqual({
      title: "City's worst floods in decades leave four dead",
      url: "https://news.example.com/world/2026/10/16/city-floods-leave-four-dead",
      domain: "news.example.com",
      publishedAt: "2026-10-16T17:38:00.000Z",
      image: null,
      provider: "gdacs",
    });
    expect(normalizeEmmArticle(EMM[3])).toBeNull(); // not an http(s) link
    expect(normalizeEmmArticle({ link: "https://x.example.com/a" })).toBeNull(); // no headline
    expect(JSON.stringify(EMM.map(normalizeEmmArticle))).not.toMatch(/Article content|description/);
  });

  it("asks only for feed events that link to a GDACS report, most severe and newest first, capped", async () => {
    expect(gdacsRefOfFeedEvent(FLOOD)).toEqual({ eventtype: "FL", eventid: "1104230" });
    expect(gdacsRefOfFeedEvent(QUAKE)).toBeNull();
    expect(buildGdacsNewsUrl({ eventtype: "FL", eventid: "1104230" })).toBe("https://www.gdacs.org/gdacsapi/api/emm/getemmnewsbykey?eventtype=FL&eventid=1104230");

    const fetchImpl = vi.fn(async () => jsonRes([]));
    const provider = createGdacsNewsProvider({ fetchImpl, gdacs: fakeGdacs({}), throttle: noThrottle, backoff: openGate, maxEvents: 1 });
    const out = await provider.searchEvents([FIRE_NO_COUNTRY, QUAKE, FLOOD]);
    expect(out.attempted).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl.mock.calls[0][0]).toContain("eventtype=FL&eventid=1104230"); // the newer of the two GDACS events
  });

  it("attaches the feed event and the GDACS event's place to each article; no media (404, empty) is not a failure", async () => {
    const fetchImpl = vi.fn(async (url) => (url.includes("1104230") ? jsonRes(EMM) : jsonRes("", 404)));
    const gdacs = fakeGdacs({ "FL:1104230": { countries: ["TR"], lat: 41.0, lng: 28.9 } });
    const provider = createGdacsNewsProvider({ fetchImpl, gdacs, throttle: noThrottle, backoff: openGate });
    const out = await provider.searchEvents([FLOOD, FIRE_NO_COUNTRY]);
    expect(out).toMatchObject({ attempted: 2, failures: 0 });
    expect(out.articles.map((a) => a.url)).toEqual([
      "https://news.example.com/world/2026/10/16/city-floods-leave-four-dead",
      "https://daily.example.com/region/floods-trigger-landslides-damage-businesses",
      "https://library.example.com/2026/10/15/journal-lists-launch",
    ]);
    expect(out.articles.every((a) => a.event.id === 11 && a.gdacsPlace.countries[0] === "TR")).toBe(true);
  });

  it("counts failed lookups (HTTP errors, non-JSON) without throwing", async () => {
    const fetchImpl = vi.fn(async (url) => (url.includes("1104230") ? jsonRes("<html>", 200) : jsonRes("", 503)));
    const provider = createGdacsNewsProvider({ fetchImpl, gdacs: fakeGdacs({}), throttle: noThrottle, backoff: openGate });
    const out = await provider.searchEvents([FLOOD, FIRE_NO_COUNTRY]);
    expect(out).toMatchObject({ attempted: 2, failures: 2, articles: [] });
    expect(["non-json", "http"]).toContain(out.lastFailureKind);
  });

  it("reads the event's countries and point from the same GDACS answer the severity lookup uses (one request)", async () => {
    const payload = {
      type: "Feature",
      geometry: { type: "Point", coordinates: [28.9, 41.0] },
      properties: { alertlevel: "Green", alertscore: 1, affectedcountries: [{ iso2: "TR", iso3: "TUR", countryname: "Türkiye" }] },
    };
    expect(parseGdacsPlace(payload)).toEqual({ countries: ["TR"], lat: 41.0, lng: 28.9 });
    expect(parseGdacsPlace({ properties: {} })).toEqual({ countries: [], lat: null, lng: null });

    const fetchImpl = vi.fn(async () => ({ ok: true, status: 200, json: async () => payload }));
    const client = createGdacsClient({ fetchImpl, log: quiet });
    const ref = { eventtype: "FL", eventid: "1104230" };
    expect(await client.getLevel(ref)).toEqual({ level: "green", score: 1, text: null });
    expect(await client.getPlace(ref)).toEqual({ countries: ["TR"], lat: 41.0, lng: 28.9 });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("location priority: linked event -> Guardian tags -> GDACS event", () => {
  const tags = { countries: ["MX"], regions: ["americas"] };
  const gdacsPlace = { countries: ["AU"], lat: -16.5, lng: 145.2 };

  it("takes the linked event's country first", () => {
    expect(resolveLocation({ relatedEvent: { country: "Türkiye", lng: 28.9 }, tagPlace: tags, gdacsPlace })).toEqual({ countries: ["TR"], regions: ["middle-east"], source: "event" });
  });

  it("falls back to the Guardian tags when the event has no country (or there is no event)", () => {
    expect(resolveLocation({ relatedEvent: { country: null }, tagPlace: tags, gdacsPlace })).toEqual({ countries: ["MX"], regions: ["americas"], source: "guardian-tags" });
    expect(resolveLocation({ relatedEvent: null, tagPlace: { countries: [], regions: ["africa"] } })).toEqual({ countries: [], regions: ["africa"], source: "guardian-tags" });
  });

  it("falls back to the GDACS event's country last (country inheritance for GDACS media)", () => {
    expect(resolveLocation({ relatedEvent: { country: null, lng: 145.2 }, tagPlace: null, gdacsPlace })).toEqual({ countries: ["AU"], regions: ["oceania"], source: "gdacs" });
  });

  it("never invents a location: nothing to go on -> null", () => {
    expect(resolveLocation({ relatedEvent: null })).toBeNull();
    expect(resolveLocation({ relatedEvent: { country: "North Atlantic Ocean" }, tagPlace: { countries: [], regions: [] }, gdacsPlace: { countries: [] } })).toBeNull();
  });

  it("derives countries and region tags from Guardian keyword tags, ignoring non-places", () => {
    expect(
      guardianTagPlace([
        { id: "world/mexico", type: "keyword", webTitle: "Mexico" },
        { id: "world/americas", type: "keyword", webTitle: "Americas" },
        { id: "world/hurricanes", type: "keyword", webTitle: "Hurricanes" },
        { id: "us-news/california", type: "keyword", webTitle: "California" },
      ])
    ).toEqual({ countries: ["MX", "US"], regions: ["americas"] });
    expect(guardianTagPlace([{ id: "world/extreme-weather", type: "keyword", webTitle: "Extreme weather" }])).toBeNull();
    // a country tag decides the region; a wider region tag does not add another one
    const place = guardianTagPlace([
      { id: "world/indonesia", type: "keyword", webTitle: "Indonesia" },
      { id: "world/asia-pacific", type: "keyword", webTitle: "Asia Pacific" },
    ]);
    expect(resolveLocation({ tagPlace: place })).toEqual({ countries: ["ID"], regions: ["asia"], source: "guardian-tags" });
  });

  it("asks The Guardian for keyword tags and keeps only the derived place, never the tags", () => {
    expect(new URL(buildGuardianUrl({ q: "flood", apiKey: "k", now: T })).searchParams.get("show-tags")).toBe("keyword");
    const a = normalizeGuardianResult({
      type: "article",
      webTitle: "Hurricane makes landfall on the Pacific coast",
      webUrl: "https://news.example.com/world/2026/oct/16/hurricane-landfall",
      webPublicationDate: "2026-10-16T10:00:00Z",
      tags: [{ id: "world/mexico", type: "keyword", webTitle: "Mexico" }],
    });
    expect(a.tagPlace).toEqual({ countries: ["MX"], regions: [] });
    expect(a).not.toHaveProperty("tags");
  });
});

describe("country -> region table", () => {
  it("has six regions and puts every listed country in exactly one", () => {
    expect(REGIONS.map((r) => r.id)).toEqual(["africa", "americas", "asia", "europe", "middle-east", "oceania"]);
    const all = [...COUNTRY_REGION.keys()];
    expect(new Set(all).size).toBe(all.length);
    expect(all.length).toBeGreaterThan(200);
  });

  it("maps feed country names (Intl names and aliases) to codes and regions", () => {
    const cases = {
      Türkiye: ["TR", "middle-east"],
      Libya: ["LY", "africa"],
      Mexico: ["MX", "americas"],
      "United States": ["US", "americas"],
      "Myanmar (Burma)": ["MM", "asia"],
      "Congo - Kinshasa": ["CD", "africa"],
      "United Kingdom": ["GB", "europe"],
      Australia: ["AU", "oceania"],
      Fiji: ["FJ", "oceania"],
      Bolivia: ["BO", "americas"],
    };
    for (const [name, [code, region]] of Object.entries(cases)) {
      expect(countryCode(name), name).toBe(code);
      expect(regionsOfCountry(code), name).toEqual([region]);
    }
    expect(countryCode("Hurricanes")).toBeNull();
  });

  it("places Russia by longitude when known, in both regions otherwise", () => {
    expect(regionsOfCountry("RU", 160.5)).toEqual(["asia"]);
    expect(regionsOfCountry("RU", 37.6)).toEqual(["europe"]);
    expect(regionsOfCountry("RU")).toEqual(["europe", "asia"]);
    expect(regionsOfCountry("ZZ")).toEqual([]);
  });
});

describe("the service: GDACS merged in, regions served, unlocated only under All", () => {
  const art = (title, url, extra = {}) => ({ title, url, domain: new URL(url).hostname, publishedAt: "2026-10-16T12:00:00.000Z", image: null, ...extra });

  function setup() {
    const guardianState = { down: false };
    const guardian = {
      name: "guardian",
      label: "The Guardian",
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
      searchGroup: async () => [],
      searchGeneral: async () => {
        if (guardianState.down) throw Object.assign(new Error("The Guardian HTTP 500"), { kind: "http" });
        return [
          art("Hurricane makes landfall on the Pacific coast", "https://news.example.com/world/hurricane-landfall", { provider: "guardian", tagPlace: { countries: ["MX"], regions: ["americas"] } }),
          art("Wildfires and floods: a week of natural disasters", "https://news.example.com/world/week-of-disasters", { provider: "guardian", tagPlace: null }),
        ];
      },
    };
    const gdacsFetch = vi.fn(async (url) => (url.includes("1104230") ? jsonRes(EMM.slice(0, 3)) : jsonRes([])));
    const gdacsNews = createGdacsNewsProvider({
      fetchImpl: gdacsFetch,
      gdacs: fakeGdacs({ "FL:1104230": { countries: ["TR"], lat: 41, lng: 28.9 }, "WF:1032806": { countries: ["AU"], lat: -16.5, lng: 145.2 } }),
      throttle: noThrottle,
      backoff: openGate,
    });
    const gdeltDown = {
      name: "gdelt",
      label: "GDELT",
      refreshIntervalMs: 15 * 60_000,
      retentionMs: 72 * 3600_000,
      maxGroupSearches: 0,
      searchGroup: async () => [],
      searchGeneral: async () => {
        throw Object.assign(new Error("GDELT rate limit (429)"), { kind: "rate-limit" });
      },
    };
    const svc = createNewsService({
      providers: [gdeltDown, guardian, gdacsNews],
      store: createMemoryNewsStore(),
      loadEvents: async () => [FLOOD, FIRE_NO_COUNTRY, QUAKE],
      now: () => T,
      log: quiet,
    });
    return { svc, gdacsFetch, guardianState };
  }

  it("merges GDACS media (relevance-filtered, linked, located) with The Guardian and reports it in status", async () => {
    const { svc } = setup();
    await svc.refresh();
    const all = svc.getNews();
    const gd = all.items.filter((a) => a.provider === "gdacs");
    // the off-topic "journal lists" item is dropped by the relevance rules
    expect(gd.map((a) => a.title)).toEqual(["City's worst floods in decades leave four dead", "Floods trigger dozens of landslides and damage hundreds of businesses"]);
    expect(gd.every((a) => a.relatedEvent?.id === 11 && a.location?.source === "event" && a.location.countries[0] === "TR")).toBe(true);
    expect(gd[0]).not.toHaveProperty("gdacsPlace");
    expect(gd[0]).not.toHaveProperty("event");
    expect(all.source).toBe("The Guardian + GDACS");

    const st = svc.status().providers;
    expect(st.gdacs).toMatchObject({ articles: 2, located: 2, lastErrorKind: null, droppedOffTopic: 1 });
    expect(st.gdelt).toMatchObject({ articles: 0, lastErrorKind: "rate-limit" });
  });

  it("uses the GDACS event's country when the linked feed event has none", async () => {
    const { svc, gdacsFetch } = setup();
    gdacsFetch.mockImplementation(async (url) => (url.includes("1032806") ? jsonRes([{ title: "Bushfire destroys homes near the coast", link: "https://news.example.com/au/bushfire-homes", pubdate: "2026-10-16T09:00:00" }]) : jsonRes([])));
    await svc.refresh();
    const a = svc.getNews().items.find((x) => x.provider === "gdacs");
    expect(a.relatedEvent).toMatchObject({ id: 12, country: null });
    expect(a.location).toEqual({ countries: ["AU"], regions: ["oceania"], source: "gdacs" });
  });

  it("filters by region and lists unlocated articles only under All", async () => {
    const { svc } = setup();
    await svc.refresh();
    const unlocated = "https://news.example.com/world/week-of-disasters";
    const all = svc.getNews();
    expect(all.items.map((a) => a.url)).toContain(unlocated);
    expect(all.items.find((a) => a.url === unlocated).location).toBeNull();

    for (const { id } of REGIONS) {
      const items = svc.getNews({ region: id }).items;
      expect(items.map((a) => a.url), id).not.toContain(unlocated);
      expect(items.every((a) => a.location.regions.includes(id)), id).toBe(true);
    }
    expect(svc.getNews({ region: "americas" }).items.map((a) => a.url)).toEqual(["https://news.example.com/world/hurricane-landfall"]);
    expect(svc.getNews({ region: "middle-east" }).items).toHaveLength(2);
    expect(svc.getNews({ region: "europe" }).items).toEqual([]);
  });

  it("is not stale when only GDELT fails while others are fresh; stale once every contributor failed", async () => {
    const { svc, gdacsFetch, guardianState } = setup();
    await svc.refresh();
    expect(svc.getNews().stale).toBe(false);
    gdacsFetch.mockImplementation(async () => jsonRes("", 503));
    await svc.refresh(); // GDELT 429 and GDACS down; The Guardian still answers
    expect(svc.getNews().stale).toBe(false);
    guardianState.down = true;
    await svc.refresh();
    expect(svc.getNews().stale).toBe(true);
  });
});

describe("GET /news?region=", () => {
  it("rejects an unknown region and passes a known one to the service", async () => {
    const spy = vi.spyOn(newsService, "getNews").mockReturnValue({ items: [], updatedAt: null, stale: false, source: "", provider: null });
    const app = createTestApp();
    const bad = await request(app).get("/news?region=atlantis");
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/Unknown region/);
    const ok = await request(app).get("/news?region=Africa");
    expect(ok.status).toBe(200);
    expect(spy).toHaveBeenLastCalledWith(expect.objectContaining({ region: "africa" }));
    spy.mockRestore();
  });
});
