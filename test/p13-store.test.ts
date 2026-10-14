/**
 * Phase 13 A-1: the seo_snapshots, issue_snapshots, url_inspections and gsc_inspection_quota tables, the
 * snapshot store (tolerance, live over provider history, Semrush 31-day retention) and the inspection store
 * (sanitising, latest per URL, Pacific-time quota day across DST). Temp SQLite only (test/setup.ts).
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { db, migrateIssueSnapshots, migrateSeoSnapshots, migrateUrlInspections } from "../src/lib/store.js";
import { nearestSnapshot, pruneSnapshots, saveSnapshot, seriesSince, SEMRUSH_RETENTION_DAYS } from "../src/lib/snapshots.js";
import { addQuotaUse, cleanText, inspectionsBetween, lastInspectedAt, latestInspections, markQuotaExhausted, pacificDay, quotaFor, saveFailedInspection, saveInspection } from "../src/lib/inspections.js";

const DAY = 86_400_000;
const NOW = Date.parse("2026-10-13T12:00:00Z");

describe("Phase 13 migrations", () => {
  it("are idempotent on a fresh and on an already-migrated database", () => {
    const fresh = new DatabaseSync(":memory:");
    for (const m of [migrateSeoSnapshots, migrateIssueSnapshots, migrateUrlInspections]) {
      expect(m(fresh)).toBe(true);
      expect(m(fresh)).toBe(false);
    }
    const tables = (fresh.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(tables).toEqual(expect.arrayContaining(["seo_snapshots", "issue_snapshots", "url_inspections", "gsc_inspection_quota"]));
    // The shared test database was migrated on import and stays migrated.
    expect(migrateSeoSnapshots(db)).toBe(false);
    expect(migrateUrlInspections(db)).toBe(false);
  });
});

const key = (provider: "dataforseo" | "ahrefs" | "semrush", client = "snap.example.com") => ({ client, kind: "backlinks" as const, target: "example.com", provider, market: "global" });

describe("seo snapshots", () => {
  it("nearestSnapshot honours the tolerance and prefers a live capture over provider history on a tie", () => {
    const k = key("dataforseo");
    saveSnapshot({ ...k, day: "2026-09-01", source: "provider_history", capturedAt: NOW, data: { referringDomains: 190 } }, NOW);
    saveSnapshot({ ...k, day: "2026-09-01", source: "live", capturedAt: NOW, data: { referringDomains: 198 } }, NOW);
    saveSnapshot({ ...k, day: "2026-09-28", source: "live", capturedAt: NOW, data: { referringDomains: 212 } }, NOW);
    expect(nearestSnapshot({ ...k, day: "2026-09-30", toleranceDays: 10 }, NOW)?.data).toEqual({ referringDomains: 212 });
    const aug = nearestSnapshot({ ...k, day: "2026-08-31", toleranceDays: 10 }, NOW);
    expect(aug).toMatchObject({ day: "2026-09-01", source: "live", data: { referringDomains: 198 } });
    expect(nearestSnapshot({ ...k, day: "2026-08-31", toleranceDays: 10, prefer: "provider_history" }, NOW)?.source).toBe("provider_history");
    // Outside the window: nothing.
    expect(nearestSnapshot({ ...k, day: "2026-08-01", toleranceDays: 10 }, NOW)).toBeUndefined();
    // Another provider or market never matches.
    expect(nearestSnapshot({ ...key("ahrefs"), day: "2026-09-30", toleranceDays: 10 }, NOW)).toBeUndefined();
    expect(nearestSnapshot({ ...k, market: "2840", day: "2026-09-30", toleranceDays: 10 }, NOW)).toBeUndefined();
  });

  it("upserts on the unique key (latest capture of the day wins) and builds a one-point-per-day series", () => {
    const k = key("ahrefs", "series.example.com");
    saveSnapshot({ ...k, day: "2026-07-01", source: "provider_history", capturedAt: NOW - 2000, data: { referringDomains: 150 } }, NOW);
    saveSnapshot({ ...k, day: "2026-08-01", source: "live", capturedAt: NOW - 1000, data: { referringDomains: 160 } }, NOW);
    saveSnapshot({ ...k, day: "2026-08-01", source: "live", capturedAt: NOW, data: { referringDomains: 161 } }, NOW);
    saveSnapshot({ ...k, day: "2026-08-01", source: "provider_history", capturedAt: NOW, data: { referringDomains: 159 } }, NOW);
    const s = seriesSince(k, "2026-06-01", NOW);
    expect(s.map((p) => [p.day, p.source, p.data.referringDomains])).toEqual([
      ["2026-07-01", "provider_history", 150],
      ["2026-08-01", "live", 161],
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM seo_snapshots WHERE client = ?").get("series.example.com") as { n: number }).n).toBe(3);
  });

  it("deletes Semrush rows captured more than 31 days ago, on save and on read; other providers are kept", () => {
    const sem = key("semrush", "retention.example.com");
    const dfs = key("dataforseo", "retention.example.com");
    const old = NOW - (SEMRUSH_RETENTION_DAYS + 1) * DAY;
    saveSnapshot({ ...sem, day: "2026-09-01", source: "live", capturedAt: old, data: { backlinks: 1 } }, old);
    saveSnapshot({ ...dfs, day: "2026-09-01", source: "live", capturedAt: old, data: { backlinks: 2 } }, old);
    // A read now prunes the old Semrush row.
    expect(nearestSnapshot({ ...sem, day: "2026-09-01", toleranceDays: 3 }, NOW)).toBeUndefined();
    expect(nearestSnapshot({ ...dfs, day: "2026-09-01", toleranceDays: 3 }, NOW)?.data).toEqual({ backlinks: 2 });
    // And a save does too.
    saveSnapshot({ ...sem, day: "2026-09-02", source: "live", capturedAt: old, data: { backlinks: 3 } }, old);
    saveSnapshot({ ...sem, day: "2026-10-12", source: "live", capturedAt: NOW, data: { backlinks: 4 } }, NOW);
    expect(seriesSince(sem, "2026-01-01", NOW).map((p) => p.data.backlinks)).toEqual([4]);
    expect(pruneSnapshots(NOW)).toBe(0);
  });

  it("refuses a malformed day", () => {
    expect(() => saveSnapshot({ ...key("dataforseo"), day: "2026-9-1", source: "live", capturedAt: NOW, data: {} }, NOW)).toThrow(/YYYY-MM-DD/);
  });
});

describe("url inspections", () => {
  const base = { property: "sc-domain:example.com", verdict: "PASS", indexingState: "INDEXING_ALLOWED", pageFetchState: "SUCCESSFUL", robotsTxtState: "ALLOWED", userCanonical: null, lastCrawlTime: "2026-10-01T03:00:00Z", crawledAs: "MOBILE" };

  it("stores sanitised Google text (no control or bidi characters, capped) and normalised URLs", () => {
    saveInspection({
      ...base,
      client: "inspect.example.com",
      url: "https://Example.com/a/#frag",
      origin: "key",
      inspectedAt: NOW,
      coverageState: `Submitted and indexed\u202e\u0007${"x".repeat(400)}`,
      googleCanonical: "https://example.com/a/\u200b",
      inSitemap: true,
    });
    const [row] = latestInspections("inspect.example.com");
    expect(row!.url).toBe("https://example.com/a");
    expect(row!.coverageState!.startsWith("Submitted and indexed")).toBe(true);
    expect(row!.coverageState).not.toMatch(/[\u202e\u0007]/);
    expect(row!.coverageState!.length).toBe(200);
    expect(row!.googleCanonical).toBe("https://example.com/a");
    expect(row!.inSitemap).toBe(true);
    expect(cleanText("  a\n b\u2066 ")).toBe("a b");
  });

  it("latestInspections keeps the newest per URL; lastInspectedAt and inspectionsBetween read the history", () => {
    const c = "history.example.com";
    saveInspection({ ...base, client: c, url: "https://example.com/p", origin: "sitemap", inspectedAt: NOW - 3 * DAY, coverageState: "Crawled - currently not indexed", googleCanonical: null, verdict: "NEUTRAL" });
    saveInspection({ ...base, client: c, url: "https://example.com/p", origin: "sitemap", inspectedAt: NOW - DAY, coverageState: "Submitted and indexed", googleCanonical: null });
    saveInspection({ ...base, client: c, url: "https://example.com/q", origin: "gsc_top", inspectedAt: NOW - 2 * DAY, coverageState: "Submitted and indexed", googleCanonical: null });
    const latest = latestInspections(c);
    expect(latest.map((r) => [r.url, r.coverageState])).toEqual([
      ["https://example.com/p", "Submitted and indexed"],
      ["https://example.com/q", "Submitted and indexed"],
    ]);
    expect(lastInspectedAt(c).get("https://example.com/p")).toBe(NOW - DAY);
    expect(inspectionsBetween(c, NOW - 10 * DAY, NOW)).toHaveLength(3);
    // Inspections older than 400 days are deleted on the next insert.
    saveInspection({ ...base, client: c, url: "https://example.com/old", origin: "manual", inspectedAt: NOW - 500 * DAY, coverageState: null, googleCanonical: null });
    saveInspection({ ...base, client: c, url: "https://example.com/r", origin: "manual", inspectedAt: NOW, coverageState: null, googleCanonical: null });
    expect(latestInspections(c).some((r) => r.url === "https://example.com/old")).toBe(false);
  });

  it("purges inspections older than 400 days when only failed calls are saved", () => {
    const c = "purge-failed.example";
    saveFailedInspection({ client: c, property: "sc-domain:purge-failed.example", url: "https://purge-failed.example/old", origin: "sitemap", inspectedAt: NOW - 500 * DAY });
    saveFailedInspection({ client: c, property: "sc-domain:purge-failed.example", url: "https://purge-failed.example/new", origin: "sitemap", inspectedAt: NOW });
    const urls = (db.prepare("SELECT url FROM url_inspections WHERE client = ?").all(c) as { url: string }[]).map((r) => r.url);
    expect(urls).toEqual(["https://purge-failed.example/new"]);
  });
});

describe("Pacific-time quota day (D15)", () => {
  it("rolls over at 00:00 America/Los_Angeles, including across both DST changes", () => {
    // Spring forward (8 Mar 2026): midnight on the 9th is 07:00Z (PDT).
    expect(pacificDay(Date.parse("2026-03-09T06:59:59Z"))).toBe("2026-03-08");
    expect(pacificDay(Date.parse("2026-03-09T07:00:00Z"))).toBe("2026-03-09");
    // Midnight on the 8th itself was still PST (08:00Z).
    expect(pacificDay(Date.parse("2026-03-08T07:59:59Z"))).toBe("2026-03-07");
    expect(pacificDay(Date.parse("2026-03-08T08:00:00Z"))).toBe("2026-03-08");
    // Fall back (1 Nov 2026): midnight on the 2nd is 08:00Z (PST).
    expect(pacificDay(Date.parse("2026-11-02T07:59:59Z"))).toBe("2026-11-01");
    expect(pacificDay(Date.parse("2026-11-02T08:00:00Z"))).toBe("2026-11-02");
  });

  it("counts use per property and day, marks a day exhausted, and drops rows older than 7 days", () => {
    const p = "sc-domain:quota.example.com";
    expect(quotaFor(p, "2026-10-01")).toEqual({ property: p, day: "2026-10-01", used: 0, exhausted: false });
    addQuotaUse(p, "2026-10-01", 3);
    addQuotaUse(p, "2026-10-01");
    expect(quotaFor(p, "2026-10-01")).toMatchObject({ used: 4, exhausted: false });
    markQuotaExhausted(p, "2026-10-01");
    expect(quotaFor(p, "2026-10-01")).toMatchObject({ used: 4, exhausted: true });
    expect(quotaFor(p, "2026-10-02")).toMatchObject({ used: 0, exhausted: false });
    addQuotaUse(p, "2026-10-13");
    expect(quotaFor(p, "2026-10-01").used).toBe(0);
  });
});
