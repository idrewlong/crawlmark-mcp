/**
 * Phase 12 B-4: keyword ideas and keyword gap with Ahrefs (unit-billed). The API is a
 * stubbed fetch on the closed local port (test/setup.ts) answering with the hand-built fixtures; every
 * request's path and parameters are recorded. Checks request parameters, the documented estimates,
 * units in the ledger, the cap refusal (naming a limit that fits), Ahrefs' Search Console exclusion, and
 * that the keys never reach a result, an error, the cache or the ledger. No real network.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const AHREFS_KEY = "ahrefs-test-key-0123456789";
process.env.AHREFS_API_KEY = AHREFS_KEY;

const { ahrefsTiming } = await import("../src/providers/ahrefs.js");
const { keywordGap, keywordIdeas } = await import("../src/providers/seo-data.js");
const { BudgetExceededError, unitsThisMonth } = await import("../src/lib/budget.js");
type Seo = typeof import("../src/providers/seo-data.js");
type IdeasOut = Extract<Awaited<ReturnType<Seo["keywordIdeas"]>>, { ideas: unknown }>;
type GapOut = Extract<Awaited<ReturnType<Seo["keywordGap"]>>, { gaps: unknown }>;
type Est = Extract<Awaited<ReturnType<Seo["keywordIdeas"]>>, { estimateOnly: true }>;

beforeAll(() => {
  ahrefsTiming.sleep = async () => {};
  ahrefsTiming.spacing = async () => {};
});

const ah = (name: string) => readFileSync(new URL(`./fixtures/ahrefs/${name}`, import.meta.url), "utf8");

interface Req {
  path: string;
  params: Record<string, string>;
}
function fake(o: { ahrefsUnitsHeader?: string } = {}): Req[] {
  const sent: Req[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      const params = Object.fromEntries(url.searchParams);
      sent.push({ path: url.pathname, params });
      const headers: Record<string, string> = o.ahrefsUnitsHeader ? { "x-api-units-cost-total-actual": o.ahrefsUnitsHeader } : {};
      if (url.pathname === "/v3/keywords-explorer/related-terms") return new Response(ah("related-terms.json"), { status: 200, headers });
      if (url.pathname === "/v3/keywords-explorer/matching-terms") return new Response(ah("matching-terms.json"), { status: 200, headers });
      if (url.pathname === "/v3/site-explorer/organic-keywords") {
        return new Response(ah(params.target === "client.example.com" || params.target?.endsWith("-nogsc.example.com") ? "organic-keywords-gap-client.json" : "organic-keywords-gap.json"), { status: 200, headers });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return sent;
}
afterEach(() => vi.unstubAllGlobals());

function makeClient(slug: string, dataProvider: "ahrefs", extra: Partial<Client> = {}): Client {
  return {
    slug, domain: slug, name: "Example Co", aliases: [], sources: [], brandTerms: [], trackedKeywords: [], competitors: ["competitor-a.example", "competitor-b.example"], competitorEntries: [],
    keyPages: [], alternates: { gsc: [], ga4: [] }, locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", dataProvider,
    monthlyUnits: { ahrefs: 10_000, semrush: 5_000 }, ...extra,
  } as Client;
}
const gscCtx = (queries: string[], log: string[] = []) => ({
  gscAvailable: true,
  clientQueries: async () => {
    log.push("gsc");
    return new Set(queries);
  },
});
const noGsc = { gscAvailable: false, clientQueries: async () => new Set<string>() };

describe("Ahrefs keyword ideas", () => {
  it("related: one related-terms request with every seed, the exact select, terms=also_rank_for; units from the row formula", async () => {
    const sent = fake();
    const c = makeClient("ah-ideas.example.com", "ahrefs");
    const r = (await keywordIdeas(c, { seeds: ["example widgets", "widget, repair"], mode: "related", limit: 50 })) as IdeasOut;
    expect(sent).toEqual([
      { path: "/v3/keywords-explorer/related-terms", params: { select: "keyword,volume,difficulty,cpc", country: "us", keywords: "example widgets,widget,repair", order_by: "volume:desc", limit: "50", terms: "also_rank_for" } },
    ]);
    expect(r.ideas).toEqual([
      { keyword: "example widgets near me", volume: 2400, cpc: 1.85, competition: null, difficulty: { metric: "ahrefs_kd", value: 37 }, intent: null, seed: null },
      { keyword: "best example widgets", volume: 1300, cpc: 2.1, competition: null, difficulty: { metric: "ahrefs_kd", value: 52 }, intent: null, seed: null },
      { keyword: "example widget sizes", volume: null, cpc: null, competition: null, difficulty: { metric: "ahrefs_kd", value: null }, intent: null, seed: null },
    ]);
    // No units header: 22 units x 4 rows returned = 88.
    expect(r).toMatchObject({ provider: "ahrefs", units: 88, costUsd: 0, fromCache: false });
    expect(unitsThisMonth(c.slug, "ahrefs")).toBe(88);
  });

  it("matching: matching-terms with match_mode=terms; estimate max(50, 22 x limit) with no request", async () => {
    const sent = fake({ ahrefsUnitsHeader: "50" });
    const c = makeClient("ah-match.example.com", "ahrefs");
    const e = (await keywordIdeas(c, { seeds: ["widget"], mode: "matching", limit: 50 }, { estimateOnly: true })) as Est;
    expect(e.estimate).toMatchObject({ provider: "ahrefs", requests: 1, units: 1100, usd: 0 });
    expect((await keywordIdeas(c, { seeds: ["widget"], mode: "matching", limit: 1 }, { estimateOnly: true }) as Est).estimate.units).toBe(50);
    expect(sent).toEqual([]);
    const r = (await keywordIdeas(c, { seeds: ["widget"], mode: "matching", limit: 50 })) as IdeasOut;
    expect(sent[0]).toMatchObject({ path: "/v3/keywords-explorer/matching-terms", params: { match_mode: "terms", keywords: "widget" } });
    expect(r).toMatchObject({ units: 50, ideas: [{ keyword: "example widget repair", seed: "widget" }] });
  });
});

describe("Ahrefs keyword gap (B-D3)", () => {
  it("with Search Console: reads it first (free), then one organic-keywords per competitor; drops what the client already gets impressions for", async () => {
    const sent = fake({ ahrefsUnitsHeader: "650" });
    const c = makeClient("ah-gap.example.com", "ahrefs");
    const log: string[] = [];
    const e = (await keywordGap(c, { competitors: ["competitor-a.example", "competitor-b.example"], limit: 50, minVolume: 0 }, { estimateOnly: true, ctx: gscCtx(["example widgets"], log) })) as Est;
    expect(e.estimate).toMatchObject({ requests: 2, units: 1300 });
    expect(log).toEqual([]);
    const r = (await keywordGap(c, { competitors: ["competitor-a.example", "competitor-b.example"], limit: 50, minVolume: 1000 }, { ctx: gscCtx(["example widgets"], log) })) as GapOut;
    expect(log).toEqual(["gsc"]);
    expect(sent.map((s) => [s.path, s.params.target, s.params.select, s.params.limit])).toEqual([
      ["/v3/site-explorer/organic-keywords", "competitor-a.example", "keyword,best_position,best_position_url,volume", "50"],
      ["/v3/site-explorer/organic-keywords", "competitor-b.example", "keyword,best_position,best_position_url,volume", "50"],
    ]);
    expect(r.gaps.map((g) => [g.keyword, g.volume, g.clientCheck])).toEqual([["drain cleaning service", 18100, "gsc"], ["sewer line repair", 8100, "gsc"]]);
    expect(r.gaps[0]!.competitors).toEqual([{ domain: "competitor-a.example", position: 3, url: "https://example.org/drains" }, { domain: "competitor-b.example", position: 3, url: "https://example.org/drains" }]);
    expect(r.gaps[0]!.difficulty).toEqual({ metric: "ahrefs_kd", value: null });
    expect(r.notes![0]).toMatch(/^2 competitor keyword\(s\) were dropped because ah-gap\.example\.com already gets Search Console impressions/);
    expect(r).toMatchObject({ provider: "ahrefs", units: 1300 });
  });

  it("without Search Console the client's own 1,000-row call is in the estimate and runs first", async () => {
    const sent = fake({ ahrefsUnitsHeader: "650" });
    const c = makeClient("client-nogsc.example.com", "ahrefs", { monthlyUnits: { ahrefs: 20_000, semrush: 5_000 } });
    const e = (await keywordGap(c, { competitors: ["competitor-a.example"], limit: 50, minVolume: 0 }, { estimateOnly: true, ctx: noGsc })) as Est;
    expect(e.estimate).toMatchObject({ requests: 2, units: 650 + 13_000 });
    const r = (await keywordGap(c, { competitors: ["competitor-a.example"], limit: 50, minVolume: 0 }, { ctx: noGsc })) as GapOut;
    expect(sent.map((s) => [s.params.target, s.params.limit])).toEqual([["client-nogsc.example.com", "1000"], ["competitor-a.example", "50"]]);
    // "example widgets" (position 1 for the client) is dropped; "sewer line repair" (no position) stays.
    expect(r.gaps.map((g) => g.keyword)).toEqual(["drain cleaning service", "sewer line repair", "plumbing inspection"]);
    expect(r.gaps.every((g) => g.clientCheck === "provider")).toBe(true);
  });

  it("refuses before any request when the client call alone doesn't fit the default cap", async () => {
    const sent = fake();
    const err = await keywordGap(makeClient("ah-cap.example.com", "ahrefs"), { competitors: ["competitor-a.example"], limit: 50, minVolume: 0 }, { ctx: noGsc }).catch((x: unknown) => x);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toMatch(/needs 13,650 units of Ahrefs .* but ah-cap\.example\.com has 10,000 units left this month\. Raise monthlyUnits\.ahrefs/);
    expect(sent).toEqual([]);
  });
});
