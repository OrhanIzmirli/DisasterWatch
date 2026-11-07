/**
 * Public API keys (optional; without one the API allows 60 requests a minute per IP).
 *
 *  - A key is "dwk_" + 32 random bytes in base64url. Only its SHA-256 hash and
 *    its first 12 characters (the prefix, for the owner to tell keys apart) are
 *    stored; the key itself is returned once, when it is created.
 *  - SHA-256 rather than a slow password hash: the key carries 256 bits of
 *    randomness, so it cannot be guessed from its hash, and the lookup runs on
 *    every API request.
 *  - Lookups are cached in memory for CACHE_MS (also misses, so a flood of
 *    wrong keys does not reach the database); revoking through this module
 *    drops the cached entry at once (one backend instance).
 *  - lastUsedAt is written at most once per LAST_USED_WRITE_MS per key, so
 *    API traffic does not turn into database writes.
 */
import crypto from "node:crypto";
import defaultPrisma from "../prisma.js";

export const KEY_PREFIX = "dwk_";
export const KEY_PATTERN = /^dwk_[A-Za-z0-9_-]{43}$/;
export const SHOWN_PREFIX_LENGTH = 12;
export const CACHE_MS = 60 * 1000;
export const LAST_USED_WRITE_MS = 60 * 60 * 1000;
const CACHE_MAX = 5000;

export const hashKey = (key) => crypto.createHash("sha256").update(key, "utf8").digest("hex");

export function generateKey() {
  const key = KEY_PREFIX + crypto.randomBytes(32).toString("base64url");
  return { key, hash: hashKey(key), prefix: key.slice(0, SHOWN_PREFIX_LENGTH) };
}

export function createKeyStore({ prisma = defaultPrisma, now = () => Date.now(), log = console } = {}) {
  /** hash -> { keyId: number | null, until } */
  const cache = new Map();
  /** keyId -> last time lastUsedAt was written */
  const lastWrite = new Map();

  function remember(hash, keyId) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value); // oldest first
    cache.set(hash, { keyId, until: now() + CACHE_MS });
  }

  function touch(keyId) {
    const t = now();
    if (t - (lastWrite.get(keyId) ?? 0) < LAST_USED_WRITE_MS) return;
    lastWrite.set(keyId, t);
    prisma.apiKey.update({ where: { id: keyId }, data: { lastUsedAt: new Date(t) } }).catch((err) => log.warn(`[api-keys] lastUsedAt not written: ${err?.message}`));
  }

  /**
   * The key's id when it is well-formed, known and not revoked; null otherwise.
   * Throws only when the database cannot be reached for an uncached key.
   */
  async function verify(key) {
    if (typeof key !== "string" || !KEY_PATTERN.test(key)) return null;
    const hash = hashKey(key);
    const hit = cache.get(hash);
    let keyId;
    if (hit && hit.until > now()) {
      keyId = hit.keyId;
    } else {
      const row = await prisma.apiKey.findUnique({ where: { hash }, select: { id: true, revokedAt: true } });
      keyId = row && !row.revokedAt ? row.id : null;
      remember(hash, keyId);
    }
    if (keyId !== null) touch(keyId);
    return keyId;
  }

  /** Revokes the developer's active keys and returns a new one (shown once). */
  async function issue(developerId) {
    const { key, hash, prefix } = generateKey();
    const created = await prisma.$transaction(async (tx) => {
      const active = await tx.apiKey.findMany({ where: { developerId, revokedAt: null }, select: { hash: true } });
      await tx.apiKey.updateMany({ where: { developerId, revokedAt: null }, data: { revokedAt: new Date(now()) } });
      for (const k of active) cache.delete(k.hash);
      return tx.apiKey.create({ data: { developerId, hash, prefix }, select: { prefix: true, createdAt: true } });
    });
    return { key, prefix: created.prefix, createdAt: created.createdAt };
  }

  /** Revokes the developer's active key(s); returns how many. */
  async function revoke(developerId) {
    const active = await prisma.apiKey.findMany({ where: { developerId, revokedAt: null }, select: { hash: true } });
    for (const k of active) cache.delete(k.hash);
    const { count } = await prisma.apiKey.updateMany({ where: { developerId, revokedAt: null }, data: { revokedAt: new Date(now()) } });
    return count;
  }

  /** The developer's active key without its secret part, or null. */
  async function active(developerId) {
    return prisma.apiKey.findFirst({
      where: { developerId, revokedAt: null },
      select: { prefix: true, createdAt: true, lastUsedAt: true },
      orderBy: { createdAt: "desc" },
    });
  }

  /** Drops cached lookups (account deletion, tests). */
  function forgetAll() {
    cache.clear();
    lastWrite.clear();
  }

  return { verify, issue, revoke, active, forgetAll };
}

export const keyStore = createKeyStore();
