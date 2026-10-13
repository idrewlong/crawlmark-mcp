/**
 * Phase 12 B-1: the rank_history table (guarded migration), upserts, reads and summaries,
 * and the rank_history tool's result. Temp DATA_DIR (test/setup.ts); no network.
 */
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { rankChange, summarizeRanks } from "../src/analysis/ranks.js";
import { previousRanks, readRanks, saveRanks, type RankInput } from "../src/lib/rank-history.js";
import { db, migrateRankHistory } from "../src/lib/store.js";
import { rankHistory } from "../src/ranks.js";

const client = (slug: string, trackedKeywords: string[]) => ({ slug, trackedKeywords });
const serp = (keyword: string, day: string, rank: number | null, url: string | null = null): RankInput => ({ keyword, source: "serp", day, rank, url, depth: 100, market: "2840", language: "en" });
const gsc = (keyword: string, day: string, rank: number | null, clicks = 1, impressions = 10): RankInput => ({ keyword, source: "gsc", day, rank, clicks, impressions, market: "all", language: "all", device: "all" });

describe("migrateRankHistory", () => {
  it("adds the table and index to an existing database once and leaves other tables alone", () => {
    const old = new DatabaseSync(":memory:");
    old.exec("CREATE TABLE spend (id INTEGER PRIMARY KEY, client TEXT NOT NULL); INSERT INTO spend (client) VALUES ('example.com');");
    expect(migrateRankHistory(old)).toBe(true);
    expect(migrateRankHistory(old)).toBe(false);
    const names = (old.prepare("SELECT name FROM sqlite_master ORDER BY name").all() as { name: string }[]).map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["rank_history", "rank_history_lookup", "spend"]));
    expect(old.prepare("SELECT COUNT(*) AS n FROM spend").get()).toEqual({ n: 1 });
  });

  it("ran on the app database at startup", () => {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'rank_history'").get()).toBeDefined();
  });
});

describe("saveRanks / readRanks", () => {
  it("keeps one row per key (the latest check of a day wins) and normalises keywords", () => {
    const c = client("upsert.example.com", ["Plumber  Example City"]);
    expect(saveRanks(c, [serp("plumber example city", "2026-10-01", 9)], 1000)).toBe(1);
    expect(saveRanks(c, [serp("  PLUMBER example   city ", "2026-10-01", 7, "https://upsert.example.com/a")], 2000)).toBe(1);
    const rows = readRanks({ client: c.slug, since: "2026-01-01", until: "2026-12-31" });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ keyword: "plumber example city", rank: 7, url: "https://upsert.example.com/a", checkedAt: 2000, device: "desktop" });
  });

  it("stores only tracked keywords", () => {
    const c = client("tracked.example.com", ["a keyword"]);
    expect(saveRanks(c, [serp("a keyword", "2026-10-01", 3), serp("not tracked", "2026-10-01", 1)])).toBe(1);
    expect(readRanks({ client: c.slug, since: "2026-01-01", until: "2026-12-31" }).map((r) => r.keyword)).toEqual(["a keyword"]);
  });

  it("keeps gsc and serp rows apart, filters by range and source, and finds the previous row per keyword", () => {
    const c = client("range.example.com", ["k1", "k2"]);
    saveRanks(c, [gsc("k1", "2026-09-01", 8.4), gsc("k1", "2026-09-08", 7.9), serp("k1", "2026-09-08", 6), gsc("k2", "2026-09-08", null, 0, 0), gsc("k1", "2026-10-06", 5.1)]);
    expect(readRanks({ client: c.slug, since: "2026-09-02", until: "2026-09-30", source: "gsc" }).map((r) => [r.keyword, r.day])).toEqual([["k1", "2026-09-08"], ["k2", "2026-09-08"]]);
    const prev = previousRanks({ client: c.slug, keywords: ["k1", "k2", "k3"], source: "gsc", beforeDay: "2026-10-06" });
    expect(prev.get("k1")).toMatchObject({ day: "2026-09-08", rank: 7.9 });
    expect(prev.get("k2")).toMatchObject({ rank: null });
    expect(prev.has("k3")).toBe(false);
    expect(previousRanks({ client: c.slug, keywords: ["k1"], source: "serp", beforeDay: "2026-09-08" }).size).toBe(0);
  });
});

describe("summarizeRanks", () => {
  it("summarises a series with gaps and missing ranks; lower is better", () => {
    const s = summarizeRanks([
      { day: "2026-07-01", rank: 12 },
      { day: "2026-08-01", rank: null },
      { day: "2026-09-10", rank: 4 },
      { day: "2026-08-20", rank: 9 },
      { day: "2026-10-01", rank: 5 },
    ]);
    expect(s).toEqual({ latest: 5, first: 12, latestDay: "2026-10-01", firstDay: "2026-07-01", best: 4, worst: 12, change: -7, change30d: -4, change90d: -7, checks: 5, noRank: 1 });
  });

  it("gives nulls when there is too little data", () => {
    expect(summarizeRanks([])).toMatchObject({ latest: null, change: null, change30d: null, change90d: null, checks: 0 });
    expect(summarizeRanks([{ day: "2026-10-01", rank: 3 }])).toMatchObject({ latest: 3, first: 3, change: null, change30d: null });
    expect(rankChange(4, 7)).toBe(-3);
    expect(rankChange(null, 7)).toBeNull();
  });
});

describe("rankHistory (the rank_history tool)", () => {
  it("returns series and summaries per source for tracked keywords, newest-wins per day", () => {
    const c = client("history.example.com", ["plumber example city", "no data yet"]);
    saveRanks(c, [gsc("plumber example city", "2026-07-06", 8.4), gsc("plumber example city", "2026-10-05", 5.1), serp("plumber example city", "2026-07-07", 7), serp("plumber example city", "2026-10-06", 4, "https://history.example.com/")]);
    const r = rankHistory(c, { since: "2026-07-01", until: "2026-10-10" });
    expect(r.keywords.map((k) => k.keyword)).toEqual(["plumber example city", "no data yet"]);
    const k = r.keywords[0]!;
    expect(k.series.gsc).toEqual([{ day: "2026-07-06", rank: 8.4, clicks: 1, impressions: 10 }, { day: "2026-10-05", rank: 5.1, clicks: 1, impressions: 10 }]);
    expect(k.series.serp).toEqual([{ day: "2026-07-07", rank: 7, url: null }, { day: "2026-10-06", rank: 4, url: "https://history.example.com/" }]);
    expect(k.summary.gsc).toMatchObject({ first: 8.4, latest: 5.1, change: -3.3 });
    expect(k.summary.serp).toMatchObject({ first: 7, latest: 4, change: -3 });
    expect(r.keywords[1]!.series).toEqual({ gsc: [], serp: [] });
    expect(r.note).toMatch(/lower is better/);
  });

  it("filters by keyword and source, defaults to 180 days and rejects a bad range", () => {
    const c = client("filter.example.com", ["a", "b"]);
    saveRanks(c, [gsc("a", "2026-10-01", 3), serp("a", "2026-10-01", 2), gsc("b", "2026-10-01", 9)]);
    const r = rankHistory(c, { keyword: " A ", source: "serp", today: new Date("2026-10-13T12:00:00Z") });
    expect(r).toMatchObject({ since: "2026-04-16", until: "2026-10-13", source: "serp" });
    expect(r.keywords).toEqual([expect.objectContaining({ keyword: "a", series: { serp: [{ day: "2026-10-01", rank: 2, url: null }] } })]);
    expect(() => rankHistory(c, { since: "2026-10-02", until: "2026-10-01" })).toThrow(/after until/);
    expect(() => rankHistory(c, { since: "2026-02-31" })).toThrow(/real date/);
  });
});
