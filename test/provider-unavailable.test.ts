/**
 * Reports when no SERP provider is available (spec 9.5 "Where unavailable shows up"): DataForSEO is
 * not configured in this file, so live SERPs, on-page checks and crawls are unavailable, not failed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// No DataForSEO login for this file (test/setup.ts sets a fake one for the others).
delete process.env.DATAFORSEO_LOGIN;
delete process.env.DATAFORSEO_PASSWORD;

const m = vi.hoisted(() => ({ gscQuery: vi.fn(), gscTotals: vi.fn(), serp: vi.fn(), serpOrganic: vi.fn(), competitorDomains: vi.fn(), rankedKeywords: vi.fn() }));
vi.mock("../src/providers/gsc.js", () => ({ gscQuery: m.gscQuery, gscTotals: m.gscTotals }));
vi.mock("../src/providers/ga4.js", () => ({
  ga4OrganicSummary: vi.fn(async () => ({ sessions: 1, users: 1, engagementRate: 1, keyEvents: 0 })),
  ga4TopLandingPages: vi.fn(async () => []),
}));
vi.mock("../src/providers/dataforseo.js", () => ({ serp: m.serp, serpOrganic: m.serpOrganic, competitorDomains: m.competitorDomains, rankedKeywords: m.rankedKeywords }));
vi.mock("../src/lib/audits.js", () => ({ latestAudit: vi.fn(() => undefined), latestAuditBefore: vi.fn(() => undefined) }));

const { monthlyReport } = await import("../src/reports/monthly.js");
const { section } = await import("../src/reports/section.js");
const { ProviderUnavailableError, requireDataForSeo } = await import("../src/providers/seo-data.js");

const client = {
  slug: "example.com", name: "Example Co", domain: "example.com", sources: [], aliases: [], brandTerms: [],
  trackedKeywords: ["example widgets"], competitors: [], keyPages: [], alternates: { gsc: [], ga4: [] },
  locationCode: 2840, languageCode: "en", country: "US", monthlyBudgetUsd: 5, monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
} as never;

beforeEach(() => {
  vi.clearAllMocks();
  m.gscQuery.mockResolvedValue([{ keys: ["example widgets"], clicks: 3, impressions: 40, ctr: 7.5, position: 4.2 }]);
  m.gscTotals.mockResolvedValue({ keys: [], clicks: 1, impressions: 1, ctr: 1, position: 1 });
});

describe("without DataForSEO", () => {
  it("section() marks ProviderUnavailableError sections unavailable; other errors stay plain", async () => {
    expect(await section(async () => requireDataForSeo("onPageInstant", client))).toEqual({
      ok: false,
      error: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. See .env.example.",
      unavailable: true,
    });
    expect(await section(async () => { throw new Error("boom"); })).toEqual({ ok: false, error: "boom" });
    expect(new ProviderUnavailableError("serpLive", null, "x").name).toBe("ProviderUnavailableError");
  });

  it("monthly_report liveRanks keeps the GSC values with liveRanks.available false, and makes no SERP call", async () => {
    const r = await monthlyReport(client, { month: "2026-09", liveRanks: true });
    const tracked = r.trackedKeywords as { ok: true; data: { gscPosition: number; liveRank: null }[]; liveRanks: { available: boolean; reason: string } };
    expect(tracked.ok).toBe(true);
    expect(tracked.data[0]).toMatchObject({ keyword: "example widgets", gscPosition: 4.2, liveRank: null });
    expect(tracked.liveRanks).toEqual({ available: false, reason: expect.stringContaining("DATAFORSEO_LOGIN") });
    expect(m.serp).not.toHaveBeenCalled();
  });

  it("monthly_report without liveRanks is unchanged (no liveRanks field)", async () => {
    const r = await monthlyReport(client, { month: "2026-09" });
    expect("liveRanks" in (r.trackedKeywords as object)).toBe(false);
  });
});
