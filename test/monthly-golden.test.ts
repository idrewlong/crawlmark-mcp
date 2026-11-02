/**
 * Golden test (Phase 12 A-3): monthly_report's output must stay byte-identical while its helpers are
 * shared with report templates. The fixture was captured from `main` before the refactor; regenerate it
 * only for an intended output change (UPDATE_GOLDEN=1 npx vitest run test/monthly-golden.test.ts).
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
// The history save depends on today's date and on what earlier runs stored; a fixed answer keeps the golden stable.
vi.mock("../src/lib/gsc-monthly.js", () => ({
  fillGscMonths: vi.fn(async () => ({ stored: ["2026-09", "2026-08"], skipped: [], failed: [] })),
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
const FIXTURE = join(import.meta.dirname, "fixtures", "reports", "monthly-golden.json");

describe("monthly_report golden output", () => {
  it("is byte-identical to the output captured before the Phase 12 refactor", async () => {
    const client = data.CLIENT as never;
    const out = JSON.stringify(
      {
        default: await monthlyReport(client, { month: "2026-09" }),
        liveRanks: await monthlyReport(client, { month: "2026-09", liveRanks: true }),
        july: await monthlyReport(client, { month: "2026-07" }),
      },
      null,
      2,
    ) + "\n";
    if (process.env.UPDATE_GOLDEN === "1" || !existsSync(FIXTURE)) writeFileSync(FIXTURE, out);
    expect(out).toBe(readFileSync(FIXTURE, "utf8"));
  });
});
