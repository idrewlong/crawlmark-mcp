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
  setStmt.run(key, JSON.stringify(value), now + ttlSeconds);
  return { value, fromCache: false };
}

export function purgeExpired(): number {
  const now = Math.floor(Date.now() / 1000);
  return Number(db.prepare("DELETE FROM cache WHERE expires_at <= ?").run(now).changes);
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
