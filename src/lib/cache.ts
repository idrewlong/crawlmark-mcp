import { createHash } from "node:crypto";
import { db } from "./store.js";

export const TTL = {
  hour: 60 * 60,
  day: 24 * 60 * 60,
  week: 7 * 24 * 60 * 60,
  month: 30 * 24 * 60 * 60,
} as const;

const getStmt = db.prepare("SELECT value, expires_at FROM cache WHERE key = ?");
const setStmt = db.prepare(
  "INSERT OR REPLACE INTO cache (key, value, expires_at) VALUES (?, ?, ?)",
);

export function cacheKey(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Return a cached value if it's fresh, otherwise run `fn` and store the result.
 * Paid calls should always go through this so repeat queries cost nothing.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
  opts: { refresh?: boolean } = {},
): Promise<{ value: T; fromCache: boolean }> {
  const now = Math.floor(Date.now() / 1000);
  if (!opts.refresh) {
    const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
    if (row && row.expires_at > now) {
      return { value: JSON.parse(row.value) as T, fromCache: true };
    }
  }
  const value = await fn();
  // The value is already computed (and a paid call already billed): a cache that can't be written must not throw it away.
  try {
    setStmt.run(key, JSON.stringify(value), now + ttlSeconds);
  } catch (err) {
    const e = err as { code?: string; errcode?: number; name?: string; message?: string };
    console.error(`crawlmark: couldn't save a cache entry (${e.code ?? e.name ?? "error"}): ${e.message ?? String(err)}`);
  }
  return { value, fromCache: false };
}

export function purgeExpired(): number {
  const now = Math.floor(Date.now() / 1000);
  const removed = Number(db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now).changes);
  // Tracking rows (provider_cache_keys) whose cache row is gone have nothing left to purge.
  db.prepare("DELETE FROM provider_cache_keys WHERE key NOT IN (SELECT key FROM cache)").run();
  return removed;
}

/** Read a fresh cache entry without computing anything. */
export function peekCache<T>(key: string): T | undefined {
  const row = getStmt.get(key) as { value: string; expires_at: number } | undefined;
  return row && row.expires_at > Math.floor(Date.now() / 1000) ? (JSON.parse(row.value) as T) : undefined;
}

/** Store a value under a cache key (see cached()). */
export function putCache(key: string, ttlSeconds: number, value: unknown): void {
  setStmt.run(key, JSON.stringify(value), Math.floor(Date.now() / 1000) + ttlSeconds);
}

/** Test seam: how long a cache write waits on a locked database before giving up. */
export function setCacheBusyTimeoutForTests(ms: number): void {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(ms))}`);
}
