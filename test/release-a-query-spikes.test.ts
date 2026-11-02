/** Release A / D4: flagging days whose impressions jump on a few zero-click queries (pure rules, C9). */
import { describe, expect, it } from "vitest";
import { concentrate, findQuerySpikes, shiftDay, spikeDays, spikeNote, type DailyPoint } from "../src/analysis/query-spikes.js";
import type { GscRow } from "../src/providers/gsc.js";

const START = "2026-08-01";
const days = (from: string, n: number) => Array.from({ length: n }, (_, i) => shiftDay(from, i));
/** A flat series: 100 impressions and 5 clicks a day, with overrides by date. */
const series = (n: number, over: Record<string, Partial<DailyPoint>> = {}): DailyPoint[] =>
  days(START, n).map((date) => ({ date, clicks: 5, impressions: 100, ...over[date] }));
const PERIOD = { startDate: "2026-09-01", endDate: "2026-09-30" };
const q = (query: string, impressions: number, clicks = 0): GscRow => ({ keys: [query], clicks, impressions, ctr: 0, position: 8 });

describe("spikeDays", () => {
  it("finds nothing in a flat series", () => {
    expect(spikeDays(series(61), PERIOD)).toEqual([]);
  });

  it("flags a day with 4x the baseline impressions and flat clicks, and reports the baseline and excess", () => {
    const d = "2026-09-10";
    const out = spikeDays(series(61, { [d]: { impressions: 400 } }), PERIOD);
    expect(out).toEqual([{ date: d, impressions: 400, clicks: 5, baselineImpressions: 100, baselineClicks: 5, excess: 300 }]);
  });

  it("uses medians, so one earlier outlier doesn't move the baseline", () => {
    const out = spikeDays(series(61, { "2026-09-05": { impressions: 5000 }, "2026-09-10": { impressions: 400 } }), PERIOD);
    expect(out.map((s) => s.date)).toEqual(["2026-09-05", "2026-09-10"]);
    expect(out[1]!.baselineImpressions).toBe(100);
  });

  it("skips a day with fewer than 14 baseline days of data", () => {
    // From 2026-09-01 on, 2026-09-10 has only 9 earlier days.
    const s = series(61, { "2026-09-10": { impressions: 400 } }).filter((p) => p.date >= "2026-09-01");
    expect(spikeDays(s, PERIOD)).toEqual([]);
  });

  it("needs the jump to be at least 3x and 200 impressions above the baseline", () => {
    expect(spikeDays(series(61, { "2026-09-10": { impressions: 290 } }), PERIOD)).toEqual([]); // under 3x
    expect(spikeDays(series(61, { "2026-09-10": { impressions: 250 } }), PERIOD)).toEqual([]);
    const small = series(61).map((p) => ({ ...p, impressions: 10 })).map((p) => (p.date === "2026-09-10" ? { ...p, impressions: 40 } : p));
    expect(spikeDays(small, PERIOD)).toEqual([]); // 4x but only +30
  });

  it("doesn't flag a day when clicks rise too", () => {
    expect(spikeDays(series(61, { "2026-09-10": { impressions: 400, clicks: 30 } }), PERIOD)).toEqual([]);
    expect(spikeDays(series(61, { "2026-09-10": { impressions: 400, clicks: 12 } }), PERIOD)).toHaveLength(1); // 12 <= 1.5*5+5
  });

  it("only looks at days inside the period", () => {
    expect(spikeDays(series(61, { "2026-08-20": { impressions: 900 } }), PERIOD)).toEqual([]);
  });

  it("orders candidates by excess, largest first", () => {
    const out = spikeDays(series(61, { "2026-09-03": { impressions: 500 }, "2026-09-20": { impressions: 900 } }), PERIOD);
    expect(out.map((s) => s.date)).toEqual(["2026-09-20", "2026-09-03"]);
  });
});

describe("concentrate", () => {
  const day = { date: "2026-09-10", impressions: 400, clicks: 5, baselineImpressions: 100, baselineClicks: 5, excess: 300 };

  it("flags the day when 3 zero-click queries hold 70% of the excess", () => {
    const rows = [q("track my rank", 100), q("rank checker", 70), q("serp bot", 40), q("normal query", 90, 5), q("another", 30, 2)];
    const s = concentrate(day, rows)!;
    expect(s.queries).toEqual([
      { query: "track my rank", impressions: 100 },
      { query: "rank checker", impressions: 70 },
      { query: "serp bot", impressions: 40 },
    ].slice(0, s.queries.length));
    expect(s.share).toBeGreaterThanOrEqual(0.5);
    expect(s).toMatchObject({ date: "2026-09-10", excess: 300, baselineImpressions: 100 });
  });

  it("takes the smallest prefix that reaches half of the excess", () => {
    const s = concentrate(day, [q("a", 100), q("b", 60), q("c", 40), q("d", 10)])!;
    expect(s.queries.map((x) => x.query)).toEqual(["a", "b"]);
    expect(s.share).toBe(0.53);
  });

  it("doesn't flag when the excess is spread over 40 queries", () => {
    const rows = Array.from({ length: 40 }, (_, i) => q(`query ${i}`, 10));
    expect(concentrate(day, rows)).toBeNull();
  });

  it("ignores queries that got clicks", () => {
    expect(concentrate(day, [q("big", 250, 3), q("small", 20)])).toBeNull();
  });

  it("needs the share within 5 queries", () => {
    const rows = Array.from({ length: 10 }, (_, i) => q(`query ${i}`, 20)); // 5 queries = 100 of 300
    expect(concentrate(day, rows)).toBeNull();
  });
});

describe("findQuerySpikes", () => {
  it("breaks down at most 3 candidate days, the largest excess first", async () => {
    const over = Object.fromEntries(["03", "07", "11", "15", "19"].map((d, i) => [`2026-09-${d}`, { impressions: 500 + i * 100 }]));
    const asked: string[] = [];
    const out = await findQuerySpikes(series(61, over), PERIOD, async (date) => {
      asked.push(date);
      return [q("bot query", 10_000)];
    });
    expect(asked).toEqual(["2026-09-19", "2026-09-15", "2026-09-11"]);
    expect(out.map((s) => s.date)).toEqual(["2026-09-11", "2026-09-15", "2026-09-19"]);
  });

  it("a breakdown that fails leaves that day unflagged", async () => {
    const out = await findQuerySpikes(series(61, { "2026-09-10": { impressions: 400 } }), PERIOD, async () => {
      throw new Error("quota");
    });
    expect(out).toEqual([]);
  });
});

describe("spikeNote", () => {
  it("is the report line, with control characters stripped and each query cut to 80 characters", () => {
    const s = concentrate(
      { date: "2026-09-10", impressions: 400, clicks: 5, baselineImpressions: 100, baselineClicks: 5, excess: 300 },
      [q("bot\u0007 one", 100), q("x".repeat(120), 100)],
    )!;
    const note = spikeNote(s);
    expect(note).toBe(`Possible automated queries on 2026-09-10: 2 zero-click queries (bot one, ${"x".repeat(80)}) added 300 impressions (baseline 100/day). If they aren't real searches, exclude them with set_client_profile gscExcludeQueries.`);
    expect(spikeNote({ ...s, queries: [s.queries[0]!] })).toContain("1 zero-click query (");
  });
});
