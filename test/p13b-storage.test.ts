/**
 * Phase 13 B: the Ahrefs storage decision. Ahrefs aggregates kept 25 months, Semrush 31 days; a purge (CLI, removed
 * client, removed key) deletes a provider's snapshots, its Site Audit items in issue snapshots and its tracked cache
 * entries, and nothing else. Temp SQLite from test/setup.ts; no network.
 */
import { describe, expect, it } from "vitest";
import { dataCommand } from "../src/data-cli.js";
import { cacheKey, peekCache, putCache } from "../src/lib/cache.js";
import { saveIssueSnapshot, latestIssueSnapshotBefore } from "../src/lib/issue-snapshots.js";
import { purgeProviderData, reconcileRemovedKeys, trackCacheKey } from "../src/lib/provider-data.js";
import { ahrefsOldestDay, nearestSnapshot, saveSnapshot } from "../src/lib/snapshots.js";
import { db } from "../src/lib/store.js";
import { unitsCall } from "../src/providers/units-billing.js";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const DAY = 86_400_000;
const fig = { keywords: 10, top3: 1, pos4_10: 2, pos11_20: 3, pos21_100: 4, traffic: 50, trafficLabel: "x" };
const count = (where: string, ...args: (string | number)[]) => Number((db.prepare(`SELECT COUNT(*) AS n FROM seo_snapshots WHERE ${where}`).get(...args) as { n: number }).n);

describe("retention", () => {
  it("Ahrefs rows about days older than 25 months are deleted; newer ones and DataForSEO rows are kept", () => {
    const client = "keep.example.com";
    expect(ahrefsOldestDay(NOW)).toBe("2024-09-01");
    for (const [provider, day] of [["ahrefs", "2024-08-01"], ["ahrefs", "2024-09-01"], ["dataforseo", "2024-01-01"]] as const) {
      saveSnapshot({ client, kind: "visibility", target: "example.com", provider, market: "us", day, source: "provider_history", capturedAt: NOW, data: fig }, NOW);
    }
    expect(count("client = ? AND provider = 'ahrefs'", client)).toBe(1);
    expect(count("client = ? AND provider = 'dataforseo'", client)).toBe(1);
  });

  it("Semrush rows are still deleted 31 days after capture", () => {
    const client = "semrush-keep.example.com";
    saveSnapshot({ client, kind: "visibility", target: "example.com", provider: "semrush", market: "us", day: "2026-09-01", source: "live", capturedAt: NOW - 32 * DAY, data: fig }, NOW - 32 * DAY);
    expect(nearestSnapshot({ client, kind: "visibility", target: "example.com", provider: "semrush", market: "us", day: "2026-09-01", toleranceDays: 5 }, NOW)).toBeUndefined();
  });
});

describe("purge", () => {
  it("deletes one client's Ahrefs snapshots, Site Audit items and tracked cache entries; leaves other providers and clients alone", async () => {
    const a = "purge-a.example.com";
    const b = "purge-b.example.com";
    for (const client of [a, b]) {
      saveSnapshot({ client, kind: "backlinks", target: "example.com", provider: "ahrefs", market: "global", day: "2026-10-01", source: "live", capturedAt: NOW, data: { referringDomains: 3 } }, NOW);
      saveSnapshot({ client, kind: "backlinks", target: "example.com", provider: "dataforseo", market: "global", day: "2026-10-01", source: "live", capturedAt: NOW, data: { referringDomains: 4 } }, NOW);
    }
    const src = (source: string) => ({ source, rule: "r", nativeSeverity: "high", count: 2, examples: [] });
    saveIssueSnapshot({
      id: "iss_01PURGE0000000000000000000",
      client: a,
      capturedAt: NOW,
      items: [
        { key: "only-ahrefs", title: "t", category: "c", severity: "high", url: null, affected: 2, sources: [src("ahrefs_site_audit")] },
        { key: "both", title: "t", category: "c", severity: "high", url: null, affected: 2, sources: [src("ahrefs_site_audit"), src("local_crawl")] },
      ] as never,
      checked: [{ source: "ahrefs_site_audit", runId: "1", ranAt: "2026-10-01T00:00:00Z", stale: false }, { source: "local_crawl", runId: "c", ranAt: "2026-10-01T00:00:00Z", stale: false }],
      settings: { sources: ["ahrefs_site_audit", "local_crawl"], maxAgeDays: 45 },
    });
    // A unit call's cache entry is tracked under its provider and client.
    const c = { slug: a, domain: a, aliases: [], monthlyUnits: { ahrefs: 1000, semrush: 1000 } };
    await unitsCall({ client: c, provider: "ahrefs", capability: "purge-test", keyParts: { x: 1 }, ttl: 3600, estimate: 0, run: async () => ({ value: "v", units: 0 }) });
    const key = cacheKey("seo", "ahrefs", "purge-test", { x: 1 });
    expect(peekCache(key)).toEqual({ value: "v", units: 0 });
    const other = cacheKey("other");
    putCache(other, 3600, "keep");

    const r = purgeProviderData("ahrefs", a);
    expect(r).toEqual({ provider: "ahrefs", client: a, snapshots: 1, issueSnapshotsEdited: 1, cacheEntries: 1 });
    expect(count("client = ? AND provider = 'ahrefs'", a)).toBe(0);
    expect(count("client = ? AND provider = 'ahrefs'", b)).toBe(1);
    expect(count("client = ? AND provider = 'dataforseo'", a)).toBe(1);
    expect(peekCache(key)).toBeUndefined();
    expect(peekCache(other)).toBe("keep");
    const snap = latestIssueSnapshotBefore(a, NOW + 1)!;
    expect(snap.items.map((i) => [i.key, i.sources.map((s) => s.source)])).toEqual([["both", ["local_crawl"]]]);
    expect(snap.checked.map((x) => x.source)).toEqual(["local_crawl"]);
    // Idempotent.
    expect(purgeProviderData("ahrefs", a)).toMatchObject({ snapshots: 0, cacheEntries: 0 });
  });
});

describe("removed Ahrefs key (test env has no AHREFS_API_KEY)", () => {
  const mark = (source: string, entry: string) => db.prepare("INSERT OR REPLACE INTO provider_data_marks (provider, key_source, entry, updated_at) VALUES ('ahrefs', ?, ?, 0)").run(source, entry);
  const seed = () => saveSnapshot({ client: "key.example.com", kind: "backlinks", target: "example.com", provider: "ahrefs", market: "global", day: "2026-10-01", source: "live", capturedAt: NOW, data: {} }, NOW);

  it("a key that came from the .env file: removed for every process, so stored Ahrefs data is purged", () => {
    seed();
    mark("envfile", "cli");
    expect(reconcileRemovedKeys("cli")).toMatchObject({ provider: "ahrefs", client: null });
    expect(count("provider = 'ahrefs'")).toBe(0);
    expect(db.prepare("SELECT 1 FROM provider_data_marks WHERE provider = 'ahrefs'").get()).toBeUndefined();
  });

  it("a key from the MCP server's own environment: only the MCP server can tell it's gone; a CLI run never purges", () => {
    seed();
    mark("process", "mcp");
    expect(reconcileRemovedKeys("cli")).toBeNull();
    expect(count("provider = 'ahrefs'")).toBe(1);
    expect(reconcileRemovedKeys("mcp")).not.toBeNull();
    expect(count("provider = 'ahrefs'")).toBe(0);
    seed();
    mark("process", "cli");
    expect(reconcileRemovedKeys("cli")).toBeNull();
    purgeProviderData("ahrefs");
  });

  it("no mark: nothing happens", () => {
    expect(reconcileRemovedKeys("mcp")).toBeNull();
  });
});

describe("crawlmark-cli data purge", () => {
  const io = () => {
    const lines: string[] = [];
    const errs: string[] = [];
    return { lines, errs, io: { out: (l: string) => void lines.push(l), warn: (l: string) => void errs.push(l), usage: (p: string) => (errs.push(p), 2) } };
  };
  const deps = { resolveClient: async (id: string) => ({ slug: id, domain: id }), purge: purgeProviderData };

  it("needs purge and a known --provider", async () => {
    const a = io();
    expect(await dataCommand(undefined, [], {}, a.io, deps)).toBe(2);
    expect(await dataCommand("purge", [], {}, a.io, deps)).toBe(2);
    expect(await dataCommand("purge", [], { provider: "moz" }, a.io, deps)).toBe(2);
    expect(await dataCommand("purge", ["x"], { provider: "ahrefs" }, a.io, deps)).toBe(2);
  });

  it("purges and prints JSON", async () => {
    trackCacheKey("ahrefs", "cli.example.com", cacheKey("cli-purge"));
    putCache(cacheKey("cli-purge"), 3600, 1);
    const a = io();
    expect(await dataCommand("purge", [], { provider: "ahrefs", client: "cli.example.com" }, a.io, deps)).toBe(0);
    expect(JSON.parse(a.lines.join("\n"))).toEqual({ command: "data purge", provider: "ahrefs", client: "cli.example.com", snapshots: 0, issueSnapshotsEdited: 0, cacheEntries: 1 });
  });
});

describe("Semrush Site Audit items in issue snapshots (31 days, fake clock)", () => {
  it("are removed from snapshots older than 31 days on the next save and on read; other sources stay", () => {
    const client = "semrush-issues.example.com";
    const src = (source: string) => ({ source, rule: "8", nativeSeverity: "error", count: 4, examples: [] });
    const snap = (id: string, at: number) => ({
      id,
      client,
      capturedAt: at,
      items: [
        { key: "broken-internal-link", title: "t", category: "links", severity: "high", url: null, affected: 4, sources: [src("semrush_site_audit"), src("local_crawl")] },
        { key: "semrush_site_audit:215", title: "t", category: "other", severity: "low", url: null, affected: 20, sources: [src("semrush_site_audit")] },
      ] as never,
      checked: [{ source: "semrush_site_audit" as const, runId: "s", ranAt: "2026-09-01T00:00:00Z", stale: false }, { source: "local_crawl" as const, runId: "c", ranAt: "2026-09-01T00:00:00Z", stale: false }],
      settings: { sources: ["semrush_site_audit" as const, "local_crawl" as const], maxAgeDays: 45 },
    });
    const T = Date.parse("2030-01-01T00:00:00Z");
    saveIssueSnapshot(snap("iss_01SEMRUSHA00000000000000000", T), T);
    saveIssueSnapshot(snap("iss_01SEMRUSHB00000000000000000", T + 32 * DAY), T + 32 * DAY);
    const rows = () => db.prepare("SELECT id, items, checked FROM issue_snapshots WHERE client = ? ORDER BY captured_at").all(client) as { id: string; items: string; checked: string }[];
    const [a, b] = rows();
    expect(a!.items).not.toContain("semrush_site_audit");
    expect(a!.checked).not.toContain("semrush_site_audit");
    expect(JSON.parse(a!.items).map((i: { key: string }) => i.key)).toEqual(["broken-internal-link"]);
    expect(b!.items).toContain("semrush_site_audit");
    // Read 40 days after B: B's Semrush items are gone too.
    const read = latestIssueSnapshotBefore(client, T + 41 * DAY, [], T + 64 * DAY)!;
    expect(JSON.stringify([read.items, read.checked])).not.toContain("semrush_site_audit");
    expect(read.items.map((i) => i.key)).toEqual(["broken-internal-link"]);
  });
});

describe("SEC-5: Ahrefs data that only lived in the cache", () => {
  it("is marked when cached, so removing the key purges it", async () => {
    const { env } = await import("../src/config.js");
    const { setProcessEntry } = await import("../src/lib/provider-data.js");
    db.exec("DELETE FROM provider_data_marks");
    setProcessEntry("mcp");
    (env as { AHREFS_API_KEY?: string }).AHREFS_API_KEY = "ahrefs-SEC5-sentinel";
    try {
      const c = { slug: "sec5.example.com", domain: "sec5.example.com", aliases: [], monthlyUnits: { ahrefs: 1000, semrush: 1000 } };
      await unitsCall({ client: c, provider: "ahrefs", capability: "sec5", keyParts: { x: 5 }, ttl: 3600, estimate: 0, run: async () => ({ value: "cached-only", units: 0 }) });
      expect(db.prepare("SELECT key_source, entry FROM provider_data_marks WHERE provider = 'ahrefs'").get()).toEqual({ key_source: "process", entry: "mcp" });
      expect(JSON.stringify(db.prepare("SELECT * FROM provider_data_marks").all())).not.toContain("SEC5");
    } finally {
      delete (env as { AHREFS_API_KEY?: string }).AHREFS_API_KEY;
    }
    const key = cacheKey("seo", "ahrefs", "sec5", { x: 5 });
    expect(peekCache(key)).toBeDefined();
    expect(reconcileRemovedKeys("mcp")).toMatchObject({ cacheEntries: 1 });
    expect(peekCache(key)).toBeUndefined();
    setProcessEntry("cli");
  });
});
