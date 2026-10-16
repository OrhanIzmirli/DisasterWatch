import { describe, it, expect, vi, beforeEach } from "vitest";
import { prisma, resetDb } from "./helpers.js";
import { createPrismaNewsStore } from "../src/services/newsStore.js";
import { createNewsService, NewsUnavailableError } from "../src/services/news.service.js";

/** NewsCache table on the real test database: survives a "restart", enforces the Guardian 24 h rule. */

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
const T0 = new Date("2026-10-14T10:00:00Z");
const EVENTS = [
  { id: 2, type: "flood", severity: "medium", timeMinutesAgo: 600, location: "Flood in Nepal 1104225", lat: 27.9, lng: 85.3, details: { cleanTitle: "Flood in Nepal", occurredAt: "2026-10-13T00:00:00.000Z" } },
];
const article = (title, url, provider) => ({ title, url, domain: new URL(url).hostname.replace(/^www\./, ""), publishedAt: "2026-10-13T12:00:00.000Z", image: null, provider });

function provider(name, { group = async () => [], general = async () => [], refreshIntervalMs = 15 * 60_000, retentionMs = null } = {}) {
  return { name, label: name === "guardian" ? "The Guardian" : "GDELT", refreshIntervalMs, retentionMs, searchGroup: vi.fn(group), searchGeneral: vi.fn(general) };
}
const gdeltOk = () =>
  provider("gdelt", {
    group: async () => [article("Nepal floods: rivers burst banks", "https://b.np/2", "gdelt")],
    general: async () => [article("Floods hit Bangladesh lowlands", "https://c.com/3", "gdelt")],
  });
const failing = (name) => provider(name, { group: async () => { throw new Error("down"); }, general: async () => { throw new Error("down"); } });

describe("NewsCache persistence", () => {
  beforeEach(async () => {
    await resetDb();
  });

  it("writes every successful refresh and serves it again after a restart", async () => {
    const svc = createNewsService({ providers: [gdeltOk()], store: createPrismaNewsStore(prisma), loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await svc.refresh();

    const rows = await prisma.newsCache.findMany({ orderBy: { position: "asc" } });
    expect(rows.map((r) => [r.url, r.provider, r.position, r.expiresAt])).toEqual([
      ["https://b.np/2", "gdelt", 0, null],
      ["https://c.com/3", "gdelt", 1, null],
    ]);
    expect(rows[0].fetchedAt.toISOString()).toBe("2026-10-14T10:00:00.000Z");
    expect(rows[0].relatedEvent).toMatchObject({ id: 2, type: "flood", location: "Flood in Nepal" });

    // restart with every provider down: the persisted cache is what users get
    const later = new Date(T0.getTime() + 3 * 60_000);
    const restarted = createNewsService({ providers: [failing("gdelt")], store: createPrismaNewsStore(prisma), loadEvents: async () => EVENTS, now: () => later, log: quiet });
    await restarted.restore();
    const beforeRefresh = restarted.getNews();
    expect(beforeRefresh.items.map((a) => a.url)).toEqual(["https://b.np/2", "https://c.com/3"]);
    expect(beforeRefresh.items[0].relatedEvent.id).toBe(2);
    expect(beforeRefresh.updatedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(beforeRefresh.stale).toBe(false);
    expect(beforeRefresh.source).toBe("GDELT");
    expect(restarted.getNews({ eventId: 2 }).items).toHaveLength(1);

    await restarted.refresh(); // fails -> same data, now flagged stale
    const afterFailure = restarted.getNews();
    expect(afterFailure.stale).toBe(true);
    expect(afterFailure.updatedAt).toBe("2026-10-14T10:00:00.000Z");
    expect(afterFailure.items).toHaveLength(2);
    expect(await prisma.newsCache.count()).toBe(2); // a failed refresh never touches the table
  });

  it("replaces the table on the next success (no leftovers from the previous refresh)", async () => {
    const store = createPrismaNewsStore(prisma);
    const a = createNewsService({ providers: [gdeltOk()], store, loadEvents: async () => EVENTS, now: () => T0, log: quiet });
    await a.refresh();
    const b = createNewsService({
      providers: [provider("gdelt", { general: async () => [article("Storm kills two as rivers rise", "https://d.com/4", "gdelt")] })],
      store,
      loadEvents: async () => EVENTS,
      now: () => new Date(T0.getTime() + 15 * 60_000),
      log: quiet,
    });
    await b.refresh();
    expect((await prisma.newsCache.findMany()).map((r) => r.url)).toEqual(["https://d.com/4"]);
  });

  it("expires Guardian rows 24 hours after the fetch and deletes them from the table", async () => {
    const guardian = provider("guardian", {
      general: async () => [article("Floods in Nepal", "https://www.theguardian.com/world/floods", "guardian")],
      refreshIntervalMs: 30 * 60_000,
      retentionMs: 24 * 3600_000,
    });
    let clock = T0;
    const store = createPrismaNewsStore(prisma);
    const svc = createNewsService({ providers: [failing("gdelt"), guardian], store, loadEvents: async () => EVENTS, now: () => clock, log: quiet });
    await svc.refresh();

    const [row] = await prisma.newsCache.findMany();
    expect(row.provider).toBe("guardian");
    expect(row.expiresAt.toISOString()).toBe("2026-10-15T10:00:00.000Z");
    expect(svc.getNews().source).toBe("The Guardian");

    clock = new Date(T0.getTime() + 23 * 3600_000);
    expect(svc.getNews().items).toHaveLength(1);
    expect(await store.purgeExpired(clock)).toBe(0);

    clock = new Date(T0.getTime() + 24 * 3600_000 + 1);
    expect(() => svc.getNews()).toThrow(NewsUnavailableError); // gone from memory
    expect(await store.purgeExpired(clock)).toBe(1); // and from the table
    expect(await prisma.newsCache.count()).toBe(0);

    // a restart after expiry restores nothing
    const restarted = createNewsService({ providers: [failing("gdelt"), guardian], store, loadEvents: async () => EVENTS, now: () => clock, log: quiet });
    expect(await restarted.restore()).toBeNull();
  });
});
