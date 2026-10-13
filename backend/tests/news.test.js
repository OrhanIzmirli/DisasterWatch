import { describe, it, expect, vi } from "vitest";
import { cleanLocationText, buildEventQuery, dedupeArticles, normalizeArticle, parseGdeltDate, findArticlesForEvent } from "../src/services/newsLinking.js";
import { gdeltRequest, createThrottle, buildGdeltUrl, GdeltError } from "../src/services/gdelt.js";
import { createNewsService, pickTopEvents, NewsUnavailableError } from "../src/services/news.service.js";

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("cleanLocationText (real feed titles)", () => {
  it.each([
    ["Flood in Nepal 1104225", "Nepal"],
    ["53 km S of Kushiro, Japan", "Kushiro Japan"],
    ["M 6.0 - 126 km S of Kokopo, Papua New Guinea", "Kokopo Papua New Guinea"],
    ["Wildfire in Mongolia, China 1032753", "Mongolia China"],
    ["Wildfire in Tanzania 1032766", "Tanzania"],
    ["0 km SW of Aratoca, Colombia", "Aratoca Colombia"],
    ["Hurricane Simon", "Simon"],
    ["Tropical Storm Priscilla", "Priscilla"],
    ["Severe Storm, central Poland", "central Poland"],
    ["Wildfire Buckhorn 2, Cassia, Idaho", "Buckhorn Cassia Idaho"],
    ["", ""],
    [null, ""],
  ])("%j -> %j", (input, expected) => {
    expect(cleanLocationText(input)).toBe(expected);
  });
});

describe("buildEventQuery", () => {
  it("combines hazard keywords, the cleaned place and the English filter", () => {
    expect(buildEventQuery({ type: "earthquake", locationText: "53 km S of Kushiro, Japan" })).toBe(
      "(earthquake OR quake OR tremor) Kushiro Japan sourcelang:english"
    );
    expect(buildEventQuery({ type: "flood", locationText: "Flood in Nepal 1104225" })).toBe(
      "(flood OR flooding OR floods) Nepal sourcelang:english"
    );
    expect(buildEventQuery({ type: "wildfire", locationText: "Wildfire Buckhorn 2, Cassia, Idaho" })).toContain('"Buckhorn Cassia Idaho"');
  });

  it("falls back to a generic term for unknown types and empty places", () => {
    expect(buildEventQuery({ type: "volcano", locationText: "" })).toBe("disaster sourcelang:english");
  });
});

describe("article normalisation", () => {
  it("parses GDELT dates and derives the domain from the url when missing", () => {
    expect(parseGdeltDate("20261013T120000Z")).toBe("2026-10-13T12:00:00.000Z");
    expect(parseGdeltDate("not a date")).toBeNull();
    const a = normalizeArticle({ title: "  Big   quake  ", url: "https://www.example.com/a?x=1", seendate: "20261013T120000Z", socialimage: "" });
    expect(a).toEqual({ title: "Big quake", url: "https://www.example.com/a?x=1", domain: "example.com", publishedAt: "2026-10-13T12:00:00.000Z", image: null });
    expect(normalizeArticle({ title: "no url" })).toBeNull();
  });
});

describe("dedupeArticles", () => {
  it("drops the same url with different query/www/trailing slash and near-identical titles", () => {
    const out = dedupeArticles([
      { title: "Powerful quake hits Hokkaido coast", url: "https://www.a.com/story?utm=1" },
      { title: "Powerful quake hits Hokkaido coast", url: "https://a.com/story/" }, // same url
      { title: "Powerful quake hits Hokkaido coast - live", url: "https://b.com/live" }, // near-identical title
      { title: "Monsoon floods displace thousands in Nepal", url: "https://c.com/nepal" },
      { title: "Hokkaido quake: tsunami advisory lifted after powerful tremor", url: "https://d.com/x" }, // different enough
    ]);
    expect(out.map((a) => a.url)).toEqual(["https://www.a.com/story?utm=1", "https://c.com/nepal", "https://d.com/x"]);
  });

  it("keeps the first occurrence (caller order wins)", () => {
    const out = dedupeArticles([
      { title: "Same story", url: "https://first.com/1" },
      { title: "Same story", url: "https://second.com/2" },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].url).toBe("https://first.com/1");
  });
});

describe("findArticlesForEvent (search mocked)", () => {
  const raw = [
    { title: "Kushiro quake rattles Hokkaido", url: "https://news.jp/a", domain: "news.jp", seendate: "20261013T100000Z" },
    { title: "Kushiro quake rattles Hokkaido", url: "https://news.jp/a", domain: "news.jp", seendate: "20261013T100000Z" }, // dup
    { title: "Old article from last week", url: "https://old.com/b", domain: "old.com", seendate: "20261005T100000Z" },
    { title: "Rail lines inspected after Hokkaido tremor", url: "https://rail.jp/c", domain: "rail.jp", seendate: "20261013T120000Z" },
  ];

  it("builds the targeted query, filters to the event window and dedupes", async () => {
    const searchArticles = vi.fn(async () => raw);
    const out = await findArticlesForEvent(
      { type: "earthquake", locationText: "53 km S of Kushiro, Japan", occurredAt: "2026-10-13T09:00:00.000Z" },
      { searchArticles }
    );
    expect(searchArticles).toHaveBeenCalledWith({
      query: "(earthquake OR quake OR tremor) Kushiro Japan sourcelang:english",
      timespan: "72h",
      maxRecords: 10,
    });
    expect(out.map((a) => a.url)).toEqual(["https://news.jp/a", "https://rail.jp/c"]);
    expect(out[0]).toMatchObject({ domain: "news.jp", publishedAt: "2026-10-13T10:00:00.000Z" });
  });

  it("keeps everything when occurredAt is unknown", async () => {
    const out = await findArticlesForEvent({ type: "earthquake", locationText: "Kushiro, Japan" }, { searchArticles: async () => raw });
    expect(out).toHaveLength(3);
  });

  it("propagates search errors so the service can mark the cache stale", async () => {
    await expect(
      findArticlesForEvent({ type: "flood", locationText: "Nepal" }, { searchArticles: async () => { throw new GdeltError("x", "rate-limit", 429); } })
    ).rejects.toBeInstanceOf(GdeltError);
  });
});

describe("gdeltRequest", () => {
  const response = (status, body, ok = status < 400) => ({ status, ok, text: async () => body });

  it("returns parsed JSON on success and [] articles for an empty object", async () => {
    const data = await gdeltRequest("u", { fetchImpl: async () => response(200, '{"articles":[{"url":"https://a"}]}') });
    expect(data.articles).toHaveLength(1);
    expect(await gdeltRequest("u", { fetchImpl: async () => response(200, "{}") })).toEqual({});
  });

  it("throws a typed error on 429 with the plain-text body", async () => {
    const err = await gdeltRequest("u", { fetchImpl: async () => response(429, "Please limit requests to one every 5 seconds") }).catch((e) => e);
    expect(err).toBeInstanceOf(GdeltError);
    expect(err.kind).toBe("rate-limit");
    expect(err.status).toBe(429);
  });

  it("throws on a non-JSON 200 body and on other HTTP errors", async () => {
    const nonJson = await gdeltRequest("u", { fetchImpl: async () => response(200, "<html>busy</html>") }).catch((e) => e);
    expect(nonJson.kind).toBe("non-json");
    const http = await gdeltRequest("u", { fetchImpl: async () => response(503, "down") }).catch((e) => e);
    expect(http.kind).toBe("http");
  });

  it("aborts after the timeout", async () => {
    const fetchImpl = (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const err = await gdeltRequest("u", { fetchImpl, timeoutMs: 20 }).catch((e) => e);
    expect(err.kind).toBe("timeout");
  });

  it("builds English-only, time-boxed article-list urls", () => {
    const url = new URL(buildGdeltUrl({ query: "flood Nepal sourcelang:english", maxRecords: 8 }));
    expect(url.searchParams.get("mode")).toBe("ArtList");
    expect(url.searchParams.get("format")).toBe("json");
    expect(url.searchParams.get("timespan")).toBe("72h");
    expect(url.searchParams.get("maxrecords")).toBe("8");
  });
});

describe("createThrottle", () => {
  it("keeps at least the minimum gap between calls", async () => {
    let t = 0;
    const sleeps = [];
    const throttle = createThrottle({ minGapMs: 5000, now: () => t, sleep: async (ms) => { sleeps.push(ms); t += ms; } });
    await throttle(async () => { t += 100; }); // first call, no wait
    await throttle(async () => {}); // 100 ms later -> must wait 4900
    expect(sleeps).toEqual([4900]);
  });
});

describe("news service cache and stale behaviour", () => {
  const EVENTS = [
    { id: 1, type: "earthquake", severity: "high", timeMinutesAgo: 60, location: "53 km S of Kushiro, Japan", lat: 42.5, lng: 144.4, details: { cleanTitle: "M 6.1 - 53 km S of Kushiro, Japan", occurredAt: "2026-10-13T09:00:00.000Z" } },
    { id: 2, type: "flood", severity: "medium", timeMinutesAgo: 600, location: "Flood in Nepal 1104225", lat: 27.9, lng: 85.3, details: { cleanTitle: "Flood in Nepal", occurredAt: "2026-10-13T00:00:00.000Z" } },
    { id: 3, type: "wildfire", severity: "high", timeMinutesAgo: 1300, location: "Wildfire in Botswana 1032764", lat: -18, lng: 25 },
  ];
  const article = (title, url) => ({ title, url, domain: new URL(url).hostname, seendate: "20261013T120000Z" });

  it("pickTopEvents puts high severity first, then newest", () => {
    expect(pickTopEvents(EVENTS, 2).map((e) => e.id)).toEqual([1, 3]);
  });

  it("links articles to events, adds the general list and serves filters", async () => {
    const searchArticles = vi.fn(async ({ query }) => {
      if (query.includes("Kushiro")) return [article("Quake near Kushiro", "https://a.jp/1")];
      if (query.includes("Nepal")) return [article("Nepal floods", "https://b.np/2")];
      if (query.includes("Botswana")) return [];
      return [article("Disasters 2026 in review", "https://c.com/3"), article("Quake near Kushiro", "https://a.jp/1")]; // general; dup dropped
    });
    const svc = createNewsService({ gdelt: { searchArticles }, loadEvents: async () => EVENTS, now: () => new Date("2026-10-14T10:00:00Z"), log: quiet });

    expect(() => svc.getNews()).toThrow(NewsUnavailableError);
    await svc.refresh();

    const all = svc.getNews();
    expect(all.stale).toBe(false);
    expect(all.updatedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(all.items.map((a) => a.url)).toEqual(["https://a.jp/1", "https://b.np/2", "https://c.com/3"]);
    expect(all.items[0].relatedEvent).toEqual({ id: 1, type: "earthquake", severity: "high", location: "M 6.1 - 53 km S of Kushiro, Japan", lat: 42.5, lng: 144.4 });
    expect(all.items[2].relatedEvent).toBeNull();

    expect(svc.getNews({ type: "flood" }).items.map((a) => a.url)).toEqual(["https://b.np/2"]);
    expect(svc.getNews({ eventId: 1 }).items).toHaveLength(1);
    expect(svc.getNews({ type: "storm" }).items).toEqual([]);
    expect(searchArticles).toHaveBeenCalledTimes(4); // 3 events + general
  });

  it("serves the last good cache with stale: true when GDELT times out or answers non-JSON", async () => {
    let mode = "ok";
    const searchArticles = vi.fn(async () => {
      if (mode === "timeout") throw new GdeltError("timed out", "timeout");
      if (mode === "nonjson") throw new GdeltError("non-json", "non-json", 200);
      return [article("Nepal floods", "https://b.np/2")];
    });
    const svc = createNewsService({ gdelt: { searchArticles }, loadEvents: async () => EVENTS, now: () => new Date("2026-10-14T10:00:00Z"), log: quiet });
    await svc.refresh();
    expect(svc.getNews().stale).toBe(false);

    mode = "timeout";
    expect(await svc.refresh()).toBeNull();
    const stale = svc.getNews();
    expect(stale.stale).toBe(true);
    expect(stale.updatedAt).toBe("2026-10-14T10:00:00.000Z"); // unchanged
    expect(stale.items).toHaveLength(1);

    mode = "nonjson";
    await svc.refresh();
    expect(svc.getNews().stale).toBe(true);

    mode = "ok";
    await svc.refresh();
    expect(svc.getNews().stale).toBe(false);
  });

  it("throws a meaningful error when nothing was ever cached", async () => {
    const svc = createNewsService({ gdelt: { searchArticles: async () => { throw new GdeltError("rate limit", "rate-limit", 429); } }, loadEvents: async () => EVENTS, log: quiet });
    await svc.refresh();
    expect(() => svc.getNews()).toThrow(/News unavailable: all 4 GDELT searches failed \(last: rate limit\)/);
  });

  it("does not replace a good cache with an empty refresh", async () => {
    let empty = false;
    const svc = createNewsService({ gdelt: { searchArticles: async () => (empty ? [] : [article("x", "https://x.com/1")]) }, loadEvents: async () => EVENTS, log: quiet });
    await svc.refresh();
    empty = true;
    await svc.refresh();
    const res = svc.getNews();
    expect(res.items).toHaveLength(1);
    expect(res.stale).toBe(true);
  });
});
