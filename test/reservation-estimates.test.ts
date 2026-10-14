/**
 * An enclosing reservation must cover what its inner per-call checks will ask for: each estimate is compared with the
 * estimates the real DataForSEO calls pass to withCallReservation (stubbed fetch, real code, no network).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const inner: number[] = [];
vi.mock("../src/lib/budget.js", async (orig) => {
  const real = await orig<typeof import("../src/lib/budget.js")>();
  return { ...real, withCallReservation: vi.fn((c: never, usd: number, fn: () => Promise<unknown>) => (inner.push(usd), real.withCallReservation(c, usd, fn))) };
});

const dfs = await import("../src/providers/dataforseo.js");
const { paidSiteChecksUsd } = await import("../src/reports/audit.js");
const { LIVE_RANK_ESTIMATE_USD } = await import("../src/reports/templates/run.js");

const fx = (n: string) => readFileSync(new URL(`./fixtures/dataforseo/${n}`, import.meta.url), "utf8");
const BODIES: Record<string, string> = {
  "/v3/backlinks/summary/live": fx("backlinks_summary_live.json"),
  "/v3/serp/google/organic/live/regular": fx("serp_google_organic_live_regular.json"),
  "/v3/on_page/task_post": JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.045, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created.", cost: 0.045, result: null }] }),
};
afterEach(() => {
  vi.unstubAllGlobals();
  inner.length = 0;
});
const stub = () =>
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => new Response(BODIES[new URL(input).pathname] ?? "{}", { status: BODIES[new URL(input).pathname] ? 200 : 404 })),
  );

let n = 0;
const client = (extra: Partial<Client> = {}): Client => {
  const slug = `est${++n}.example.com`;
  return { slug, domain: slug, name: "Example", aliases: [], competitors: [], trackedKeywords: ["a b", "c d", "e f"], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 50, country: "US", dataProvider: "dataforseo", monthlyUnits: { ahrefs: 1000, semrush: 1000 }, ...extra } as unknown as Client;
};
const sum = (xs: number[]) => Number(xs.reduce((a, b) => a + b, 0).toFixed(6));

describe("enclosing reservations cover their inner per-call estimates", () => {
  it("run_audit: the combined crawl + backlinks reservation covers both inner calls, at the default and a larger crawl", async () => {
    stub();
    for (const maxCrawlPages of [undefined, 400]) {
      const c = client();
      await dfs.backlinksSummary(c);
      await dfs.onPageStartCrawl(c, maxCrawlPages);
      const outer = await paidSiteChecksUsd(c, { fullCrawl: true, backlinks: true, ...(maxCrawlPages ? { maxCrawlPages } : {}) });
      expect(inner).toHaveLength(2);
      expect(outer).toBeGreaterThanOrEqual(sum(inner));
      inner.length = 0;
    }
  });

  it("monthly_report live ranks: keywords x the SERP estimate covers every inner serp call", async () => {
    stub();
    const c = client();
    for (const kw of c.trackedKeywords) await dfs.serp(c, kw, 100, { refresh: true });
    expect(inner).toHaveLength(c.trackedKeywords.length);
    expect(c.trackedKeywords.length * dfs.ESTIMATE_USD.serp).toBeGreaterThanOrEqual(sum(inner));
  });

  it("template runs: the per-keyword live-rank estimate is at least the SERP call's own", () => {
    expect(LIVE_RANK_ESTIMATE_USD).toBeGreaterThanOrEqual(dfs.ESTIMATE_USD.serp);
  });
});
