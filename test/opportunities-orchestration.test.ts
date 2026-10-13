/** Orchestration tests for the opportunity runners and monthly_report, with Search Console mocked. */
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ gscQuery: vi.fn(), gscTotals: vi.fn() }));
vi.mock("../src/providers/gsc.js", () => ({ gscQuery: m.gscQuery, gscTotals: m.gscTotals }));
vi.mock("../src/providers/ga4.js", () => ({
  ga4OrganicSummary: vi.fn(async () => ({ sessions: 1, users: 1, engagementRate: 1, keyEvents: 0 })),
  ga4TopLandingPages: vi.fn(async () => []),
}));
vi.mock("../src/providers/dataforseo.js", () => ({ serp: vi.fn() }));
vi.mock("../src/lib/audits.js", () => ({ latestAudit: vi.fn(() => undefined), latestAuditBefore: vi.fn(() => undefined) }));
vi.mock("../src/lib/budget.js", () => ({ spentThisMonth: vi.fn(() => 0) }));

const { runDecliningPages, opportunitiesForMonth, OPP_ROW_LIMIT } = await import("../src/reports/opportunities.js");
const { monthlyReport } = await import("../src/reports/monthly.js");

const client = {
  slug: "example.com", name: "Example Plumbing", domain: "exampleplumbing.com", sources: [], aliases: [], brandTerms: [],
  trackedKeywords: [], competitors: [], keyPages: [], alternates: { gsc: [], ga4: [] },
} as never;
const P = "https://example.com";
const qp = (q: string, page: string, impressions: number, clicks: number, position: number) => ({
  keys: [q, page], clicks, impressions, ctr: (clicks / impressions) * 100, position,
});
const range = { startDate: "2026-09-01", endDate: "2026-09-30" };

beforeEach(() => {
  m.gscQuery.mockReset();
  m.gscTotals.mockReset();
  m.gscQuery.mockResolvedValue([]);
  m.gscTotals.mockResolvedValue({ keys: [], clicks: 1, impressions: 1, ctr: 1, position: 1 });
});

describe("declining_pages call count", () => {
  it("makes 2 GSC calls by default and 4 with includeBranded", async () => {
    await runDecliningPages(client, {});
    expect(m.gscQuery).toHaveBeenCalledTimes(2);
    expect(m.gscQuery.mock.calls.every((c) => c[1].dimensions.join() === "query,page")).toBe(true);
    m.gscQuery.mockClear();
    await runDecliningPages(client, { includeBranded: true });
    expect(m.gscQuery).toHaveBeenCalledTimes(4);
    expect(m.gscQuery.mock.calls.filter((c) => c[1].dimensions.join() === "page")).toHaveLength(2);
  });
});

describe("opportunitiesForMonth", () => {
  it("returns top lists from one call, with no warning under the row limit", async () => {
    m.gscQuery.mockResolvedValue([qp("fix tap", `${P}/a`, 500, 5, 8), qp("example plumbing", `${P}/a`, 900, 90, 1)]);
    const out = await opportunitiesForMonth(client, range, 5);
    expect(m.gscQuery).toHaveBeenCalledTimes(1);
    expect(out.strikingDistance.top.map((r) => r.query)).toEqual(["fix tap"]);
    expect("warning" in out).toBe(false);
  });

  it("warns when Search Console returns the row limit", async () => {
    m.gscQuery.mockResolvedValue(Array.from({ length: OPP_ROW_LIMIT }, (_, i) => qp(`q${i}`, `${P}/a`, 1, 0, 30)));
    const out = await opportunitiesForMonth(client, range, 5);
    expect((out as { warning?: string }).warning).toMatch(/row limit/);
  });
});

describe("monthly_report opportunities section", () => {
  it("includes the section for the report month", async () => {
    m.gscQuery.mockResolvedValue([qp("fix tap", `${P}/a`, 500, 5, 8)]);
    const r = await monthlyReport(client, { month: "2026-09" });
    const o = r.opportunities as { window: unknown; strikingDistance: { total: number } };
    expect(o.window).toEqual(range);
    expect(o.strikingDistance.total).toBe(1);
  });

  it("isolates an opportunities failure", async () => {
    m.gscQuery.mockImplementation(async (_c: unknown, o: { dimensions: string[] }) => {
      if (o.dimensions.join() === "query,page") throw new Error("boom");
      return [];
    });
    const r = await monthlyReport(client, { month: "2026-09" });
    expect(r.opportunities).toEqual({ error: "boom" });
    expect(r.month).toBe("2026-09");
  });
});
