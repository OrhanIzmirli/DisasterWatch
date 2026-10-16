import { describe, it, expect, vi } from "vitest";
import { createBackoffGate, BackoffError } from "../src/services/backoff.js";
import { createGdeltClient, createThrottle, GdeltError } from "../src/services/gdelt.js";
import { buildSearchPlan, linkArticlesToEvents, placeTokens, HAZARD_TERMS } from "../src/services/newsLinking.js";
import { buildGdeltGroupQuery, createGdeltProvider } from "../src/services/newsProviders/gdelt.provider.js";
import {
  buildGuardianGroupQuery,
  buildGuardianUrl,
  guardianRequest,
  normalizeGuardianResult,
  createGuardianProvider,
  GUARDIAN_GENERAL_QUERY,
  GUARDIAN_RETENTION_MS,
  GUARDIAN_REFRESH_INTERVAL_MS,
} from "../src/services/newsProviders/guardian.provider.js";
import { createNewsProviders } from "../src/services/newsProviders/index.js";
import { ProviderError } from "../src/services/newsProviders/errors.js";

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const response = (status, body, ok = status < 400) => ({ status, ok, text: async () => body });
const noWait = () => createThrottle({ minGapMs: 0, sleep: async () => {} });

describe("backoff gate (exponential, jittered, no immediate retry)", () => {
  it("closes after a failure, doubles on consecutive failures, caps at maxMs and resets on success", () => {
    let t = 0;
    const gate = createBackoffGate({ name: "X", baseMs: 1000, maxMs: 5000, jitter: 0, now: () => t, random: () => 0.5 });
    expect(gate.retryInMs()).toBe(0);
    expect(gate.failure()).toBe(1000);
    expect(() => gate.check()).toThrow(BackoffError);
    t = 999;
    expect(() => gate.check()).toThrow(/X backing off for 1 s after 1 consecutive failure/);
    t = 1000;
    expect(() => gate.check()).not.toThrow();
    expect(gate.failure()).toBe(2000); // 2nd failure
    expect(gate.failure()).toBe(4000); // 3rd
    expect(gate.failure()).toBe(5000); // capped
    gate.success();
    expect(gate.failures).toBe(0);
    expect(gate.retryInMs()).toBe(0);
  });

  it("applies +/- jitter around the exponential delay", () => {
    const low = createBackoffGate({ baseMs: 1000, jitter: 0.25, now: () => 0, random: () => 0 });
    const high = createBackoffGate({ baseMs: 1000, jitter: 0.25, now: () => 0, random: () => 1 });
    expect(low.failure()).toBe(750);
    expect(high.failure()).toBe(1250);
  });

  it("run() rejects without calling fn while closed", async () => {
    let t = 0;
    const gate = createBackoffGate({ baseMs: 1000, jitter: 0, now: () => t });
    const fn = vi.fn(async () => { throw new Error("boom"); });
    await expect(gate.run(fn)).rejects.toThrow("boom");
    await expect(gate.run(fn)).rejects.toBeInstanceOf(BackoffError);
    expect(fn).toHaveBeenCalledTimes(1);
    t = 1000;
    fn.mockImplementation(async () => "ok");
    expect(await gate.run(fn)).toBe("ok");
    expect(gate.failures).toBe(0);
  });
});

describe("GDELT client: 429 -> backoff, no immediate retry", () => {
  it("sends nothing during the backoff window and retries after it", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => response(429, "Please limit requests to one every 5 seconds"));
    const client = createGdeltClient({
      fetchImpl,
      throttle: noWait(),
      backoff: createBackoffGate({ name: "GDELT", baseMs: 30_000, jitter: 0, now: () => t }),
    });
    const first = await client.searchArticles({ query: "flood" }).catch((e) => e);
    expect(first).toBeInstanceOf(GdeltError);
    expect(first.kind).toBe("rate-limit");

    const second = await client.searchArticles({ query: "flood" }).catch((e) => e);
    expect(second.kind).toBe("backoff");
    expect(second.retryInMs).toBe(30_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1); // nothing was sent

    t = 30_000;
    fetchImpl.mockImplementation(async () => response(200, '{"articles":[{"url":"https://a","title":"x"}]}'));
    expect(await client.searchArticles({ query: "flood" })).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(client.backoff.failures).toBe(0);
  });

  it("backs off longer after each consecutive failure (timeouts count too)", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => response(503, "down"));
    const client = createGdeltClient({ fetchImpl, throttle: noWait(), backoff: createBackoffGate({ baseMs: 30_000, jitter: 0, now: () => t }) });
    await client.searchArticles({ query: "a" }).catch(() => {});
    expect(client.backoff.retryInMs()).toBe(30_000);
    t = 30_000;
    await client.searchArticles({ query: "a" }).catch(() => {});
    expect(client.backoff.retryInMs()).toBe(60_000);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("combined search plan (one query per hazard type, places OR-ed)", () => {
  const EVENTS = [
    { id: 1, type: "earthquake", locationText: "M 6.1 - 53 km S of Kushiro, Japan" },
    { id: 2, type: "flood", locationText: "Flood in Nepal 1104225" },
    { id: 3, type: "earthquake", locationText: "M 6.0 - 126 km S of Kokopo, Papua New Guinea" },
    { id: 4, type: "volcano", locationText: "Etna" }, // unsupported type: skipped
    { id: 5, type: "wildfire", locationText: "Wildfire in Botswana 1032764" },
    { id: 6, type: "storm", locationText: "Hurricane Simon" }, // 4th type: beyond the 3-query cap
    { id: 7, type: "flood", locationText: "" }, // no place: skipped
  ];

  it("groups the ranked events by type, keeps rank order and caps the number of queries", () => {
    const plan = buildSearchPlan(EVENTS);
    expect(plan.map((g) => g.type)).toEqual(["earthquake", "flood", "wildfire"]);
    expect(plan[0].places).toEqual(["Kushiro Japan", "Kokopo Papua New Guinea"]);
    expect(plan[0].events.map((e) => e.id)).toEqual([1, 3]);
    expect(plan[0].terms).toEqual(HAZARD_TERMS.earthquake);
    expect(plan[1].events.map((e) => e.id)).toEqual([2]);
    expect(buildSearchPlan(EVENTS, { maxQueries: 2 })).toHaveLength(2);
  });

  it("builds one GDELT query per group with the hazard words and all place words OR-ed", () => {
    const [quakes, floods] = buildSearchPlan(EVENTS);
    expect(buildGdeltGroupQuery(quakes)).toBe("(earthquake OR quake OR tremor) (kushiro OR japan OR kokopo OR papua OR guinea) sourcelang:english");
    expect(buildGdeltGroupQuery(floods)).toBe("(flood OR flooding OR floods) nepal sourcelang:english");
  });

  it("builds the equivalent Guardian boolean query", () => {
    const [quakes, floods] = buildSearchPlan(EVENTS);
    expect(buildGuardianGroupQuery(quakes)).toBe("(earthquake OR quake OR tremor) AND (kushiro OR japan OR kokopo OR papua OR guinea)");
    expect(buildGuardianGroupQuery(floods)).toBe("(flood OR flooding OR floods) AND (nepal)");
    expect(GUARDIAN_GENERAL_QUERY).toBe('(earthquake OR flood OR wildfire OR "forest fire" OR hurricane OR cyclone OR typhoon OR "natural disaster")');
  });

  it("placeTokens drops generic words and short tokens", () => {
    expect(placeTokens("Severe Storm, central Poland")).toEqual(["poland"]);
    expect(placeTokens("M 6.0 - 126 km S of Kokopo, Papua New Guinea")).toEqual(["kokopo", "papua", "guinea"]);
  });

  it("the GDELT provider sends the combined queries through the client", async () => {
    const searchArticles = vi.fn(async () => [{ title: "Quake", url: "https://a.jp/1", seendate: "20261013T100000Z" }]);
    const provider = createGdeltProvider({ client: { searchArticles } });
    const [quakes] = buildSearchPlan(EVENTS);
    const out = await provider.searchGroup(quakes, { maxRecords: 25 });
    expect(searchArticles).toHaveBeenCalledWith({ query: buildGdeltGroupQuery(quakes), timespan: "72h", maxRecords: 25 });
    expect(out[0]).toMatchObject({ url: "https://a.jp/1", provider: "gdelt", publishedAt: "2026-10-13T10:00:00.000Z" });
    await provider.searchGeneral({ maxRecords: 15 });
    expect(searchArticles.mock.calls[1][0].query).toMatch(/^\(earthquake OR flood .* sourcelang:english$/);
  });
});

describe("linkArticlesToEvents (article-event matching on our side)", () => {
  const quakes = [
    { id: 1, type: "earthquake", locationText: "53 km S of Kushiro, Japan" },
    { id: 3, type: "earthquake", locationText: "M 6.0 - 126 km S of Kokopo, Papua New Guinea" },
  ];

  it("links by place words in the title or the URL path, most matches win, ties go to the better-ranked event", () => {
    const out = linkArticlesToEvents(
      [
        { title: "Powerful quake hits Hokkaido coast near Kushiro", url: "https://a.jp/1" },
        { title: "Tsunami advisory lifted", url: "https://b.com/papua-new-guinea-quake-kokopo" }, // only the url mentions the place
        { title: "Japan and Papua New Guinea both shaken this week", url: "https://c.com/x" }, // japan=1 vs papua+guinea=2 -> PNG
        { title: "Earthquake safety tips", url: "https://d.com/tips" }, // nothing
      ],
      quakes
    );
    expect(out.map((a) => a.event?.id ?? null)).toEqual([1, 3, 3, null]);
  });

  it("matches whole words only and ignores case", () => {
    const out = linkArticlesToEvents([{ title: "JAPANESE markets rally", url: "https://x" }, { title: "Tokyo, JAPAN: tremor felt", url: "https://y" }], quakes);
    expect(out.map((a) => a.event?.id ?? null)).toEqual([null, 1]);
  });

  it("with single, links a one-event group's unplaced articles to that event (the query already matched its place)", () => {
    const nepal = [{ id: 2, type: "flood", locationText: "Flood in Nepal 1104225" }];
    const out = linkArticlesToEvents([{ title: "Monsoon death toll rises as rivers burst banks", url: "https://n.com/1" }], nepal, { single: true });
    expect(out[0].event?.id).toBe(2);
    const multi = linkArticlesToEvents([{ title: "Monsoon death toll rises", url: "https://n.com/1" }], quakes, { single: true });
    expect(multi[0].event).toBeNull();
  });

  it("with requireHazard (general search), the article must also mention the event's hazard words", () => {
    const events = [...quakes, { id: 2, type: "flood", locationText: "Flood in Nepal 1104225" }];
    const out = linkArticlesToEvents(
      [
        { title: "Nepal floods displace thousands", url: "https://n.com/1" },
        { title: "Nepal election results", url: "https://n.com/2" }, // place but no hazard
        { title: "Kushiro tremor: rail lines inspected", url: "https://k.jp/3" },
      ],
      events,
      { requireHazard: true }
    );
    expect(out.map((a) => a.event?.id ?? null)).toEqual([2, null, 1]);
  });
});

describe("The Guardian provider", () => {
  const result = {
    id: "world/2026/oct/13/nepal-floods",
    webTitle: "Nepal floods: death toll rises as monsoon rains continue  ",
    webUrl: "https://www.theguardian.com/world/2026/oct/13/nepal-floods",
    webPublicationDate: "2026-10-13T10:15:00Z",
    fields: { thumbnail: "https://media.guim.co.uk/x.jpg" },
  };

  it("keeps the headline and link exactly as supplied, sets the domain and never an image", () => {
    const a = normalizeGuardianResult(result);
    expect(a).toEqual({
      title: "Nepal floods: death toll rises as monsoon rains continue  ",
      url: "https://www.theguardian.com/world/2026/oct/13/nepal-floods",
      domain: "theguardian.com",
      publishedAt: "2026-10-13T10:15:00.000Z",
      image: null,
      provider: "guardian",
      summary: null,
      tagPlace: null,
    });
    expect(normalizeGuardianResult({ webTitle: "no url" })).toBeNull();
  });

  it("builds a keyed, newest-first, time-boxed search url", () => {
    const url = new URL(buildGuardianUrl({ q: "(flood) AND (nepal)", apiKey: "k", pageSize: 20, now: new Date("2026-10-14T10:00:00Z") }));
    expect(url.origin + url.pathname).toBe("https://content.guardianapis.com/search");
    expect(url.searchParams.get("q")).toBe("(flood) AND (nepal)");
    expect(url.searchParams.get("order-by")).toBe("newest");
    expect(url.searchParams.get("from-date")).toBe("2026-10-11");
    expect(url.searchParams.get("page-size")).toBe("20");
    expect(url.searchParams.get("api-key")).toBe("k");
  });

  it("maps HTTP failures to typed errors", async () => {
    const quota = await guardianRequest("u", { fetchImpl: async () => response(429, "rate limit") }).catch((e) => e);
    expect(quota).toBeInstanceOf(ProviderError);
    expect(quota.kind).toBe("rate-limit");
    const auth = await guardianRequest("u", { fetchImpl: async () => response(403, "invalid key") }).catch((e) => e);
    expect(auth.kind).toBe("auth");
    const nonJson = await guardianRequest("u", { fetchImpl: async () => response(200, "<html>") }).catch((e) => e);
    expect(nonJson.kind).toBe("non-json");
    const ok = await guardianRequest("u", { fetchImpl: async () => response(200, JSON.stringify({ response: { status: "ok", results: [result] } })) });
    expect(ok.results).toHaveLength(1);
  });

  it("searches with the combined query, respects the budget settings and backs off after a failure", async () => {
    let t = 0;
    const fetchImpl = vi.fn(async () => response(200, JSON.stringify({ response: { results: [result] } })));
    const provider = createGuardianProvider({
      apiKey: "k",
      fetchImpl,
      throttle: noWait(),
      backoff: createBackoffGate({ baseMs: 30_000, jitter: 0, now: () => t }),
      now: () => new Date("2026-10-14T10:00:00Z"),
    });
    expect(provider.refreshIntervalMs).toBe(GUARDIAN_REFRESH_INTERVAL_MS);
    expect(provider.retentionMs).toBe(GUARDIAN_RETENTION_MS);
    expect(GUARDIAN_REFRESH_INTERVAL_MS).toBe(30 * 60_000);
    expect(GUARDIAN_RETENTION_MS).toBe(24 * 3600_000);

    const group = { type: "flood", terms: HAZARD_TERMS.flood, places: ["Nepal"], events: [] };
    const out = await provider.searchGroup(group, { maxRecords: 20 });
    expect(out[0].provider).toBe("guardian");
    const sent = new URL(fetchImpl.mock.calls[0][0]);
    expect(sent.searchParams.get("q")).toBe("(flood OR flooding OR floods) AND (nepal)");
    expect(sent.searchParams.get("api-key")).toBe("k");

    fetchImpl.mockImplementation(async () => response(429, "quota"));
    await expect(provider.searchGeneral()).rejects.toMatchObject({ kind: "rate-limit" });
    await expect(provider.searchGeneral()).rejects.toMatchObject({ kind: "backoff" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("requires an api key", () => {
    expect(() => createGuardianProvider({})).toThrow(/apiKey/);
  });
});

describe("provider list", () => {
  it("is GDELT + GDACS without GUARDIAN_API_KEY, GDELT + The Guardian + GDACS with it, no GDACS with DISABLE_GDACS=1", () => {
    const gdelt = createGdeltProvider({ client: { searchArticles: async () => [] } });
    expect(createNewsProviders({ env: {}, gdelt, log: quiet }).map((p) => p.name)).toEqual(["gdelt", "gdacs"]);
    expect(createNewsProviders({ env: { GUARDIAN_API_KEY: "   " }, gdelt, log: quiet }).map((p) => p.name)).toEqual(["gdelt", "gdacs"]);
    expect(quiet.log).toHaveBeenCalledWith(expect.stringMatching(/GUARDIAN_API_KEY not set/));
    expect(createNewsProviders({ env: { GUARDIAN_API_KEY: "k" }, gdelt, log: quiet }).map((p) => p.name)).toEqual(["gdelt", "guardian", "gdacs"]);
    expect(createNewsProviders({ env: { GUARDIAN_API_KEY: "k", DISABLE_GDACS: "1" }, gdelt, log: quiet }).map((p) => p.name)).toEqual(["gdelt", "guardian"]);
  });
});

describe("GDELT settings measured on 2026-10-16 (slow answers, frequent 429)", () => {
  it("waits 30 s for an answer and caps its backoff below the 15-minute refresh", async () => {
    const { DEFAULT_TIMEOUT_MS, GDELT_MAX_BACKOFF_MS } = await import("../src/services/gdelt.js");
    expect(DEFAULT_TIMEOUT_MS).toBe(Number(process.env.GDELT_TIMEOUT_MS) || 30000);
    expect(GDELT_MAX_BACKOFF_MS).toBeLessThan(15 * 60_000 * 0.75); // even with +25 % jitter
    const client = createGdeltClient();
    for (let i = 0; i < 10; i++) client.backoff.failure();
    expect(client.backoff.retryInMs()).toBeLessThanOrEqual(GDELT_MAX_BACKOFF_MS * 1.25);
  });

  it("spends each refresh on one broad request: no group searches, 75 records, kept 72 h", async () => {
    const FEED = [{ id: 1, type: "earthquake", severity: "high", timeMinutesAgo: 60, location: "53 km S of Kushiro, Japan", details: { cleanTitle: "M 6.1 - 53 km S of Kushiro, Japan" } }];
    const searchArticles = vi.fn(async () => [{ title: "Quake rattles Hokkaido", url: "https://a.jp/1", seendate: "20261013T100000Z" }]);
    const gdelt = createGdeltProvider({ client: { searchArticles } });
    expect(gdelt.maxGroupSearches).toBe(0);
    expect(gdelt.retentionMs).toBe(72 * 3600_000);
    const { createNewsService } = await import("../src/services/news.service.js");
    const { createMemoryNewsStore } = await import("../src/services/newsStore.js");
    const svc = createNewsService({ providers: [gdelt], store: createMemoryNewsStore(), loadEvents: async () => FEED, now: () => new Date("2026-10-13T12:00:00Z"), log: quiet });
    await svc.refresh();
    expect(searchArticles).toHaveBeenCalledTimes(1);
    expect(searchArticles.mock.calls[0][0].maxRecords).toBe(75);
    expect(svc.getNews().items.map((a) => a.title)).toEqual(["Quake rattles Hokkaido"]);
  });
});
