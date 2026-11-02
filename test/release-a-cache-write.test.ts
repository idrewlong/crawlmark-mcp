/** A1: a cache write that fails (database locked) must not throw away the computed value. */
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "../src/config.js";

const { cached, cacheKey, peekCache, setCacheBusyTimeoutForTests } = await import("../src/lib/cache.js");

describe("cached() with a locked database", () => {
  const other = new DatabaseSync(join(resolve(env.DATA_DIR), "crawlmark.db"));
  afterEach(() => {
    try {
      other.exec("ROLLBACK");
    } catch {
      /* no open transaction */
    }
  });

  it("returns the computed value, reports fromCache false, and logs one line", async () => {
    setCacheBusyTimeoutForTests(50);
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const key = cacheKey("release-a-cache-write", 1);
    try {
      other.exec("BEGIN IMMEDIATE");
      const compute = vi.fn(async () => ({ answer: 42 }));
      const out = await cached(key, 60, compute);
      expect(out).toEqual({ value: { answer: 42 }, fromCache: false });
      expect(compute).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledTimes(1);
      expect(String(log.mock.calls[0]![0])).toMatch(/^crawlmark: couldn't save a cache entry \(.+\): .+/);
      other.exec("ROLLBACK");
      expect(peekCache(key)).toBeUndefined();
    } finally {
      setCacheBusyTimeoutForTests(5000);
      log.mockRestore();
    }
  });

  it("still caches normally when the write works", async () => {
    const key = cacheKey("release-a-cache-write", 2);
    expect((await cached(key, 60, async () => 7)).fromCache).toBe(false);
    expect(await cached(key, 60, async () => 8)).toEqual({ value: 7, fromCache: true });
  });
});
