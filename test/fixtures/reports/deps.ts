/** RunDeps built from the fixture data (no network, no Google). Override any member per test. */
import { monthlyAuditSection } from "../../../src/analysis/diff.js";
import type { Client } from "../../../src/config.js";
import type { RunDeps } from "../../../src/reports/templates/run.js";
import type { CruxHistoryResult } from "../../../src/reports/report-types.js";
import * as d from "./data.js";

export const client = d.CLIENT as unknown as Client;

export const CRUX_OK: CruxHistoryResult = {
  key: { origin: "https://example.com", formFactor: "PHONE" },
  keySource: "CRUX_API_KEY",
  available: true,
  periods: [
    { start: "2026-03-01", end: "2026-03-28" },
    { start: "2026-03-08", end: "2026-04-04" },
    { start: "2026-03-15", end: "2026-04-11" },
  ],
  metrics: {
    lcp: { unit: "ms", p75: [2900, 2600, 2300], latest: 2300, first: 2900, change: -600, rating: ["needs-improvement", "needs-improvement", "good"], trend: "improving" },
    cls: { unit: "score", p75: [0.05, null, 0.06], latest: 0.06, first: 0.05, change: 0.01, rating: ["good", null, "good"], trend: "insufficient-data" },
  },
  fromCache: false,
};

export const GTM_OK = {
  container: { publicId: "GTM-EXAMPLE", name: "example.com" },
  liveVersion: { versionId: "12", name: "Launch" },
  summary: { tags: 4, triggers: 3, variables: 5, findings: 2, bySeverity: { medium: 1, low: 1 }, consentModeDetected: false },
  findings: [
    { id: "g1", rule: "legacy-ua", severity: "medium" as const, title: "Universal Analytics tag <b>Old UA</b>", entity: { kind: "tag" as const, id: "7", name: "Old UA" }, evidence: "UA-1234-1" },
    { id: "g2", rule: "paused-tag", severity: "low" as const, title: "Paused tag: Test", entity: { kind: "tag" as const, id: "9", name: "Test" } },
  ],
  notes: [],
};

export function fakeDeps(over: Partial<RunDeps> = {}): RunDeps {
  return {
    googleConfigured: () => true,
    gscQuery: async (c, o) => d.gscQuery(c, o),
    gscTotals: async (c, r) => d.gscTotals(c, r),
    ga4OrganicSummary: async (c, r) => d.ga4OrganicSummary(c, r),
    ga4TopLandingPages: async (c, r, n) => d.ga4TopLandingPages(c, r, n),
    opportunitiesForMonth: async (_c, r, n) => ({
      window: r,
      method: "Fixture method.",
      strikingDistance: { total: 1, top: [{ query: "drain cleaning near me", topPage: "https://example.com/services/emergency", position: 11.3, impressions: 5200, clicks: 90, ctr: 1.73, estimatedExtraClicks: 400 }].slice(0, n) },
      lowCtr: { total: 0, top: [] },
      cannibalization: { total: 0, top: [] },
    }) as never,
    latestAudit: () => d.AUDIT_LATEST,
    latestAuditBefore: () => d.AUDIT_BEFORE,
    monthlyAuditSection: monthlyAuditSection as RunDeps["monthlyAuditSection"],
    spentThisMonth: () => 0.42,
    unitsThisMonth: () => 0,
    assertBudget: () => undefined,
    withUsdReservation: async (_c, _usd, fn) => fn(),
    serp: async () => ({ clientRank: 4, clientUrl: "https://example.com/" }),
    runGtmAudit: async () => GTM_OK as never,
    cruxHistory: async () => CRUX_OK,
    rankHistory: (c, o) => ({ client: c.slug, since: o.since ?? "2026-04-03", until: o.until ?? "2026-09-30", source: o.source ?? "both", keywords: [], note: "" }),
    keywordGap: async () => {
      throw new Error("keywordGap isn't part of this test");
    },
    gapCompetitors: (_c, passed) => (passed?.length ? [...passed] : ["competitor-a.example"]),
    latestLocalCrawl: () => undefined,
    ...over,
  };
}
