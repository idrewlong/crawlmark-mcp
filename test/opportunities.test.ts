import { describe, expect, it } from "vitest";
import { CTR_BEYOND_20, expectedCtr } from "../src/analysis/ctr-curve.js";
import {
  cannibalization,
  decliningPages,
  lowCtr,
  normalizePageUrl,
  pagesFromPageRows,
  pagesFromQueryPageRows,
  quickWins,
  strikingDistance,
  type OppRow,
} from "../src/analysis/opportunities.js";
import { previousRange, rangeDays } from "../src/lib/dates.js";
import { resolveWindow } from "../src/reports/opportunities.js";

const client = { domain: "exampleplumbing.com", name: "Example Plumbing" };
const ctx = { client };
const P = "https://example.com";

/** query+page row; ctr is derived from clicks/impressions as a percent. */
const row = (query: string, page: string, impressions: number, clicks: number, position: number): OppRow => ({
  keys: [query, page],
  clicks,
  impressions,
  ctr: impressions ? (clicks / impressions) * 100 : 0,
  position,
});

describe("expectedCtr", () => {
  it("follows the curve and rounds fractional positions", () => {
    expect(expectedCtr(1)).toBe(0.28);
    expect(expectedCtr(3)).toBe(0.1);
    expect(expectedCtr(5)).toBe(0.05);
    expect(expectedCtr(10)).toBe(0.02);
    expect(expectedCtr(11)).toBe(0.01);
    expect(expectedCtr(20)).toBe(0.01);
    expect(expectedCtr(2.4)).toBe(0.15);
    expect(expectedCtr(2.6)).toBe(0.1);
  });
  it("treats positions below 1 as 1 and beyond 20 as the tail value", () => {
    expect(expectedCtr(0.3)).toBe(0.28);
    expect(expectedCtr(20.4)).toBe(0.01);
    expect(expectedCtr(21)).toBe(CTR_BEYOND_20);
    expect(expectedCtr(80)).toBe(CTR_BEYOND_20);
    expect(expectedCtr(Number.NaN)).toBe(CTR_BEYOND_20);
  });
});

describe("normalizePageUrl", () => {
  it("drops fragment and trailing slash, keeps the root slash and query", () => {
    expect(normalizePageUrl(`${P}/a/#top`)).toBe(`${P}/a`);
    expect(normalizePageUrl(`${P}/a`)).toBe(`${P}/a`);
    expect(normalizePageUrl(`${P}`)).toBe(`${P}/`);
    expect(normalizePageUrl(`${P}/`)).toBe(`${P}/`);
    expect(normalizePageUrl("https://EXAMPLE.com/a?x=1")).toBe(`${P}/a?x=1`);
  });
  it("tolerates non-URLs", () => {
    expect(normalizePageUrl("/relative/#x")).toBe("/relative");
  });
});

describe("strikingDistance", () => {
  const base = [
    row("fix leaking tap", `${P}/a`, 1000, 10, 8),
    row("boiler repair cost", `${P}/b`, 500, 5, 12),
  ];

  it("computes upside against the position-3 CTR and sorts by it", () => {
    const out = strikingDistance(base, ctx);
    expect(out.map((r) => r.query)).toEqual(["fix leaking tap", "boiler repair cost"]);
    expect(out[0]).toEqual({
      query: "fix leaking tap",
      topPage: `${P}/a`,
      position: 8,
      impressions: 1000,
      clicks: 10,
      ctr: 1,
      estimatedExtraClicks: 90, // 1000 x (0.10 - 0.01)
    });
  });

  it("applies position and impression thresholds inclusively", () => {
    const rows = [
      row("at min pos", `${P}/a`, 100, 1, 5),
      row("at max pos", `${P}/a`, 100, 1, 20),
      row("below min pos", `${P}/a`, 100, 1, 4.9),
      row("over max pos", `${P}/a`, 100, 1, 20.1),
      row("just under impressions", `${P}/a`, 99, 1, 10),
    ];
    expect(strikingDistance(rows, ctx).map((r) => r.query).sort()).toEqual(["at max pos", "at min pos"]);
    expect(strikingDistance(rows, ctx, { minImpressions: 99 }).map((r) => r.query)).toContain("just under impressions");
    expect(strikingDistance(rows, ctx, { minPosition: 4, maxPosition: 5 }).map((r) => r.query).sort()).toEqual(["at min pos", "below min pos"]);
  });

  it("floors upside at zero when CTR already beats position 3", () => {
    const out = strikingDistance([row("lucky", `${P}/a`, 200, 40, 6)], ctx);
    expect(out[0]!.estimatedExtraClicks).toBe(0);
  });

  it("aggregates pages with weighted position and picks the page with most clicks", () => {
    const rows = [row("q", `${P}/a`, 300, 1, 6), row("q", `${P}/b/`, 100, 9, 14), row("q", `${P}/b#frag`, 100, 0, 14)];
    const [r] = strikingDistance(rows, ctx);
    expect(r!.impressions).toBe(500);
    expect(r!.position).toBe(9.2); // (300x6 + 200x14) / 500
    expect(r!.topPage).toBe(`${P}/b`);
    expect(r!.clicks).toBe(10);
  });

  it("breaks ties deterministically", () => {
    const rows = [row("b query", `${P}/a`, 200, 2, 10), row("a query", `${P}/a`, 200, 2, 10)];
    expect(strikingDistance(rows, ctx).map((r) => r.query)).toEqual(["a query", "b query"]);
  });

  it("excludes branded queries unless includeBranded", () => {
    const rows = [row("example plumbing hours", `${P}/a`, 500, 5, 8), row("fix tap", `${P}/a`, 500, 5, 8)];
    expect(strikingDistance(rows, ctx).map((r) => r.query)).toEqual(["fix tap"]);
    expect(strikingDistance(rows, { client, includeBranded: true }).map((r) => r.query).sort()).toEqual(["example plumbing hours", "fix tap"]);
  });

  it("returns nothing for empty input", () => {
    expect(strikingDistance([], ctx)).toEqual([]);
  });
});

describe("quickWins", () => {
  it("flags pages at 11-20 with top 3 queries by impressions", () => {
    const rows = [
      row("q1", `${P}/a`, 400, 0, 12),
      row("q2", `${P}/a`, 300, 0, 12),
      row("q3", `${P}/a`, 200, 0, 12),
      row("q4", `${P}/a`, 100, 0, 12),
      row("other", `${P}/b`, 500, 5, 3),
    ];
    const out = quickWins(rows, ctx);
    expect(out).toHaveLength(1);
    expect(out[0]!.page).toBe(`${P}/a`);
    expect(out[0]!.impressions).toBe(1000);
    expect(out[0]!.topQueries.map((q) => q.query)).toEqual(["q1", "q2", "q3"]);
  });

  it("applies thresholds at the boundary and just over", () => {
    const rows = [
      row("a", `${P}/p11`, 100, 0, 11),
      row("a", `${P}/p20`, 100, 0, 20),
      row("a", `${P}/p10`, 100, 0, 10.9),
      row("a", `${P}/p21`, 100, 0, 20.1),
      row("a", `${P}/few`, 99, 0, 15),
    ];
    expect(quickWins(rows, ctx).map((r) => r.page).sort()).toEqual([`${P}/p11`, `${P}/p20`]);
  });

  it("sorts by impressions then page, excludes branded, handles empty", () => {
    const rows = [row("x", `${P}/b`, 200, 0, 12), row("y", `${P}/a`, 200, 0, 12), row("example plumbing", `${P}/c`, 900, 0, 12)];
    expect(quickWins(rows, ctx).map((r) => r.page)).toEqual([`${P}/a`, `${P}/b`]);
    expect(quickWins(rows, { client, includeBranded: true })[0]!.page).toBe(`${P}/c`);
    expect(quickWins([], ctx)).toEqual([]);
  });
});

describe("lowCtr", () => {
  it("flags CTR strictly below 60% of expected, with extra clicks", () => {
    // position 1: expected 28%, threshold 16.8%
    const rows = [
      row("under", `${P}/a`, 1000, 167, 1), // 16.7% < 16.8%
      row("exact", `${P}/a`, 1000, 168, 1), // 16.8% is not below
      row("over", `${P}/a`, 1000, 200, 1),
    ];
    const out = lowCtr(rows, ctx);
    expect(out.map((r) => r.query)).toEqual(["under"]);
    expect(out[0]).toMatchObject({ expectedCtr: 28, ctr: 16.7, estimatedExtraClicks: 113, page: `${P}/a` });
  });

  it("limits to positions 1-5 and the impression floor", () => {
    const rows = [row("p5", `${P}/a`, 1000, 0, 5), row("p6", `${P}/a`, 1000, 0, 5.1), row("few", `${P}/a`, 99, 0, 2), row("min", `${P}/a`, 100, 0, 2)];
    expect(lowCtr(rows, ctx).map((r) => r.query).sort()).toEqual(["min", "p5"]);
    expect(lowCtr(rows, ctx, { maxPosition: 6 }).map((r) => r.query)).toContain("p6");
  });

  it("sorts by extra clicks, excludes branded, handles empty", () => {
    const rows = [row("small", `${P}/a`, 200, 0, 3), row("big", `${P}/a`, 2000, 0, 3), row("example plumbing", `${P}/a`, 9000, 0, 1)];
    expect(lowCtr(rows, ctx).map((r) => r.query)).toEqual(["big", "small"]);
    expect(lowCtr(rows, { client, includeBranded: true })[0]!.query).toBe("example plumbing");
    expect(lowCtr([], ctx)).toEqual([]);
  });
});

describe("cannibalization", () => {
  it("flags queries with 2+ pages at >= 10% share and lists only those pages", () => {
    const rows = [row("q", `${P}/a`, 600, 10, 4), row("q", `${P}/b`, 300, 3, 7), row("q", `${P}/c`, 100, 0, 15)];
    const [r] = cannibalization(rows, ctx);
    expect(r!.totalImpressions).toBe(1000);
    expect(r!.pages.map((p) => [p.page, p.impressionShare])).toEqual([[`${P}/a`, 60], [`${P}/b`, 30], [`${P}/c`, 10]]); // 10% is inclusive
  });

  it("drops a page just under 10% and then no longer flags", () => {
    const rows = [row("q", `${P}/a`, 910, 10, 4), row("q", `${P}/b`, 99, 1, 7)]; // 99/1009 < 10%
    expect(cannibalization(rows, ctx)).toEqual([]);
  });

  it("requires the total impression threshold", () => {
    const rows = [row("q", `${P}/a`, 50, 1, 4), row("q", `${P}/b`, 49, 1, 5)];
    expect(cannibalization(rows, ctx)).toEqual([]);
    expect(cannibalization(rows, ctx, { minImpressions: 99 })).toHaveLength(1);
  });

  it("does not count URL variants as competing pages", () => {
    const rows = [row("q", `${P}/a`, 500, 5, 4), row("q", `${P}/a/`, 400, 4, 4), row("q", `${P}/a#section`, 100, 1, 4)];
    expect(cannibalization(rows, ctx)).toEqual([]);
  });

  it("sorts by total impressions then query, excludes branded, handles empty", () => {
    const two = (q: string, n: number) => [row(q, `${P}/a`, n, 1, 4), row(q, `${P}/b`, n, 1, 5)];
    const rows = [...two("b", 100), ...two("a", 100), ...two("big", 400), ...two("example plumbing", 900)];
    expect(cannibalization(rows, ctx).map((r) => r.query)).toEqual(["big", "a", "b"]);
    expect(cannibalization(rows, { client, includeBranded: true })[0]!.query).toBe("example plumbing");
    expect(cannibalization([], ctx)).toEqual([]);
  });
});

describe("decliningPages", () => {
  const page = (p: string, clicks: number, position = 5) => ({ page: `${P}/${p}`, clicks, impressions: 1000, position });

  it("flags drops at both thresholds, inclusive, with the decline math", () => {
    const prev = [page("exact", 100, 4), page("pct-short", 100), page("loss-short", 20), page("gone", 50, 6)];
    const cur = [page("exact", 70, 7), page("pct-short", 71), page("loss-short", 11)];
    const out = decliningPages(cur, prev, [], [], ctx);
    expect(out.map((r) => r.page)).toEqual([`${P}/gone`, `${P}/exact`]); // sorted by clicks lost: 50, 30
    expect(out[1]).toMatchObject({ clicksBefore: 100, clicksAfter: 70, change: -30, changePct: -30, positionBefore: 4, positionAfter: 7 });
    expect(out[0]).toMatchObject({ clicksAfter: 0, change: -50, changePct: -100, positionAfter: null });
  });

  it("does not flag small losses even at a high percentage, or growth", () => {
    expect(decliningPages([page("a", 1)], [page("a", 9)], [], [], ctx)).toEqual([]); // loss 8 < 10
    expect(decliningPages([page("a", 200)], [page("a", 100)], [], [], ctx)).toEqual([]);
    expect(decliningPages([], [page("zero", 0)], [], [], ctx)).toEqual([]);
  });

  it("lists the queries that lost the most clicks, ignoring branded unless included", () => {
    const prevQP = [row("q1", `${P}/a`, 100, 30, 4), row("q2", `${P}/a`, 100, 20, 4), row("q3", `${P}/a`, 100, 5, 4), row("example plumbing", `${P}/a`, 100, 50, 1), row("q1", `${P}/other`, 100, 99, 1)];
    const curQP = [row("q1", `${P}/a/`, 100, 10, 6), row("q3", `${P}/a`, 100, 9, 4)];
    const prev = [page("a", 105)];
    const cur = [page("a", 19)];
    const out = decliningPages(cur, prev, curQP, prevQP, ctx);
    expect(out[0]!.topLostQueries).toEqual([
      { query: "q1", clicksBefore: 30, clicksAfter: 10, change: -20 },
      { query: "q2", clicksBefore: 20, clicksAfter: 0, change: -20 },
    ]);
    const withBranded = decliningPages(cur, prev, curQP, prevQP, { client, includeBranded: true });
    expect(withBranded[0]!.topLostQueries[0]!.query).toBe("example plumbing");
  });

  it("derives page totals from query+page rows with branded excluded, and from page rows", () => {
    const qp = [row("fix tap", `${P}/a`, 100, 10, 4), row("fix tap", `${P}/a/`, 100, 5, 6), row("example plumbing", `${P}/a`, 100, 80, 1)];
    expect(pagesFromQueryPageRows(qp, ctx)).toEqual([{ page: `${P}/a`, clicks: 15, impressions: 200, position: 5 }]);
    expect(pagesFromQueryPageRows(qp, { client, includeBranded: true })[0]!.clicks).toBe(95);
    expect(pagesFromPageRows([{ keys: [`${P}/a`], clicks: 7, impressions: 10, ctr: 70, position: 2 }, { keys: [`${P}/a/`], clicks: 3, impressions: 10, ctr: 30, position: 4 }])).toEqual([
      { page: `${P}/a`, clicks: 10, impressions: 20, position: 3 },
    ]);
  });

  it("handles empty input", () => {
    expect(decliningPages([], [], [], [], ctx)).toEqual([]);
  });
});

describe("date windows", () => {
  it("defaults to the last 28 days ending 3 days ago", () => {
    const w = resolveWindow({}, new Date("2026-10-12T10:00:00Z"));
    expect(w).toEqual({ startDate: "2026-09-12", endDate: "2026-10-09" });
    expect(rangeDays(w)).toBe(28);
  });
  it("takes overrides and rejects bad ones", () => {
    expect(resolveWindow({ startDate: "2026-01-01", endDate: "2026-01-31" })).toEqual({ startDate: "2026-01-01", endDate: "2026-01-31" });
    expect(() => resolveWindow({ startDate: "2026-01-01" })).toThrow(/both/);
    expect(() => resolveWindow({ startDate: "2026-02-01", endDate: "2026-01-01" })).toThrow(/after/);
    expect(() => resolveWindow({ startDate: "2026-13-01", endDate: "2026-13-02" })).toThrow(/real dates/);
  });
  it("previousRange is the equal-length window just before", () => {
    expect(previousRange({ startDate: "2026-09-12", endDate: "2026-10-09" })).toEqual({ startDate: "2026-08-15", endDate: "2026-09-11" });
    expect(previousRange({ startDate: "2026-03-01", endDate: "2026-03-31" })).toEqual({ startDate: "2026-01-29", endDate: "2026-02-28" });
  });
});
