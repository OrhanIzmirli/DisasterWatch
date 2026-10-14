/**
 * Durable news cache (table NewsCache): the last successful refresh is
 * written here so a restarted backend can serve it immediately.
 *
 *   load(now)                 -> { items, fetchedAt } | null   (expired rows are deleted first)
 *   save(items, fetchedAt)    -> replaces the whole cache in one transaction
 *   purgeExpired(now)         -> number of rows deleted
 *
 * Items carry `expiresAt` (Guardian: fetchedAt + 24 h) or null.
 * createMemoryNewsStore() has the same interface for unit tests.
 */
import prisma from "../prisma.js";

function toRow(item, position, fetchedAt) {
  return {
    url: item.url,
    title: item.title,
    domain: item.domain ?? "",
    image: item.image ?? null,
    publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
    provider: item.provider,
    relatedEvent: item.relatedEvent ?? undefined,
    position,
    fetchedAt,
    expiresAt: item.expiresAt ? new Date(item.expiresAt) : null,
  };
}

function fromRow(row) {
  return {
    title: row.title,
    url: row.url,
    domain: row.domain,
    publishedAt: row.publishedAt ? row.publishedAt.toISOString() : null,
    image: row.image,
    provider: row.provider,
    relatedEvent: row.relatedEvent ?? null,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
  };
}

export function createPrismaNewsStore(db = prisma) {
  return {
    async purgeExpired(now = new Date()) {
      const { count } = await db.newsCache.deleteMany({ where: { expiresAt: { lt: now } } });
      return count;
    },
    async load(now = new Date()) {
      await this.purgeExpired(now);
      const rows = await db.newsCache.findMany({ orderBy: { position: "asc" } });
      if (rows.length === 0) return null;
      return { items: rows.map(fromRow), fetchedAt: rows[0].fetchedAt.toISOString() };
    },
    async save(items, fetchedAt) {
      const at = new Date(fetchedAt);
      await db.$transaction([
        db.newsCache.deleteMany({}),
        db.newsCache.createMany({ data: items.map((item, i) => toRow(item, i, at)), skipDuplicates: true }),
      ]);
    },
  };
}

export function createMemoryNewsStore() {
  let saved = null;
  return {
    async purgeExpired(now = new Date()) {
      if (!saved) return 0;
      const before = saved.items.length;
      saved.items = saved.items.filter((i) => !i.expiresAt || new Date(i.expiresAt) >= now);
      return before - saved.items.length;
    },
    async load(now = new Date()) {
      await this.purgeExpired(now);
      return saved && saved.items.length ? { items: saved.items.map((i) => ({ ...i })), fetchedAt: saved.fetchedAt } : null;
    },
    async save(items, fetchedAt) {
      saved = { items: items.map((i) => ({ ...i })), fetchedAt: new Date(fetchedAt).toISOString() };
    },
    get saved() {
      return saved;
    },
  };
}
