/**
 * Durable GDACS lookups (table GdacsCache), so a restarted backend starts
 * with the levels and points it already knew.
 *
 *   load(now)        -> [{ key, value, place, fetchedAt }]   (rows older than maxAgeMs are deleted first)
 *   save(entries)    -> writes or replaces the given entries
 *
 * `value` is { level, score, text } | null and `place` { countries, lat, lng },
 * the same shapes the GDACS client keeps in memory; `fetchedAt` is in ms.
 * createMemoryGdacsStore() has the same interface for unit tests.
 */
import prisma from "../prisma.js";

/** Rows older than this are deleted on load: EONET's window is 30 days, older events are no longer listed. */
export const GDACS_STORE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SAVE_CHUNK = 200;

function toRow({ key, value, place, fetchedAt }) {
  return {
    key,
    level: value?.level ?? null,
    score: value?.score ?? null,
    text: value?.text ?? null,
    countries: (place?.countries ?? []).join(","),
    lat: place?.lat ?? null,
    lng: place?.lng ?? null,
    fetchedAt: new Date(fetchedAt),
  };
}

function fromRow(row) {
  return {
    key: row.key,
    value: row.level ? { level: row.level, score: row.score ?? null, text: row.text ?? null } : null,
    place: { countries: row.countries ? row.countries.split(",") : [], lat: row.lat ?? null, lng: row.lng ?? null },
    fetchedAt: row.fetchedAt.getTime(),
  };
}

export function createPrismaGdacsStore(db = prisma, { maxAgeMs = GDACS_STORE_MAX_AGE_MS } = {}) {
  return {
    async load(now = Date.now()) {
      await db.gdacsCache.deleteMany({ where: { fetchedAt: { lt: new Date(now - maxAgeMs) } } });
      return (await db.gdacsCache.findMany()).map(fromRow);
    },
    async save(entries) {
      const rows = entries.map(toRow);
      for (let i = 0; i < rows.length; i += SAVE_CHUNK) {
        const chunk = rows.slice(i, i + SAVE_CHUNK);
        // replace: delete and insert in one transaction (skipDuplicates covers a concurrent save of the same key)
        await db.$transaction([
          db.gdacsCache.deleteMany({ where: { key: { in: chunk.map((r) => r.key) } } }),
          db.gdacsCache.createMany({ data: chunk, skipDuplicates: true }),
        ]);
      }
    },
  };
}

export function createMemoryGdacsStore({ maxAgeMs = GDACS_STORE_MAX_AGE_MS } = {}) {
  const rows = new Map();
  return {
    rows,
    async load(now = Date.now()) {
      for (const [key, row] of rows) if (row.fetchedAt.getTime() < now - maxAgeMs) rows.delete(key);
      return [...rows.values()].map(fromRow);
    },
    async save(entries) {
      for (const e of entries) rows.set(e.key, toRow(e));
    },
  };
}
