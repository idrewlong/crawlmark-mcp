/**
 * SEC-1: a direct paid DataForSEO call reserves its estimate while the request is in flight, so parallel calls against
 * a nearly full cap can't each pass the check. Stubbed fetch on the closed local port; spend goes to the temp ledger.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { BudgetExceededError, pendingUsd, withUsdReservation } from "../src/lib/budget.js";
import * as dfs from "../src/providers/dataforseo.js";

const RANKED = readFileSync(new URL("./fixtures/dataforseo/dataforseo_labs_google_ranked_keywords_live.json", import.meta.url), "utf8");
const ONPAGE = JSON.stringify({ status_code: 20000, status_message: "Ok.", cost: 0.045, tasks: [{ id: "t1", status_code: 20100, status_message: "Task Created.", cost: 0.045, result: null }] });

function slowFetch() {
  const fn = vi.fn(async (input: string) => {
    const url = new URL(input);
    if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
    await new Promise((r) => setTimeout(r, 20));
    return new Response(url.pathname.includes("task_post") ? ONPAGE : RANKED, { status: 200 });
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}
afterEach(() => vi.unstubAllGlobals());

let n = 0;
const client = (monthlyBudgetUsd: number): Client => {
  const slug = `res${++n}.example.com`;
  return { slug, domain: slug, name: "Example Co", aliases: [], competitors: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 } } as unknown as Client;
};

describe("direct paid DataForSEO calls reserve their estimate (SEC-1)", () => {
  it("lets at most one of ten parallel rankedKeywords calls through a nearly full cap", async () => {
    const fetchMock = slowFetch();
    const c = client(0.03); // one limit-100 Labs task is $0.024 (0.012 + 100 x 0.00012); two don't fit
    const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => dfs.rankedKeywords(c, `site${i}.example.com`, 100)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(refused).toHaveLength(9);
    expect(refused.every((r) => r.reason instanceof BudgetExceededError)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingUsd([c.slug])).toEqual({ client: 0, global: 0 });
  });

  it("prices a Labs call by its limit, not the flat estimate", async () => {
    const fetchMock = slowFetch();
    const c = client(0.05);
    // limit 1000 is $0.132, over the $0.05 cap, although the flat rankedKeywords estimate ($0.02) would fit.
    await expect(dfs.rankedKeywords(c, "example.com", 1000)).rejects.toBeInstanceOf(BudgetExceededError);
    await expect(dfs.competitorDomains(c, 1000)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reserves an on-page crawl start by its page count, and releases it afterwards", async () => {
    const fetchMock = slowFetch();
    const c = client(0.06); // 100 pages is $0.045; two parallel starts don't fit
    const results = await Promise.allSettled([dfs.onPageStartCrawl(c, 100), dfs.onPageStartCrawl(c, 100)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(pendingUsd([c.slug]).client).toBe(0);
  });

  it("a call inside an enclosing reservation is only checked: the enclosing estimate is counted once", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fetchMock = vi.fn(async () => {
      await gate;
      return new Response(RANKED, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const c = client(0.03); // outer $0.025 + inner $0.024 would be $0.049 if counted twice
    const run = withUsdReservation(c, 0.025, () => dfs.rankedKeywords(c, "nested.example.com", 100));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(pendingUsd([c.slug])).toEqual({ client: 0.025, global: 0.025 });
    release();
    await expect(run).resolves.toBeDefined();
    expect(pendingUsd([c.slug])).toEqual({ client: 0, global: 0 });
  });
});
