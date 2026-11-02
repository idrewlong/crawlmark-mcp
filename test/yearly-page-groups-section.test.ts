/**
 * Release 0.5.0 Y1.2: the page_groups section. Filtered mode sends N+1 page-filtered requests per range; stored mode
 * groups saved monthly top pages. Fixture Search Console (four pages); the saved history is mocked.
 */
import { describe, expect, it, vi } from "vitest";
import type { GscRow } from "../src/providers/gsc.js";
import { groupRegex, groupsRegex, defaultPageGroups } from "../src/lib/page-groups.js";
import type { YearlyCtx } from "../src/reports/yearly/context.js";
import type { ResolvedPeriod } from "../src/reports/templates/period.js";
import type { RunDeps } from "../src/reports/templates/run.js";
import type { SectionSpec } from "../src/reports/templates/schema.js";
import type { GscCoverage } from "../src/lib/gsc-coverage.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { PAGE_GROUPS, YEAR_2024, YEAR_2025 } from "./fixtures/reports/yearly-data.js";

const stored = vi.hoisted(() => ({ pages: new Map<string, unknown[]>(), totals: new Map<string, unknown[]>() }));
vi.mock("../src/lib/gsc-monthly.js", async (orig) => ({
  ...(await orig<typeof import("../src/lib/gsc-monthly.js")>()),
  readMonths: (_c: string, _p: string, months: string[], kind: string) => {
    const src = kind === "page" ? stored.pages : stored.totals;
    return new Map(months.filter((m) => src.has(m)).map((m) => [m, src.get(m)!]));
  },
}));

const { pageGroupsSection } = await import("../src/reports/yearly/page-groups.js");

type Spec = Extract<SectionSpec, { type: "page_groups" }>;
const spec = (over: Partial<Spec> = {}): Spec => ({ id: "page-types", type: "page_groups", ...over }) as Spec;
const GOOGLE: GscCoverage = { complete: true, source: "google" };

function ctx(over: { deps?: Partial<RunDeps>; period?: ResolvedPeriod; coverage?: (r: { startDate: string }) => GscCoverage; notes?: string[]; client?: Record<string, unknown> } = {}): YearlyCtx {
  const memo = new Map<string, Promise<unknown>>();
  const period: ResolvedPeriod = over.period ?? { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: YEAR_2024 } };
  const deps = fakeDeps(over.deps);
  return {
    client: { ...client, ...(over.client ?? {}) } as never,
    deps,
    today: new Date("2026-10-13T12:00:00Z"),
    period,
    gscPeriod: period,
    coverage: (r) => (over.coverage ? over.coverage(r) : GOOGLE),
    once: (k, fn) => {
      if (!memo.has(k)) memo.set(k, fn());
      return memo.get(k) as Promise<never>;
    },
    totals: async (r) => deps.gscTotals(client, r),
    note: (n) => over.notes?.push(n),
  };
}

const PAGE_FILTER_NOTE = "Search Console counts by page when you filter by page, so the page types can add up to more than the site's total clicks.";

describe("pageGroupsSection (filtered)", () => {
  it("matches the contract fixture for the default groups, 2025 against 2024", async () => {
    const notes: string[] = [];
    const data = await pageGroupsSection(spec(), ctx({ notes }));
    expect(data).toEqual(PAGE_GROUPS);
    expect(notes).toContain(PAGE_FILTER_NOTE);
  });

  it("sends N+1 requests per range with disjoint regexes", async () => {
    const calls: { startDate: string; dimensions?: string[]; pageRegex?: string; pageExcludeRegex?: string }[] = [];
    const gscQuery = vi.fn(async (c: unknown, o: never) => {
      calls.push(o);
      return fakeDeps().gscQuery(c as never, o);
    });
    await pageGroupsSection(spec(), ctx({ deps: { gscQuery } }));
    const groups = defaultPageGroups();
    const forRange = (start: string) => calls.filter((c) => c.startDate === start);
    for (const start of ["2025-01-01", "2024-01-01"]) {
      const list = forRange(start);
      expect(list).toHaveLength(groups.length + 1);
      expect(list.every((c) => (c.dimensions ?? []).length === 0)).toBe(true);
      groups.forEach((g, i) => {
        expect(list[i]!.pageRegex).toBe(groupRegex(g));
        expect(list[i]!.pageExcludeRegex).toBe(i > 0 ? groupsRegex(groups.slice(0, i)) : undefined);
      });
      expect(list[groups.length]!.pageRegex).toBeUndefined();
      expect(list[groups.length]!.pageExcludeRegex).toBe(groupsRegex(groups));
    }
  });

  it("puts rows in configured order then Other, shares add up to 100, and computes the change", async () => {
    const data = await pageGroupsSection(spec(), ctx());
    expect(data.rows.map((r) => r.name)).toEqual(["Home", "Blog", "Services", "Locations", "Other"]);
    expect(data.rows.reduce((a, r) => a + r.share, 0)).toBeGreaterThan(99.9);
    expect(data.rows.reduce((a, r) => a + r.share, 0)).toBeLessThan(100.1);
    const home = data.rows[0]!;
    expect(home.change).toEqual({ clicks: 33.3, clicksAbs: 105 });
    const locations = data.rows[3]!;
    expect(locations).toMatchObject({ clicks: 0, position: null, ctr: 0, change: { clicks: null, clicksAbs: 0 } });
  });

  it("keeps Other even when everything is matched, and has no comparison columns without one", async () => {
    const period: ResolvedPeriod = { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: {} };
    const data = await pageGroupsSection(spec({ groups: [{ name: "All", regex: [".*"] }] }), ctx({ period }));
    expect(data.comparedWith).toBeNull();
    expect(data.rows.map((r) => r.name)).toEqual(["All", "Other"]);
    expect(data.rows[1]).toMatchObject({ clicks: 0, impressions: 0, share: 0, previous: null, change: null });
    expect(data.rows[0]).toMatchObject({ clicks: 770, previous: null, change: null, share: 100 });
  });

  it("uses the template's groups over the client's, and the client's YAML groups over the defaults", async () => {
    const tpl = await pageGroupsSection(spec({ groups: [{ name: "Shop", prefix: ["/services/"] }] }), ctx({ client: { pageGroups: [{ name: "X", prefix: ["/blog/"] }], pageGroupsSource: "yaml" } }));
    expect(tpl.groupsSource).toBe("template");
    expect(tpl.rows.map((r) => r.name)).toEqual(["Shop", "Other"]);
    expect(tpl.rows[0]!.clicks).toBe(200);
    const yaml = await pageGroupsSection(spec(), ctx({ client: { pageGroups: [{ name: "X", prefix: ["/blog/"] }], pageGroupsSource: "yaml" } }));
    expect(yaml.groupsSource).toBe("yaml");
    expect(yaml.rows.map((r) => [r.name, r.clicks])).toEqual([["X", 110], ["Other", 660]]);
  });

  it("matches case-sensitively, like Search Console", async () => {
    const data = await pageGroupsSection(spec({ groups: [{ name: "Blog", prefix: ["/BLOG/"] }] }), ctx());
    expect(data.rows[0]!.clicks).toBe(0);
  });

  it("uses the comparison the coverage guard kept (none when it was dropped)", async () => {
    const period: ResolvedPeriod = { current: YEAR_2025, label: "2025", folderMonth: "2025-12", comparisons: { previous_year: YEAR_2024 } };
    const dropped = await pageGroupsSection(spec(), ctx({ period: { ...period, comparisons: {} } }));
    expect(dropped.comparedWith).toBeNull();
    expect(dropped.rows.every((r) => r.previous === null)).toBe(true);
  });
});

const rowOf = (url: string, clicks: number, impressions: number, position = 5): GscRow => ({ keys: [url], clicks, impressions, ctr: 0, position });

describe("pageGroupsSection (stored top pages)", () => {
  const months = ["2023-01", "2023-02", "2023-03", "2023-04", "2023-05", "2023-06", "2023-07", "2023-08", "2023-09", "2023-10", "2023-11", "2023-12"];
  const YEAR_2023 = { startDate: "2023-01-01", endDate: "2023-12-31" };
  const period: ResolvedPeriod = { current: YEAR_2023, label: "2023", folderMonth: "2023-12", comparisons: {} };

  it("groups saved pages, reports what couldn't be assigned, and notes it", async () => {
    for (const m of months) {
      stored.pages.set(m, [rowOf("https://example.com/", 10, 100, 2), rowOf("https://example.com/blog/a", 5, 50, 8), rowOf("https://example.com/blog/b", 5, 50, 10), rowOf("https://example.com/zzz", 4, 40, 6)]);
      stored.totals.set(m, [{ keys: [], clicks: 40, impressions: 400, ctr: 10, position: 5 }]);
    }
    const notes: string[] = [];
    const gscQuery = vi.fn();
    const data = await pageGroupsSection(spec(), ctx({ period, notes, deps: { gscQuery }, coverage: () => ({ complete: true, source: "stored" }) }));
    expect(gscQuery).not.toHaveBeenCalled();
    expect(data.method).toBe("stored_top_pages");
    expect(Object.fromEntries(data.rows.map((r) => [r.name, r.clicks]))).toEqual({ Home: 120, Blog: 120, Services: 0, Locations: 0, Other: 48 });
    expect(data.rows.find((r) => r.name === "Blog")).toMatchObject({ impressions: 1200, position: 9 });
    // Stored totals 480 clicks; rows sum to 288.
    expect(data.unattributed).toEqual({ clicks: 192, impressions: 1920 });
    expect(notes).toContain("From saved monthly history, which keeps each month's top 250 pages; 40% of clicks couldn't be assigned to a page type.");
    expect(notes).toContain(PAGE_FILTER_NOTE);
  });
});
