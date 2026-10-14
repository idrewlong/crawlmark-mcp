/**
 * Phase 12 B-2: monthly_report with liveRanks also saves each tracked keyword's live rank to
 * rank_history (a side effect only; monthly-golden.test.ts proves the output is unchanged).
 * Same mocks as the golden test: no Google, no DataForSEO.
 */
import { describe, expect, it, vi } from "vitest";
import * as data from "./fixtures/reports/data.js";

vi.mock("../src/providers/gsc.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { gscQuery: vi.fn(async (c: unknown, o: never) => d.gscQuery(c, o)), gscTotals: vi.fn(async (c: unknown, r: never) => d.gscTotals(c, r)) };
});
vi.mock("../src/providers/ga4.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { ga4OrganicSummary: vi.fn(async (c: unknown, r: never) => d.ga4OrganicSummary(c, r)), ga4TopLandingPages: vi.fn(async (c: unknown, r: unknown, n?: number) => d.ga4TopLandingPages(c, r, n)) };
});
vi.mock("../src/providers/dataforseo.js", () => ({
  serp: vi.fn(async (_c: unknown, kw: string) => ({ keyword: kw, clientRank: kw.length % 7, clientUrl: "https://example.com/", costUsd: 0.002, fromCache: false })),
  ESTIMATE_USD: { serp: 0.002 },
}));
vi.mock("../src/lib/audits.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { latestAudit: vi.fn(() => d.AUDIT_LATEST), latestAuditBefore: vi.fn(() => d.AUDIT_BEFORE) };
});
vi.mock("../src/lib/budget.js", () => ({
  spentThisMonth: vi.fn(() => 0.12345),
  BudgetExceededError: class extends Error {},
  withUsdReservation: vi.fn(async (_c: unknown, _usd: number, fn: () => Promise<unknown>) => fn()),
}));

const { monthlyReport } = await import("../src/reports/monthly.js");
const { readRanks } = await import("../src/lib/rank-history.js");

describe("monthly_report liveRanks persistence", () => {
  it("writes nothing without liveRanks and one serp row per tracked keyword with it", async () => {
    const client = data.CLIENT as never;
    const today = new Date().toISOString().slice(0, 10);
    await monthlyReport(client, { month: "2026-09" });
    expect(readRanks({ client: "example.com", since: today, until: today })).toEqual([]);
    const r = await monthlyReport(client, { month: "2026-09", liveRanks: true });
    const rows = readRanks({ client: "example.com", since: today, until: today, source: "serp" });
    expect(rows.map((x) => [x.keyword, x.rank])).toEqual(data.CLIENT.trackedKeywords.map((k) => [k, k.length % 7]).sort());
    expect((r.trackedKeywords as { ok: boolean; data: { liveRank: number | null }[] }).data.map((k) => k.liveRank)).toEqual(data.CLIENT.trackedKeywords.map((k) => k.length % 7));
  });
});
