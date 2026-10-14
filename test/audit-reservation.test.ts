/**
 * run_audit's two parallel paid site checks (full crawl start + a DataForSEO backlinks summary) are reserved together
 * (SEC-1). Real budget ledger; the providers are stubs, so nothing is requested.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const attempts: { usd: number; outcome: "reserved" | "refused" }[] = [];
vi.mock("../src/lib/budget.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/budget.js")>();
  return {
    ...real,
    withUsdReservation: vi.fn(async (c: never, usd: number, fn: () => Promise<unknown>) => {
      try {
        return await real.withUsdReservation(c, usd, () => (attempts.push({ usd, outcome: "reserved" }), fn()));
      } catch (err) {
        if (err instanceof real.BudgetExceededError && !attempts.some((a) => a.usd === usd && a.outcome === "reserved")) attempts.push({ usd, outcome: "refused" });
        throw err;
      }
    }),
  };
});
vi.mock("../src/providers/seo-data.js", () => ({
  requireDataForSeo: vi.fn(),
  routeProvider: vi.fn(async () => ({ provider: "dataforseo" })),
  backlinksSummary: vi.fn(async () => ({ summary: null, provider: "dataforseo" })),
  onPageStartCrawl: vi.fn(async () => ({ taskId: "t1", costUsd: 0.045 })),
  instantPage: vi.fn(),
}));
vi.mock("../src/providers/gsc.js", () => ({ gscSitemaps: vi.fn(async () => []), gscInspectUrl: vi.fn() }));
vi.mock("../src/reports/site-hygiene.js", () => ({ siteHygiene: vi.fn(async () => ({ flags: [], checked: [], notes: [] })) }));

const { runAudit, paidSiteChecksUsd } = await import("../src/reports/audit.js");
const seo = await import("../src/providers/seo-data.js");

let n = 0;
const client = (monthlyBudgetUsd: number): Client => {
  const slug = `aud${++n}.example.com`;
  return { slug, domain: slug, name: "Example", aliases: [], keyPages: [], competitors: [], monthlyBudgetUsd, locationCode: 2840, languageCode: "en", country: "US", monthlyUnits: { ahrefs: 1000, semrush: 1000 } } as unknown as Client;
};

describe("run_audit reserves its paid site checks together", () => {
  beforeEach(() => {
    attempts.length = 0;
    vi.mocked(seo.backlinksSummary).mockClear();
    vi.mocked(seo.onPageStartCrawl).mockClear();
  });

  it("prices the crawl by its page count and the backlinks summary at the flat estimate", async () => {
    const c = client(5);
    expect(await paidSiteChecksUsd(c, {})).toBe(0);
    expect(await paidSiteChecksUsd(c, { backlinks: true })).toBe(0.025);
    expect(await paidSiteChecksUsd(c, { fullCrawl: true, maxCrawlPages: 200 })).toBe(0.09);
    expect(await paidSiteChecksUsd(c, { fullCrawl: true, backlinks: true })).toBe(0.07);
    vi.mocked(seo.routeProvider).mockResolvedValueOnce({ provider: "ahrefs" });
    expect(await paidSiteChecksUsd(c, { backlinks: true })).toBe(0); // units provider: no USD
  });

  it("reserves the sum once, then makes both calls", async () => {
    await runAudit(client(5), { urls: [], fullCrawl: true, backlinks: true });
    expect(attempts).toEqual([{ usd: 0.07, outcome: "reserved" }]);
    expect(seo.backlinksSummary).toHaveBeenCalledTimes(1);
    expect(seo.onPageStartCrawl).toHaveBeenCalledTimes(1);
  });

  it("when the sum doesn't fit, nothing is reserved and each check is left to its own cap", async () => {
    await runAudit(client(0.03), { urls: [], fullCrawl: true, backlinks: true });
    expect(attempts).toEqual([{ usd: 0.07, outcome: "refused" }]);
    expect(seo.backlinksSummary).toHaveBeenCalledTimes(1); // the stubs don't check a cap; the real ones do (dataforseo-reservation.test.ts)
  });

  it("reserves nothing without a paid option", async () => {
    await runAudit(client(5), { urls: [] });
    expect(attempts).toEqual([]);
  });
});
