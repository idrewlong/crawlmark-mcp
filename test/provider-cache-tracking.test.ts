/**
 * Fix round: cache entries holding a unit provider's data are tracked per (key, client), so a key two clients share is
 * deleted when either is purged; a stored run report with Ahrefs figures is tracked too; tracking rows whose cache row
 * is gone are pruned; and an older single-key table is rebuilt once without losing rows.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { cacheKey, peekCache, purgeExpired, putCache, TTL } from "../src/lib/cache.js";
import { purgeProviderData, trackCacheKey } from "../src/lib/provider-data.js";
import { unitsCall } from "../src/providers/units-billing.js";
import { db, migrateProviderData } from "../src/lib/store.js";
import { storeReport } from "../src/reports/templates/run.js";
import type { TemplateReport } from "../src/reports/report-types.js";

const tracked = (key: string) => db.prepare("SELECT client FROM provider_cache_keys WHERE key = ? ORDER BY client").all(key).map((r) => (r as { client: string }).client);

describe("a cache key shared by two clients", () => {
  it("keeps one tracking row per client, and a purge of either deletes the entry", () => {
    const key = cacheKey("seo", "ahrefs", "shared", { x: 1 });
    putCache(key, TTL.day, { v: 1 });
    trackCacheKey("ahrefs", "a.example.com", key);
    trackCacheKey("ahrefs", "b.example.com", key);
    trackCacheKey("ahrefs", "b.example.com", key); // idempotent
    expect(tracked(key)).toEqual(["a.example.com", "b.example.com"]);
    expect(purgeProviderData("ahrefs", "a.example.com")).toMatchObject({ cacheEntries: 1 });
    expect(peekCache(key)).toBeUndefined();
    expect(tracked(key)).toEqual([]);
  });
});

describe("tracking rows are pruned with their cache rows", () => {
  it("purgeExpired drops rows whose cache entry is gone and keeps live ones", () => {
    const live = cacheKey("seo", "ahrefs", "live", 1);
    const gone = cacheKey("seo", "ahrefs", "gone", 1);
    putCache(live, TTL.day, 1);
    trackCacheKey("ahrefs", "p.example.com", live);
    trackCacheKey("ahrefs", "p.example.com", gone); // never cached, or already expired and removed
    purgeExpired();
    expect(tracked(live)).toEqual(["p.example.com"]);
    expect(tracked(gone)).toEqual([]);
  });
});

describe("a stored run report with Ahrefs figures", () => {
  const report = (id: string, sections: unknown[], ahrefsUnits = 0) =>
    ({ reportId: id, client: { slug: "run.example.com", name: "Example", domain: "run.example.com" }, template: { id: "t", title: "T", source: "builtin" }, period: { current: { startDate: "2026-09-01", endDate: "2026-09-30" }, label: "September 2026", folderMonth: "2026-09", comparisons: {} }, generatedAt: "2026-10-01T00:00:00Z", sections, highlights: [], notes: [], spend: { usd: 0, units: { ahrefs: ahrefsUnits, semrush: 0 } } }) as unknown as TemplateReport;

  it("is deleted by the Ahrefs purge for its client; a report without Ahrefs data is not touched", () => {
    const withAhrefs = report("rpt_01J00000000000000000000001", [{ id: "b", type: "backlinks", data: { provider: "ahrefs", current: { backlinks: 5 } } }]);
    const without = report("rpt_01J00000000000000000000002", [{ id: "s", type: "search_overview", data: { clicks: 3 } }]);
    storeReport(withAhrefs);
    storeReport(without);
    const key = cacheKey("report-run", withAhrefs.reportId);
    expect(tracked(key)).toEqual(["run.example.com"]);
    expect(tracked(cacheKey("report-run", without.reportId))).toEqual([]);
    expect(purgeProviderData("ahrefs", "run.example.com")).toMatchObject({ cacheEntries: 1 });
    expect(peekCache(key)).toBeUndefined();
    expect(peekCache(cacheKey("report-run", without.reportId))).toBeDefined();
  });
});

describe("migrateProviderData", () => {
  it("rebuilds a table keyed by `key` alone, keeping its rows, and is then a no-op", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE provider_cache_keys (key TEXT PRIMARY KEY, provider TEXT NOT NULL, client TEXT NOT NULL)");
    old.exec("INSERT INTO provider_cache_keys VALUES ('k1', 'ahrefs', 'a.example.com')");
    migrateProviderData(old);
    old.exec("INSERT INTO provider_cache_keys VALUES ('k1', 'ahrefs', 'b.example.com')");
    expect(old.prepare("SELECT client FROM provider_cache_keys WHERE key = 'k1' ORDER BY client").all()).toEqual([{ client: "a.example.com" }, { client: "b.example.com" }]);
    migrateProviderData(old);
    expect(old.prepare("SELECT COUNT(*) AS c FROM provider_cache_keys").get()).toEqual({ c: 2 });
  });
});

describe("unitsCall re-tracks its cache key after the call", () => {
  it("a purgeExpired during the in-flight request doesn't leave the new entry untracked", async () => {
    const c = { slug: "retrack.example.com", domain: "retrack.example.com", aliases: [], monthlyUnits: { ahrefs: 1000, semrush: 1000 } };
    const key = cacheKey("seo", "ahrefs", "retrack", { x: 1 });
    await unitsCall({
      client: c,
      provider: "ahrefs",
      capability: "retrack",
      keyParts: { x: 1 },
      ttl: 3600,
      estimate: 0,
      run: async () => {
        purgeExpired(); // the key is tracked but not cached yet: the orphan prune drops its row
        expect(tracked(key)).toEqual([]);
        return { value: "v", units: 0 };
      },
    });
    expect(peekCache(key)).toBeDefined();
    expect(tracked(key)).toEqual(["retrack.example.com"]);
  });
});
