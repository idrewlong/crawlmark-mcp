/**
 * Release 0.5.0 Y1.3: the wins and misses rules (src/analysis/wins-misses.ts, pure, one case per boundary) and the
 * wins_misses section that feeds them. Fixture Search Console and GA4; no network.
 */
import { describe, expect, it, vi } from "vitest";
import { winsAndMisses, WM } from "../src/analysis/wins-misses.js";
import type { GscRow } from "../src/providers/gsc.js";
import type { YearlyCtx } from "../src/reports/yearly/context.js";
import { winsMissesSection } from "../src/reports/yearly/wins-misses.js";
import type { ResolvedPeriod } from "../src/reports/templates/period.js";
import type { RunDeps } from "../src/reports/templates/run.js";
import type { SectionSpec } from "../src/reports/templates/schema.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { YEAR_2024, YEAR_2025 } from "./fixtures/reports/yearly-data.js";

type Input = Parameters<typeof winsAndMisses>[0];
const row = (key: string, clicks: number, impressions: number, position: number): GscRow => ({ keys: key ? [key] : [], clicks, impressions, ctr: 0, position });
const BIG = 100_000;
const same = (clicks = BIG, position = 7) => row("", clicks, BIG * 10, position);

/** Inputs where nothing changed, with overrides. */
function input(over: Partial<Input> = {}): Input {
  return {
    totals: { cur: same(), prev: same() },
    pages: { cur: [], prev: [] },
    queries: { cur: [], prev: [] },
    goals: [],
    limit: 10,
    isBranded: (q) => q.includes("acme"),
    ...over,
  };
}
const texts = (r: ReturnType<typeof winsAndMisses>) => ({ wins: r.wins.map((x) => `${x.rule}:${x.text}`), misses: r.misses.map((x) => `${x.rule}:${x.text}`) });
const kinds = (list: { rule: string }[]) => list.map((x) => x.rule);

describe("thresholds", () => {
  it("are the published numbers", () => {
    expect(WM).toEqual({ kpiPct: 5, kpiAbs: 20, positionMove: 1.0, pageAbs: 20, pagePct: 25, queryMinImpr: 100 });
  });
});

describe("kpi rule (clicks)", () => {
  const clicks = (prev: number, cur: number) => winsAndMisses(input({ totals: { cur: same(cur), prev: same(prev) } }));
  it.each([
    ["+5% and +20 is a win", 400, 420, "win"],
    ["+4.9% is nothing", 1000, 1049, null],
    ["+5% but only +19 is nothing", 380, 399, null],
    ["-5% and -20 is a miss", 400, 380, "miss"],
    ["-4.9% is nothing", 1000, 951, null],
    ["-5% but only -19 is nothing", 380, 361, null],
    ["a big rise from nothing is a win", 0, 25, "win"],
  ])("%s", (_name, prev, cur, side) => {
    const r = clicks(prev, cur);
    expect(r.wins.filter((x) => x.rule === "kpi").length).toBe(side === "win" ? 1 : 0);
    expect(r.misses.filter((x) => x.rule === "kpi").length).toBe(side === "miss" ? 1 : 0);
  });
  it("words the item", () => {
    expect(clicks(840, 1120).wins[0]).toEqual({ kind: "win", rule: "kpi", text: "Search clicks rose 33.3% (1120 against 840)", metric: "clicks", current: 1120, previous: 840 });
    expect(clicks(400, 380).misses[0]!.text).toBe("Search clicks fell 5% (380 against 400)");
  });
  it("covers impressions, GA4 sessions and key events the same way", () => {
    const r = winsAndMisses(
      input({
        totals: { cur: row("", BIG, 5000, 7), prev: row("", BIG, 4000, 7) },
        ga4: { cur: { sessions: 500, users: 1, engagementRate: 1, keyEvents: 30 }, prev: { sessions: 400, users: 1, engagementRate: 1, keyEvents: 20 } },
      }),
    );
    expect(r.wins.map((x) => x.metric)).toEqual(["impressions", "sessions"]);
    expect(r.misses).toEqual([]);
  });
});

describe("kpi rule (average position)", () => {
  const pos = (prev: number, cur: number) => winsAndMisses(input({ totals: { cur: same(BIG, cur), prev: same(BIG, prev) } }));
  it.each([
    ["1.0 lower is a win", 7, 6, "win"],
    ["0.9 lower is nothing", 7, 6.1, null],
    ["1.0 higher is a miss", 7, 8, "miss"],
    ["0.9 higher is nothing", 7, 7.9, null],
    ["1.0 across a float edge is still 1.0", 6.9, 5.9, "win"],
  ])("%s", (_name, prev, cur, side) => {
    const r = pos(prev, cur);
    expect(r.wins.filter((x) => x.metric === "position").length).toBe(side === "win" ? 1 : 0);
    expect(r.misses.filter((x) => x.metric === "position").length).toBe(side === "miss" ? 1 : 0);
  });
  it("words the item and skips a side with no impressions", () => {
    expect(pos(7, 8.2).misses[0]!.text).toBe("Average position slipped from 7.0 to 8.2");
    expect(pos(8.2, 7).wins[0]!.text).toBe("Average position improved from 8.2 to 7.0");
    const none = winsAndMisses(input({ totals: { cur: row("", BIG, 0, 0), prev: same(BIG, 7) } }));
    expect(none.wins.concat(none.misses).filter((x) => x.metric === "position")).toEqual([]);
  });
});

describe("page rules", () => {
  const url = (p: string) => `https://example.com${p}`;
  const pages = (prev: number | null, cur: number | null) =>
    winsAndMisses(input({ pages: { prev: prev === null ? [] : [row(url("/a"), prev, 100, 3)], cur: cur === null ? [] : [row(url("/a"), cur, 100, 3)] } }));
  it.each([
    ["exactly the 20-click floor is a win (prev 80)", 80, 100, "page", "win"],
    ["one below the floor is nothing", 80, 99, null, null],
    ["exactly 25% above the floor is a win (prev 200)", 200, 250, "page", "win"],
    ["one below 25% is nothing", 200, 249, null, null],
    ["a drop of exactly the floor is a miss", 80, 60, "page", "miss"],
    ["a drop one short of the floor is nothing", 80, 61, null, null],
    ["a drop of exactly 25% is a miss", 200, 150, "page", "miss"],
    ["a new page at 20 clicks is a win", null, 20, "page_new", "win"],
    ["a new page at 19 clicks is nothing", null, 19, null, null],
    ["a page that had 0 and now has 20 is new", 0, 20, "page_new", "win"],
    ["a page that had 20 and is gone is lost", 20, null, "page_lost", "miss"],
    ["a page that had 19 and is gone is nothing", 19, null, null, null],
    ["a page that had 40 and now has 0 is lost", 40, 0, "page_lost", "miss"],
  ])("%s", (_name, prev, cur, rule, side) => {
    const r = pages(prev, cur);
    expect(kinds(r.wins)).toEqual(side === "win" ? [rule] : []);
    expect(kinds(r.misses)).toEqual(side === "miss" ? [rule] : []);
  });
  it("words the items", () => {
    expect(pages(80, 100).wins[0]).toMatchObject({ text: "https://example.com/a gained 20 clicks", metric: "clicks", current: 100, previous: 80 });
    expect(pages(80, 60).misses[0]!.text).toBe("https://example.com/a lost 20 clicks");
    expect(pages(null, 25).wins[0]).toMatchObject({ text: "https://example.com/a is new, with 25 clicks", current: 25, previous: null });
    expect(pages(45, null).misses[0]).toMatchObject({ text: "https://example.com/a lost its 45 clicks", current: 0, previous: 45 });
  });
});

describe("query rules", () => {
  const q = (prev: [number, number] | null, cur: [number, number] | null, key = "leak detection") =>
    winsAndMisses(input({ queries: { prev: prev ? [row(key, 1, prev[1], prev[0])] : [], cur: cur ? [row(key, 1, cur[1], cur[0])] : [] } }));
  it.each([
    ["entering the top 3 at 100 impressions", [4, 500], [3.0, 100], ["query_top3"], []],
    ["entering the top 3 at 99 impressions", [4, 500], [2.9, 99], [], []],
    ["a brand-new query in the top 3", null, [2, 300], ["query_top3"], []],
    ["staying in the top 3", [2.5, 500], [1.5, 500], [], []],
    ["just missing the top 3 (3.1) is not the top 3", [4, 500], [3.1, 500], [], []],
    ["entering the top 10 from beyond it", [12, 500], [9, 500], ["query_top10"], []],
    ["jumping from outside the top 10 into the top 3 is reported once, as top 3", [12, 500], [2, 500], ["query_top3"], []],
    ["entering the top 10 at 99 impressions", [12, 500], [9, 99], [], []],
    ["leaving the top 3 (prev 100 impressions)", [2, 100], [5, 400], [], ["query_top3"]],
    ["leaving the top 3 with only 99 impressions before", [2, 99], [5, 400], [], []],
    ["falling out of the top 3 and the top 10 is reported once, as top 3", [2, 500], [12, 500], [], ["query_top3"]],
    ["leaving the top 10 only", [8, 500], [14, 500], [], ["query_top10"]],
    ["dropping out of the rows altogether from the top 10", [8, 500], null, [], ["query_top10"]],
    ["dropping out of the rows altogether from the top 3", [2, 500], null, [], ["query_top3"]],
  ] as const)("%s", (_name, prev, cur, wins, misses) => {
    const r = q(prev ? [...prev] : null, cur ? [...cur] : null);
    expect(kinds(r.wins)).toEqual(wins);
    expect(kinds(r.misses)).toEqual(misses);
  });
  it("ignores branded queries", () => {
    const r = q([12, 500], [1, 500], "acme plumbing");
    expect(r.wins.concat(r.misses)).toEqual([]);
  });
  it("words the items", () => {
    expect(q([4.9, 500], [2.4, 500]).wins[0]).toEqual({ kind: "win", rule: "query_top3", text: '"leak detection" moved into the top 3', metric: "position", current: 2.4, previous: 4.9 });
    expect(q([8.1, 500], [11.4, 500]).misses[0]).toMatchObject({ rule: "query_top10", text: '"leak detection" dropped out of the top 10', current: 11.4, previous: 8.1 });
  });
});

describe("goals", () => {
  const goals = [
    { metric: "clicks", target: 1000, label: "Search clicks" },
    { metric: "impressions", target: 20_000 },
    { metric: "sessions", target: 2000 },
    { metric: "keyEvents", target: 40 },
  ] as const;
  const ga4 = { cur: { sessions: 1500, users: 1, engagementRate: 1, keyEvents: 40 }, prev: { sessions: 1125, users: 1, engagementRate: 1, keyEvents: 30 } };
  it("marks a goal met at the target and missed with the percentage", () => {
    const r = winsAndMisses(input({ totals: { cur: row("", 1120, 19_999, 7), prev: row("", 840, 15_000, 7) }, ga4, goals: [...goals] }));
    expect(r.goals.map((g) => [g.kind, g.text])).toEqual([
      ["win", "Goal met: Search clicks 1120 (target 1000)"],
      ["miss", "Goal missed: impressions 19999 of 20000 (99%)"],
      ["miss", "Goal missed: sessions 1500 of 2000 (75%)"],
      ["win", "Goal met: keyEvents 40 (target 40)"],
    ]);
    expect(r.goals[0]).toMatchObject({ rule: "goal", metric: "clicks", current: 1120, previous: 840, target: 1000 });
    expect(r.skippedGoals).toEqual([]);
  });
  it("lists a GA4 goal with no GA4 data as skipped", () => {
    const r = winsAndMisses(input({ goals: [...goals] }));
    expect(r.goals.map((g) => g.metric)).toEqual(["clicks", "impressions"]);
    expect(r.skippedGoals).toEqual(["sessions", "keyEvents"]);
  });
  it("shows every goal outside the limit", () => {
    const r = winsAndMisses(input({ limit: 1, goals: [...goals], ga4 }));
    expect(r.goals).toHaveLength(4);
  });
  it("works with no previous period", () => {
    const r = winsAndMisses(input({ totals: { cur: same(1200), prev: null }, goals: [{ metric: "clicks", target: 1000 }] }));
    expect(r.goals[0]).toMatchObject({ kind: "win", previous: null });
    expect(r.wins).toEqual([]);
    expect(r.misses).toEqual([]);
  });
});

describe("ordering and the limit", () => {
  it("runs kpi, then pages, then queries, larger change first, each side cut to the limit", () => {
    const u = (p: string) => `https://example.com/${p}`;
    const r = winsAndMisses(
      input({
        limit: 4,
        totals: { cur: same(BIG + 6000), prev: same(BIG) },
        pages: {
          prev: [row(u("a"), 100, 1, 1), row(u("b"), 100, 1, 1), row(u("c"), 100, 1, 1)],
          cur: [row(u("a"), 130, 1, 1), row(u("b"), 200, 1, 1), row(u("c"), 160, 1, 1), row(u("new"), 50, 1, 1)],
        },
        queries: { prev: [row("q1", 1, 500, 5), row("q2", 1, 500, 20)], cur: [row("q1", 1, 500, 2), row("q2", 1, 500, 4)] },
      }),
    );
    expect(texts(r).wins).toEqual([
      "kpi:Search clicks rose 6% (106000 against 100000)",
      "page:https://example.com/b gained 100 clicks",
      "page:https://example.com/c gained 60 clicks",
      "page:https://example.com/a gained 30 clicks",
    ]);
    // the limit cut page_new and both query wins
    expect(r.wins).toHaveLength(4);
    const uncut = winsAndMisses(
      input({
        limit: 10,
        pages: { prev: [row(u("a"), 100, 1, 1)], cur: [row(u("a"), 130, 1, 1), row(u("new"), 50, 1, 1)] },
        queries: { prev: [row("q1", 1, 500, 5), row("q2", 1, 500, 20)], cur: [row("q1", 1, 500, 2), row("q2", 1, 500, 4)] },
      }),
    );
    // top 3 larger move first (q2 20 -> 4 is not top 3; q1 5 -> 2 is), then top 10
    expect(kinds(uncut.wins)).toEqual(["page", "page_new", "query_top3", "query_top10"]);
  });
});

// ------------------------------------------------------------------------------------------------ the section

type Spec = Extract<SectionSpec, { type: "wins_misses" }>;
const spec = (over: Partial<Spec> = {}): Spec => ({ id: "wins", type: "wins_misses", ...over }) as Spec;

function ctx(over: { deps?: Partial<RunDeps>; period?: ResolvedPeriod; gscPeriod?: ResolvedPeriod; client?: Record<string, unknown>; notes?: string[] } = {}): YearlyCtx {
  const memo = new Map<string, Promise<unknown>>();
  const period: ResolvedPeriod = over.period ?? { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: YEAR_2024 } };
  const deps = fakeDeps(over.deps);
  return {
    client: { ...client, ...(over.client ?? {}) } as never,
    deps,
    today: new Date("2026-10-13T12:00:00Z"),
    period,
    gscPeriod: over.gscPeriod ?? period,
    coverage: () => ({ complete: true, source: "google" }),
    once: (k, fn) => {
      if (!memo.has(k)) memo.set(k, fn());
      return memo.get(k) as Promise<never>;
    },
    totals: async (r) => deps.gscTotals(client, r),
    note: (n) => over.notes?.push(n),
  };
}
const noComparison: ResolvedPeriod = { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: {} };

describe("winsMissesSection", () => {
  it("compares 2025 with 2024 from the fixture Search Console and GA4 data", async () => {
    const data = await winsMissesSection(spec({ limit: 10 }), ctx());
    expect(data.comparedWith).toBe("previous_year");
    expect(data.goals).toEqual([]);
    expect(data.misses).toEqual([]);
    expect(data.skippedGoals).toEqual([]);
    expect(texts(data).wins).toEqual([
      // larger change first within the rule
      "kpi:Search impressions rose 33.3% (20000 against 15000)",
      "kpi:Organic sessions rose 33.3% (1500 against 1125)",
      "kpi:Search clicks rose 33.3% (1120 against 840)",
      "page:https://example.com/ gained 105 clicks",
      "page:https://example.com/services/emergency gained 50 clicks",
      "page:https://example.com/blog/water-heaters gained 27 clicks",
    ]);
  });

  it("reads pages and queries once each, 1000 rows, under their own memo keys", async () => {
    const gscQuery = vi.fn(async (c: unknown, o: never) => fakeDeps().gscQuery(c as never, o));
    const c = ctx({ deps: { gscQuery } });
    await winsMissesSection(spec(), c);
    await winsMissesSection(spec({ limit: 2 }), c);
    const sent = gscQuery.mock.calls.map(([, o]) => `${(o as { dimensions?: string[] }).dimensions?.join()}:${(o as { startDate: string }).startDate}:${(o as { rowLimit?: number }).rowLimit}`);
    expect(sent.sort()).toEqual(["page:2024-01-01:1000", "page:2025-01-01:1000", "query:2024-01-01:1000", "query:2025-01-01:1000"]);
  });

  it("cuts each side to the limit", async () => {
    const data = await winsMissesSection(spec({ limit: 2 }), ctx());
    expect(data.wins).toHaveLength(2);
  });

  it("uses the previous period when the year isn't there", async () => {
    const prevPeriod = { startDate: "2024-01-01", endDate: "2024-12-31" };
    const data = await winsMissesSection(spec(), ctx({ period: { ...noComparison, comparisons: { previous_period: prevPeriod } } }));
    expect(data.comparedWith).toBe("previous_period");
  });

  it("is unavailable without a comparison and without goals", async () => {
    await expect(winsMissesSection(spec(), ctx({ gscPeriod: noComparison }))).rejects.toMatchObject({ name: "SectionUnavailableError", message: "needs a comparison period or goals" });
  });

  it("shows only the goals without a comparison", async () => {
    const gscQuery = vi.fn(async (c: unknown, o: never) => fakeDeps().gscQuery(c as never, o));
    const data = await winsMissesSection(spec({ goals: [{ metric: "clicks", target: 1000, label: "Search clicks" }] }), ctx({ gscPeriod: noComparison, deps: { gscQuery } }));
    expect(data).toMatchObject({ comparedWith: null, wins: [], misses: [], skippedGoals: [] });
    expect(data.goals).toEqual([{ kind: "win", rule: "goal", text: "Goal met: Search clicks 1120 (target 1000)", metric: "clicks", current: 1120, previous: null, target: 1000 }]);
    expect(gscQuery).not.toHaveBeenCalled();
  });

  it("skips a GA4 goal when the client has no GA4 property, with a note", async () => {
    const notes: string[] = [];
    const data = await winsMissesSection(
      spec({ goals: [{ metric: "clicks", target: 1000 }, { metric: "sessions", target: 2000, label: "Organic visits" }] }),
      ctx({ client: { ga4PropertyId: undefined }, notes }),
    );
    expect(data.goals.map((g) => g.metric)).toEqual(["clicks"]);
    expect(data.skippedGoals).toEqual(["Organic visits"]);
    expect(notes).toEqual(["Goals left out because Google Analytics isn't connected for this client: Organic visits."]);
    expect(data.wins.some((w) => w.metric === "sessions")).toBe(false);
  });

  it("says so when Google Analytics can't be read, and still reports the Search Console results", async () => {
    const notes: string[] = [];
    const data = await winsMissesSection(
      spec({ goals: [{ metric: "sessions", target: 2000 }] }),
      ctx({ notes, deps: { ga4OrganicSummary: async () => Promise.reject(new Error("quota")) } }),
    );
    expect(data.skippedGoals).toEqual(["sessions"]);
    expect(data.wins.some((w) => w.metric === "clicks")).toBe(true);
    expect(notes).toContain("Google Analytics couldn't be read, so session and key-event figures are left out.");
  });
});
