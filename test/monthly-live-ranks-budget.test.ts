/**
 * monthly_report liveRanks reserves the whole run's estimate once (SEC-1), like check_ranks and the local tools:
 * a run that can't fit is refused before any SERP request, a fitting run reserves once and releases.
 * Real budget ledger (temp DATA_DIR from test/setup.ts); no Google, no DataForSEO.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import * as data from "./fixtures/reports/data.js";

vi.mock("../src/providers/gsc.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { gscQuery: vi.fn(async (c: unknown, o: never) => d.gscQuery(c, o)), gscTotals: vi.fn(async (c: unknown, r: never) => d.gscTotals(c, r)) };
});
vi.mock("../src/providers/ga4.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { ga4OrganicSummary: vi.fn(async (c: unknown, r: never) => d.ga4OrganicSummary(c, r)), ga4TopLandingPages: vi.fn(async (c: unknown, r: unknown, n?: number) => d.ga4TopLandingPages(c, r, n)) };
});
vi.mock("../src/providers/dataforseo.js", () => ({ ESTIMATE_USD: { serp: 0.002 } }));
vi.mock("../src/providers/seo-data.js", () => ({
  requireDataForSeo: vi.fn(),
  serp: vi.fn(async (_c: unknown, kw: string) => ({ keyword: kw, clientRank: 3, clientUrl: "https://example.com/", costUsd: 0.002, fromCache: false })),
}));
vi.mock("../src/lib/audits.js", async () => {
  const d = await import("./fixtures/reports/data.js");
  return { latestAudit: vi.fn(() => d.AUDIT_LATEST), latestAuditBefore: vi.fn(() => d.AUDIT_BEFORE) };
});
const reservations: number[] = [];
vi.mock("../src/lib/budget.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/budget.js")>();
  return {
    ...real,
    withUsdReservation: vi.fn((c: never, usd: number, fn: () => Promise<unknown>) => {
      reservations.push(usd);
      return real.withUsdReservation(c, usd, fn);
    }),
  };
});

const { monthlyReport } = await import("../src/reports/monthly.js");
const { serp } = await import("../src/providers/seo-data.js");
const { pendingUsd } = await import("../src/lib/budget.js");

type Tracked = { ok: boolean; data: { liveRank: number | null }[]; liveRanks?: { available: boolean; reason?: string } };

describe("monthly_report liveRanks budget reservation", () => {
  beforeEach(() => {
    reservations.length = 0;
    vi.mocked(serp).mockClear();
  });

  it("refuses a run whose total estimate exceeds the remaining budget before any fetch", async () => {
    // 3 tracked keywords x $0.002 = $0.006 > $0.005: each call alone would fit, the run does not.
    const client = { ...data.CLIENT, monthlyBudgetUsd: 0.005 } as never;
    const r = await monthlyReport(client, { month: "2026-09", liveRanks: true });
    expect(serp).not.toHaveBeenCalled();
    const t = r.trackedKeywords as unknown as Tracked;
    expect(t.liveRanks?.available).toBe(false);
    expect(t.liveRanks?.reason).toMatch(/no paid request was made.*\$0\.0060.*Budget cap hit/);
    expect(t.data.map((k) => k.liveRank)).toEqual([null, null, null]);
  });

  it("reserves the whole estimate once for a fitting run and releases it", async () => {
    const client = data.CLIENT as never;
    const r = await monthlyReport(client, { month: "2026-09", liveRanks: true });
    expect(reservations).toEqual([0.006]);
    expect(serp).toHaveBeenCalledTimes(3);
    expect((r.trackedKeywords as unknown as Tracked).data.map((k) => k.liveRank)).toEqual([3, 3, 3]);
    expect(pendingUsd(["example.com"])).toEqual({ client: 0, global: 0 });
  });

  it("makes no reservation without liveRanks", async () => {
    await monthlyReport(data.CLIENT as never, { month: "2026-09" });
    expect(reservations).toEqual([]);
    expect(serp).not.toHaveBeenCalled();
  });
});
