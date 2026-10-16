/**
 * Phase 13 B-3: Ahrefs (metrics, keywords-history, metrics-history, refdomains-history, domain-rating-history,
 * organic-competitors) for the provider sections. fetch is stubbed on the closed local port; fixtures follow the documented schemas. Keys are sentinels
 * checked against results, errors, the cache, the ledger and the tool-call log.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const AH = "ahrefs-P13B-SENTINEL-7d1a";
process.env.AHREFS_API_KEY = AH;

const ahrefs = await import("../src/providers/ahrefs.js");
const { db } = await import("../src/lib/store.js");
const { ahrefsTiming } = ahrefs;
ahrefsTiming.spacing = async () => undefined;

const ax = (n: string) => readFileSync(new URL(`./fixtures/ahrefs/p13/${n}`, import.meta.url), "utf8");
const AFIX: Record<string, string> = {
  "/v3/site-explorer/metrics": ax("metrics.json"),
  "/v3/site-explorer/keywords-history": ax("keywords-history.json"),
  "/v3/site-explorer/metrics-history": ax("metrics-history.json"),
  "/v3/site-explorer/refdomains-history": ax("refdomains-history.json"),
  "/v3/site-explorer/domain-rating-history": ax("domain-rating-history.json"),
  "/v3/site-explorer/organic-competitors": ax("organic-competitors-full.json"),
  "/v3/site-explorer/organic-keywords": readFileSync(new URL("./fixtures/ahrefs/organic-keywords.json", import.meta.url), "utf8"),
};
interface Call {
  url: URL;
  method: string;
}
function fake(): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      calls.push({ url, method: init?.method ?? "GET" });
      if (url.pathname.startsWith("/v3/")) {
        const body = AFIX[url.pathname];
        return body ? new Response(body, { status: 200, headers: { "content-type": "application/json" } }) : new Response(JSON.stringify({ error: "nope" }), { status: 404 });
      }
      return new Response("{}", { status: 404 });
    }),
  );
  return calls;
}
afterEach(() => vi.unstubAllGlobals());

let n = 0;
function client(extra: Partial<Client> = {}): Client {
  n++;
  const slug = `p13b-${n}.example.com`;
  return { slug, domain: slug, name: "Example Co", aliases: [], competitors: [], locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 100_000, semrush: 100_000 }, ...extra } as unknown as Client;
}
const ledger = (c: Client) => db.prepare("SELECT provider, endpoint, units FROM spend WHERE client = ? ORDER BY id").all(c.slug) as { provider: string; endpoint: string; units: number }[];
const noKeys = (text: string) => {
  expect(text).not.toContain(AH);
};

describe("Ahrefs (Phase 13 B)", () => {
  it("visibility now: metrics + the latest keywords-history row; params exact; 100 units planned", async () => {
    const calls = fake();
    const c = client();
    const r = await ahrefs.ahrefsOrganicOverview(c, "www.example.com");
    expect(calls.map((x) => [x.method, x.url.pathname])).toEqual([["GET", "/v3/site-explorer/metrics"], ["GET", "/v3/site-explorer/keywords-history"]]);
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ target: "example.com", country: "us", mode: "subdomains" });
    expect(Object.fromEntries(calls[1]!.url.searchParams)).toMatchObject({ select: "date,top3,top4_10,top11_20,top21_50,top51_plus", history_grouping: "monthly", country: "us" });
    expect(r.figures).toEqual({ keywords: 1204, top3: 41, pos4_10: 118, pos11_20: 160, pos21_100: 885, traffic: 3950, trafficLabel: "Ahrefs organic traffic" });
    expect(r).toMatchObject({ market: "us", provider: "ahrefs", units: 100 });
    expect(ahrefs.planAhrefsOrganicOverview(c, "example.com").cost(1)).toBe(100);
    expect(ledger(c).map((l) => l.endpoint)).toEqual(["/site-explorer/metrics", "/site-explorer/keywords-history"]);
    noKeys(JSON.stringify(r));
  });

  it("visibility history and backlink history: monthly grouping, date_from N months back; 221 and 128 units for 13 months", async () => {
    const calls = fake();
    const c = client();
    const v = await ahrefs.ahrefsOrganicHistory(c, "example.com", 13);
    expect(v.points.map((p) => [p.day, p.keywords, p.traffic])).toEqual([["2026-08-01", 1130, 3610], ["2026-09-01", 1204, 3950]]);
    const b = await ahrefs.ahrefsBacklinksHistory(c, "example.com", 13);
    expect(b.points.at(-1)).toEqual({ day: "2026-09-01", backlinks: null, referringDomains: 198, authority: { metric: "domain_rating", value: 41 }, newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null });
    expect(calls.map((x) => x.url.pathname)).toEqual(["/v3/site-explorer/keywords-history", "/v3/site-explorer/metrics-history", "/v3/site-explorer/refdomains-history", "/v3/site-explorer/domain-rating-history"]);
    for (const x of calls) expect(x.url.searchParams.get("history_grouping")).toBe("monthly");
    expect(calls[1]!.url.searchParams.get("select")).toBe("date,org_traffic");
    expect(ahrefs.planAhrefsOrganicHistory(c, "example.com", 13).cost(1)).toBe(221);
    expect(ahrefs.planAhrefsBacklinksHistory(c, "example.com", 13).cost(1)).toBe(128);
  });

  it("competitors: select and order exact, 20 rows; null domain and the zero-width space handled; missing saved via metrics (50 each)", async () => {
    const calls = fake();
    const c = client({ domain: "example.com" } as Partial<Client>);
    const r = await ahrefs.ahrefsCompetitorOverview(c, { saved: ["competitor-a.example", "competitor-b.example"], limit: 5 });
    expect(Object.fromEntries(calls[0]!.url.searchParams)).toMatchObject({ select: "competitor_domain,keywords_common,keywords_competitor,share,domain_rating,traffic", order_by: "keywords_common:desc", limit: "20", country: "us" });
    expect(calls.map((x) => x.url.pathname)).toEqual(["/v3/site-explorer/organic-competitors", "/v3/site-explorer/metrics"]);
    expect(calls[1]!.url.searchParams.get("target")).toBe("competitor-b.example");
    expect(r.rows.map((x) => [x.domain, x.commonKeywords, x.keywords, x.inProviderList])).toEqual([
      ["competitor-a.example", 312, 2410, true],
      ["rival.example.net", 205, 1890, true],
      ["bad.example", 4, 14, true],
      ["competitor-b.example", null, 1204, false],
    ]);
    expect(r.providerListSize).toBe(3);
    expect(ahrefs.planAhrefsCompetitorOverview(c, { saved: ["a.example"], limit: 5 }).cost(1)).toBe(350);
    expect(ahrefs.planAhrefsBacklinksSummary(c, "example.com").cost(1)).toBe(100);
  });

  it("no country: unavailable before any request", async () => {
    const calls = fake();
    const c = client({ country: null } as Partial<Client>);
    expect(() => ahrefs.planAhrefsOrganicOverview(c, "example.com")).toThrow(/country/i);
    expect(calls).toHaveLength(0);
  });
});

describe("R-5: Ahrefs row lists are cached for at most a day; counts keep a week", () => {
  it("ranked keywords and the competitor list expire within 24 hours, visibility figures within 7 days; all tracked for purge", async () => {
    fake();
    const { cacheKey } = await import("../src/lib/cache.js");
    const c = client({ domain: "example.com" } as Partial<Client>);
    await ahrefs.ahrefsRankedKeywords(c, "example.com", 10);
    await ahrefs.ahrefsCompetitorOverview(c, { saved: [], limit: 5 });
    await ahrefs.ahrefsOrganicOverview(c, "example.com");
    const ttl = (key: string) => (db.prepare("SELECT expires_at FROM cache WHERE key = ?").get(key) as { expires_at: number }).expires_at - Math.floor(Date.now() / 1000);
    const ranked = cacheKey("seo", "ahrefs", "rankedKeywords", { target: "example.com", country: "us", limit: 10 });
    const comps = cacheKey("seo", "ahrefs", "competitorOverview", ahrefs.planAhrefsCompetitorOverview(c, { saved: [], limit: 5 }).keyParts);
    const vis = cacheKey("seo", "ahrefs", "organicOverview", ahrefs.planAhrefsOrganicOverview(c, "example.com").keyParts);
    expect(ttl(ranked)).toBeLessThanOrEqual(86_400);
    expect(ttl(comps)).toBeLessThanOrEqual(86_400);
    expect(ttl(vis)).toBeGreaterThan(86_400);
    const tracked = (db.prepare("SELECT key FROM provider_cache_keys WHERE provider = 'ahrefs' AND client = ?").all(c.slug) as { key: string }[]).map((r) => r.key);
    expect(tracked).toEqual(expect.arrayContaining([ranked, comps, vis]));
    expect(ahrefs.AHREFS_ROW_TTL).toBe(86_400);
  });
});
