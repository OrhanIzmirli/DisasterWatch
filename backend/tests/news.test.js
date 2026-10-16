import { describe, it, expect, vi } from "vitest";
import { cleanLocationText, buildEventQuery, dedupeArticles, normalizeArticle, parseGdeltDate, findArticlesForEvent } from "../src/services/newsLinking.js";
import { gdeltRequest, createThrottle, buildGdeltUrl, GdeltError } from "../src/services/gdelt.js";
import { createNewsService, pickTopEvents, NewsUnavailableError, MAX_REQUESTS_PER_REFRESH } from "../src/services/news.service.js";
import { createMemoryNewsStore } from "../src/services/newsStore.js";

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

describe("news service: combined searches, merged providers, persistence and stale behaviour", () => {
  const EVENTS = [
    { id: 1, type: "earthquake", severity: "high", timeMinutesAgo: 60, location: "53 km S of Kushiro, Japan", lat: 42.5, lng: 144.4, details: { cleanTitle: "M 6.1 - 53 km S of Kushiro, Japan", occurredAt: "2026-10-13T09:00:00.000Z" } },
    { id: 2, type: "flood", severity: "medium", timeMinutesAgo: 600, location: "Flood in Nepal 1104225", lat: 27.9, lng: 85.3, details: { cleanTitle: "Flood in Nepal", occurredAt: "2026-10-13T00:00:00.000Z" } },
    { id: 3, type: "wildfire", severity: "high", timeMinutesAgo: 1300, location: "Wildfire in Botswana 1032764", lat: -18, lng: 25 },
  ];
  const T0 = new Date("2026-10-14T10:00:00Z");
  const article = (title, url, extra = {}) => ({ title, url, domain: new URL(url).hostname, publishedAt: "2026-10-13T12:00:00.000Z", image: null, ...extra });

  /** Fake provider: searchGroup/searchGeneral are vi.fn so call counts can be asserted. */
  function fakeProvider(name, { group = async () => [], general = async () => [], refreshIntervalMs = 15 * 60_000, retentionMs = null } = {}) {
    return {
      name,
      label: name === "guardian" ? "The Guardian" : "GDELT",
      refreshIntervalMs,
      retentionMs,
      searchGroup: vi.fn(group),
      searchGeneral: vi.fn(general),
    };
  }
  const gdeltOk = () =>
    fakeProvider("gdelt", {
      group: async (g) => {
        if (g.type === "earthquake") return [article("Quake near Kushiro", "https://a.jp/1", { provider: "gdelt" })];
        if (g.type === "flood") return [article("Nepal floods", "https://b.np/2", { provider: "gdelt" })];
        return [];
      },
      general: async () => [article("Earthquake swarm continues off Honshu", "https://c.com/3", { provider: "gdelt" }), article("Quake near Kushiro", "https://a.jp/1", { provider: "gdelt" })],
    });
  const failing = (name, message = "rate limit") =>
    fakeProvider(name, {
      group: async () => { throw new GdeltError(message, "rate-limit", 429); },
      general: async () => { throw new GdeltError(message, "rate-limit", 429); },
    });

  it("pickTopEvents puts high severity first, then newest", () => {
    expect(pickTopEvents(EVENTS, 2).map((e) => e.id)).toEqual([1, 3]);
  });

  it("links articles to events through combined searches, adds the general list and serves filters", async () => {
    const gdelt = gdeltOk();
    const svc = createNewsService({ providers: [gdelt], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => T0, log: quiet });

    expect(() => svc.getNews()).toThrow(NewsUnavailableError);
    await svc.refresh();

    const all = svc.getNews();
    expect(all.stale).toBe(false);
    expect(all.updatedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(all.source).toBe("GDELT");
    expect(all.provider).toBe("gdelt");
    expect(all.items.map((a) => a.url)).toEqual(["https://a.jp/1", "https://b.np/2", "https://c.com/3"]);
    expect(all.items[0].relatedEvent).toEqual({ id: 1, type: "earthquake", severity: "high", location: "M 6.1 - 53 km S of Kushiro, Japan", lat: 42.5, lng: 144.4 });
    expect(all.items[0].provider).toBe("gdelt");
    expect(all.items[2].relatedEvent).toBeNull();
    expect(all.items[0]).not.toHaveProperty("expiresAt");

    expect(svc.getNews({ type: "flood" }).items.map((a) => a.url)).toEqual(["https://b.np/2"]);
    expect(svc.getNews({ eventId: 1 }).items).toHaveLength(1);
    expect(svc.getNews({ type: "storm" }).items).toEqual([]);

    // one combined search per hazard type present, in rank order (high severity first) + general
    expect(gdelt.searchGroup).toHaveBeenCalledTimes(3);
    expect(gdelt.searchGroup.mock.calls.map(([g]) => g.type)).toEqual(["earthquake", "wildfire", "flood"]);
    expect(gdelt.searchGeneral).toHaveBeenCalledTimes(1);
  });

  it("never issues more than MAX_REQUESTS_PER_REFRESH requests, whatever the number of top events", async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({
      id: 100 + i,
      type: ["earthquake", "flood", "wildfire", "storm"][i % 4],
      severity: "high",
      timeMinutesAgo: i,
      location: `Place${i}, Country${i}`,
      lat: 0,
      lng: 0,
    }));
    const gdelt = failing("gdelt");
    const guardian = failing("guardian");
    const svc = createNewsService({ providers: [gdelt, guardian], store: createMemoryNewsStore(), loadEvents: async () => many, now: () => T0, log: quiet });
    await svc.refresh();
    expect(MAX_REQUESTS_PER_REFRESH).toBe(4);
    expect(gdelt.searchGroup.mock.calls.length + gdelt.searchGeneral.mock.calls.length).toBe(4);
    expect(guardian.searchGroup.mock.calls.length + guardian.searchGeneral.mock.calls.length).toBe(4);
  });

  it("serves The Guardian when GDELT fails, without waiting for GDELT (merged, not failover)", async () => {
    const gdelt = failing("gdelt");
    const guardian = fakeProvider("guardian", {
      group: async (g) => (g.type === "flood" ? [article("Nepal monsoon floods", "https://www.theguardian.com/world/nepal-floods", { provider: "guardian" })] : []),
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
    });
    const store = createMemoryNewsStore();
    const svc = createNewsService({ providers: [gdelt, guardian], store, loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await svc.refresh();

    const res = svc.getNews();
    expect(res.source).toBe("The Guardian");
    expect(res.provider).toBe("guardian");
    expect(res.stale).toBe(false);
    expect(res.items).toHaveLength(1);
    expect(res.items[0].relatedEvent?.id).toBe(2);
    // the loop ticks at the shortest provider interval; each provider only runs when its own interval has passed
    expect(svc.nextIntervalMs()).toBe(15 * 60_000);
    // persisted with the licence expiry
    expect(store.saved.items[0].expiresAt).toBe("2026-10-15T10:00:00.000Z");
    // /health tells why GDELT contributed nothing
    expect(svc.status().providers.gdelt).toMatchObject({ articles: 0, lastErrorKind: "rate-limit", lastSuccessAt: null });
    expect(svc.status().providers.guardian).toMatchObject({ articles: 1, lastError: null });
  });

  it("merges GDELT and Guardian articles, and keeps a provider's previous articles when it fails later", async () => {
    let gdeltDown = false;
    const gdelt = fakeProvider("gdelt", {
      general: async () => {
        if (gdeltDown) throw new GdeltError("rate limit", "rate-limit", 429);
        return [article("Flood watch issued for Nepal valleys", "https://x.com/1", { provider: "gdelt", publishedAt: "2026-10-13T08:00:00.000Z" })];
      },
    });
    const guardian = fakeProvider("guardian", {
      general: async () => [article("Earthquake shakes Hokkaido", "https://www.theguardian.com/world/2", { provider: "guardian", publishedAt: "2026-10-13T09:00:00.000Z" })],
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
    });
    const svc = createNewsService({ providers: [gdelt, guardian], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await svc.refresh();
    let res = svc.getNews();
    expect(res.provider).toBe("gdelt+guardian");
    expect(res.source).toBe("GDELT + The Guardian");
    expect(res.items.map((a) => a.provider).sort()).toEqual(["gdelt", "guardian"]);

    gdeltDown = true;
    await svc.refresh();
    res = svc.getNews();
    expect(res.items.map((a) => a.url).sort()).toEqual(["https://www.theguardian.com/world/2", "https://x.com/1"]);
    expect(res.stale).toBe(false); // The Guardian refreshed
    expect(svc.status().providers.gdelt.lastErrorKind).toBe("rate-limit");
    expect(svc.status().providers.gdelt.articles).toBe(1);
  });

  it("in the background loop runs each provider only when its own interval has passed", async () => {
    let t = T0;
    const gdelt = fakeProvider("gdelt", { general: async () => [article("Quake near Kushiro", "https://a.jp/1", { provider: "gdelt" })] });
    const guardian = fakeProvider("guardian", {
      general: async () => [article("Nepal floods", "https://www.theguardian.com/world/3", { provider: "guardian" })],
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
    });
    const svc = createNewsService({ providers: [gdelt, guardian], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => t, log: quiet });
    await svc.refresh({ onlyDue: true });
    t = new Date(T0.getTime() + 15 * 60_000);
    await svc.refresh({ onlyDue: true });
    expect(gdelt.searchGeneral).toHaveBeenCalledTimes(2);
    expect(guardian.searchGeneral).toHaveBeenCalledTimes(1);
    t = new Date(T0.getTime() + 30 * 60_000);
    await svc.refresh({ onlyDue: true });
    expect(gdelt.searchGeneral).toHaveBeenCalledTimes(3);
    expect(guardian.searchGeneral).toHaveBeenCalledTimes(2);
  });

  it("serves the last good cache with stale: true when every provider fails, and recovers", async () => {
    let mode = "ok";
    const gdelt = fakeProvider("gdelt", {
      group: async () => {
        if (mode === "timeout") throw new GdeltError("timed out", "timeout");
        if (mode === "nonjson") throw new GdeltError("non-json", "non-json", 200);
        return [];
      },
      general: async () => {
        if (mode !== "ok") throw new GdeltError("down", mode);
        return [article("Nepal floods", "https://b.np/2", { provider: "gdelt" })];
      },
    });
    const svc = createNewsService({ providers: [gdelt], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => T0, log: quiet });
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

  it("explains which providers failed when nothing was ever cached", async () => {
    const svc = createNewsService({ providers: [failing("gdelt", "rate limit"), failing("guardian", "quota")], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await svc.refresh();
    expect(() => svc.getNews()).toThrow(/News unavailable: GDELT: all 4 searches failed \(last: rate limit\); The Guardian: all 4 searches failed \(last: quota\)/);
  });

  it("does not replace a good cache with an empty refresh", async () => {
    let empty = false;
    const gdelt = fakeProvider("gdelt", { general: async () => (empty ? [] : [article("Flood watch", "https://x.com/1", { provider: "gdelt" })]) });
    const svc = createNewsService({ providers: [gdelt], store: createMemoryNewsStore(), loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await svc.refresh();
    empty = true;
    await svc.refresh();
    const res = svc.getNews();
    expect(res.items).toHaveLength(1);
    expect(res.stale).toBe(true);
  });

  it("restores the persisted cache on start-up, with a correct 'last updated' and stale flag", async () => {
    const store = createMemoryNewsStore();
    const first = createNewsService({ providers: [gdeltOk()], store, loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await first.refresh();

    // "restart": a new service instance sharing only the store
    let clock = new Date(T0.getTime() + 5 * 60_000);
    const second = createNewsService({ providers: [gdeltOk()], store, loadEvents: async () => EVENTS, now: () => clock, log: quiet });
    expect(() => second.getNews()).toThrow(NewsUnavailableError);
    await second.restore();
    const res = second.getNews();
    expect(res.items.map((a) => a.url)).toEqual(["https://a.jp/1", "https://b.np/2", "https://c.com/3"]);
    expect(res.items[0].relatedEvent?.id).toBe(1);
    expect(res.updatedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(res.stale).toBe(false); // 5 minutes old, within one refresh interval

    clock = new Date(T0.getTime() + 40 * 60_000);
    expect(second.getNews().stale).toBe(true); // older than the interval and not refreshed in this process yet
  });

  it("drops Guardian articles 24 hours after they were fetched (licence), in memory and in the store", async () => {
    const guardian = fakeProvider("guardian", {
      general: async () => [article("Floods", "https://www.theguardian.com/world/floods", { provider: "guardian" })],
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
    });
    const store = createMemoryNewsStore();
    let clock = T0;
    const svc = createNewsService({ providers: [failing("gdelt"), guardian], store, loadEvents: async () => EVENTS, now: () => clock, log: quiet });
    await svc.refresh();
    expect(svc.getNews().items).toHaveLength(1);

    clock = new Date(T0.getTime() + 24 * 3600_000 + 1000);
    expect(() => svc.getNews()).toThrow(NewsUnavailableError);
    expect(svc.status().articles).toBe(0);

    const fresh = createNewsService({ providers: [failing("gdelt"), guardian], store, loadEvents: async () => EVENTS, now: () => clock, log: quiet });
    expect(await fresh.restore()).toBeNull();
    expect(await store.load(clock)).toBeNull();
  });
});
