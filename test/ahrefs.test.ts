/**
 * Ahrefs API v3 (Phase 9 task 4). Fixtures follow the documented schemas in
 * docs/research/ahrefs-api-v3.md; fetch is stubbed, test/setup.ts points
 * AHREFS_BASE_URL at a closed local port, and no request leaves the process.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";

const SENTINEL = "ahrefs-SENTINEL-key-3f9c1e";
process.env.AHREFS_API_KEY = SENTINEL;
process.env.SEO_DATA_PROVIDER = "ahrefs";

const shape = await import("../src/providers/ahrefs-shape.js");
const { ahrefsTiming, checkAhrefsKey } = await import("../src/providers/ahrefs.js");
const routed = await import("../src/providers/seo-data.js");
const { db } = await import("../src/lib/store.js");
const { BudgetExceededError } = await import("../src/lib/budget.js");

const fx = (name: string) => readFileSync(new URL(`./fixtures/ahrefs/${name}`, import.meta.url), "utf8");
const FIX: Record<string, string> = {
  "/v3/site-explorer/organic-keywords": fx("organic-keywords.json"),
  "/v3/site-explorer/organic-competitors": fx("organic-competitors.json"),
  "/v3/site-explorer/backlinks-stats": fx("backlinks-stats.json"),
  "/v3/site-explorer/domain-rating": fx("domain-rating.json"),
  "/v3/keywords-explorer/overview": fx("keywords-overview.json"),
  "/v3/subscription-info/limits-and-usage": fx("limits-and-usage.json"),
};

interface Call {
  url: URL;
  auth: string | null;
}

/** A fake Ahrefs: answers with the fixture for the path, and `headers` (units). Fails the test on any host but the local one. */
function fakeAhrefs(opts: { headers?: Record<string, string>; respond?: (c: Call, n: number) => Response | undefined } = {}) {
  const calls: Call[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      const call = { url, auth: new Headers(init?.headers).get("authorization") };
      calls.push(call);
      const custom = opts.respond?.(call, calls.length);
      if (custom) return custom;
      const body = FIX[url.pathname];
      if (!body) return new Response(JSON.stringify({ error: "not found" }), { status: 404 });
      return new Response(body, { status: 200, headers: { "content-type": "application/json", ...opts.headers } });
    }),
  );
  return calls;
}

let n = 0;
/** A fresh client per test, so cache keys and ledger rows don't leak between tests. */
function client(over: Partial<Client> = {}): Client {
  n++;
  return {
    slug: `c${n}.example.com`,
    domain: `c${n}.example.com`,
    aliases: [],
    monthlyBudgetUsd: 5,
    locationCode: 2826,
    languageCode: "en",
    country: "GB",
    monthlyUnits: { ahrefs: 100_000, semrush: 5_000 },
    ...over,
  } as unknown as Client;
}

const ledger = (c: Client) => db.prepare("SELECT provider, endpoint, cost_usd, units FROM spend WHERE client = ? ORDER BY id").all(c.slug) as { provider: string; endpoint: string; cost_usd: number; units: number }[];

afterEach(() => vi.unstubAllGlobals());

// ------------------------------------------------------------------ shape (pure)

describe("Ahrefs shape", () => {
  it("maps keyword volumes: cents to dollars, competition null, missing keywords filled with nulls", () => {
    const out = shape.mapAhrefsKeywordVolumes(JSON.parse(fx("keywords-overview.json")), ["example widgets", "example gadgets", "not returned"]);
    expect(out).toEqual([
      { keyword: "example widgets", search_volume: 1900, competition: null, cpc: 1.25 },
      { keyword: "example gadgets", search_volume: 320, competition: null, cpc: null },
      { keyword: "not returned", search_volume: null, competition: null, cpc: null },
    ]);
  });

  it("maps ranked keywords (rows with no keyword dropped) and competitors (null domains dropped, avgPosition null)", () => {
    const ranked = shape.mapAhrefsRankedKeywords(JSON.parse(fx("organic-keywords.json")), "example.com");
    expect(ranked.totalCount).toBe(3);
    expect(ranked.items[0]).toEqual({ keyword: "example widgets", position: 3, searchVolume: 1900, url: "https://example.com/widgets", estimatedTraffic: 240 });
    const comps = shape.mapAhrefsCompetitors(JSON.parse(fx("organic-competitors.json")), "example.com");
    expect(comps.items.map((c) => c.domain)).toEqual(["example.org", "example.net"]);
    expect(comps.items[0]).toEqual({ domain: "example.org", intersectingKeywords: 412, avgPosition: null, estimatedTraffic: 5300 });
  });

  it("maps backlinks with a domain_rating authority; rank and spam score stay null", () => {
    expect(shape.mapAhrefsBacklinks(JSON.parse(fx("backlinks-stats.json")), JSON.parse(fx("domain-rating.json")), "example.com")).toEqual({
      target: "example.com",
      backlinks: 1840,
      referringDomains: 212,
      rank: null,
      spamScore: null,
      newBacklinks: null,
      lostBacklinks: null,
      authority: { metric: "domain_rating", value: 41.5 },
    });
  });

  it("estimates units with the documented formula", () => {
    expect(shape.estimateAhrefsUnits(["keyword"], 1)).toBe(50);
    expect(shape.ahrefsEstimates.rankedKeywords(100)).toBe(2300); // 23 x 100; volume in order_by counts once
    expect(shape.estimateAhrefsUnits(["keyword", "volume", "volume"], 10)).toBe(110);
    expect(shape.ahrefsEstimates.competitorDomains(100)).toBe(1200);
    expect(shape.ahrefsEstimates.keywordBatch(100)).toBe(1200);
    expect(shape.ahrefsEstimates.backlinksStats()).toBe(50); // 12 per row x 1 row is under the floor
  });

  it("reads units from headers: -actual first, then the total; a cache hit is free", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(shape.unitsFromHeaders(h({ "x-api-units-cost-total-actual": "120", "x-api-units-cost-total": "200" }))).toBe(120);
    expect(shape.unitsFromHeaders(h({ "x-api-units-cost-total": "200" }))).toBe(200);
    expect(shape.unitsFromHeaders(h({ "x-api-cache": "hit", "x-api-units-cost-total": "200" }))).toBe(0);
    expect(shape.unitsFromHeaders(h({}))).toBeNull();
  });

  it("classifies { error } bodies for 400, 401, 403, 429 and 500", () => {
    const text = shape.ahrefsErrorText(fx("error-401.json"));
    expect(text).toBe("Invalid API key");
    expect(shape.classifyAhrefsError(401, text, "/x").message).toBe(
      "Ahrefs rejected the API key (AHREFS_API_KEY): Invalid API key. Create one under Account settings > API keys.",
    );
    expect(shape.classifyAhrefsError(403, "Forbidden", "/x").kind).toBe("auth");
    expect(shape.classifyAhrefsError(429, "", "/x").message).toBe("Ahrefs rate limit hit (60 requests/min by default); try again in a minute.");
    const bad = shape.classifyAhrefsError(400, shape.ahrefsErrorText(fx("error-400.json")), "/site-explorer/organic-keywords");
    expect(bad.message).toMatch(/^Ahrefs rejected the request: Field 'foo' is not allowed in select\. This is likely a crawlmark bug \(endpoint \/site-explorer\/organic-keywords\)/);
    expect(shape.classifyAhrefsError(500, "oops", "/x")).toEqual({ kind: "server", message: "Ahrefs /x returned HTTP 500: oops" });
  });
});

// ------------------------------------------------------------------ client

describe("Ahrefs requests", () => {
  beforeEach(() => {
    // No real waiting: the limiter's spacing is covered in test/rate.test.ts.
    ahrefsTiming.sleep = async () => {};
    ahrefsTiming.spacing = async () => {};
  });

  it("always send date, limit and lowercase country, volume_mode=average on organic-keywords, and the key only as a Bearer header", async () => {
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "77" } });
    const c = client();
    await routed.rankedKeywords(c, c.domain, 25);
    await routed.competitorDomains(c, 10);
    await routed.searchVolume(c, ["example widgets"]);
    const today = new Date().toISOString().slice(0, 10);
    const [ranked, comps, vol] = calls;
    expect(ranked!.url.pathname).toBe("/v3/site-explorer/organic-keywords");
    expect(Object.fromEntries(ranked!.url.searchParams)).toEqual({
      select: "keyword,best_position,best_position_url,volume,sum_traffic",
      target: c.domain,
      country: "gb",
      date: today,
      mode: "subdomains",
      volume_mode: "average",
      order_by: "volume:desc",
      limit: "25",
    });
    expect(comps!.url.searchParams.get("country")).toBe("gb");
    expect(comps!.url.searchParams.get("date")).toBe(today);
    expect(comps!.url.searchParams.get("limit")).toBe("10");
    expect(vol!.url.searchParams.get("country")).toBe("gb");
    for (const call of calls) {
      expect(call.auth).toBe(`Bearer ${SENTINEL}`);
      expect(call.url.href).not.toContain(SENTINEL);
    }
  });

  it("routed results carry provider, units and fromCache, the ledger matches, and a second call is served from cache", async () => {
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "150", "x-api-units-cost-total": "300" } });
    const c = client();
    const first = await routed.rankedKeywords(c, c.domain, 100);
    expect(first).toMatchObject({ provider: "ahrefs", units: 150, costUsd: 0, fromCache: false, totalCount: 3 });
    expect(ledger(c)).toEqual([{ provider: "ahrefs", endpoint: "/site-explorer/organic-keywords", cost_usd: 0, units: 150 }]);

    const again = await routed.rankedKeywords(c, c.domain, 100);
    expect(again).toMatchObject({ provider: "ahrefs", units: 0, fromCache: true, totalCount: 3 });
    expect(calls).toHaveLength(1);
    expect(ledger(c)).toHaveLength(1);
  });

  it("without unit headers, records the documented estimate for the rows returned", async () => {
    fakeAhrefs();
    const c = client();
    const r = await routed.competitorDomains(c, 50);
    // 2 rows with a domain + 1 dropped = 3 rows returned x 12 units = 36, under the 50 floor.
    expect(r.units).toBe(50);
    expect(ledger(c)[0]).toMatchObject({ endpoint: "/site-explorer/organic-competitors", units: 50 });
  });

  it("backlinks: two requests, each with its own ledger row, and a domain_rating authority", async () => {
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "50" } });
    const c = client();
    const r = await routed.backlinksSummary(c);
    expect(calls.map((x) => x.url.pathname)).toEqual(["/v3/site-explorer/backlinks-stats", "/v3/site-explorer/domain-rating"]);
    expect(r).toMatchObject({ provider: "ahrefs", units: 100, summary: { backlinks: 1840, referringDomains: 212, authority: { metric: "domain_rating", value: 41.5 } } });
    expect(ledger(c).map((row) => [row.endpoint, row.units])).toEqual([
      ["/site-explorer/backlinks-stats", 50],
      ["/site-explorer/domain-rating", 50],
    ]);
  });

  it("switching the client's provider doesn't return the other provider's cached data", async () => {
    fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "60" } });
    const c = client();
    expect((await routed.rankedKeywords(c, c.domain, 5)).provider).toBe("ahrefs");
    // Same client and target, now on DataForSEO: a different cache key, so DataForSEO is asked (and fails here at the stub).
    await expect(routed.rankedKeywords({ ...c, dataProvider: "dataforseo" }, c.domain, 5)).rejects.toThrow(/DataForSEO/);
  });

  it("an estimate over monthlyUnits.ahrefs throws BudgetExceededError and makes no request", async () => {
    const calls = fakeAhrefs();
    const c = client({ monthlyUnits: { ahrefs: 2_000, semrush: 5_000 } });
    const err = await routed.rankedKeywords(c, c.domain, 100).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toBe(
      `Ahrefs unit cap hit for ${c.domain}: 0 of 2,000 units this month. Raise monthlyUnits.ahrefs in clients.yaml (or DEFAULT_CLIENT_MONTHLY_AHREFS_UNITS) to continue.`,
    );
    expect(calls).toHaveLength(0);
  });

  it("a batched keyword call checks the whole batch's estimate before the first request, and runs batches in order", async () => {
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "10" } });
    const kws = Array.from({ length: 150 }, (_, i) => `example keyword ${i}`);
    // 1,200 (100 keywords) + 600 (50 keywords) = 1,800 > 1,700.
    await expect(routed.searchVolume(client({ monthlyUnits: { ahrefs: 1_700, semrush: 1 } }), kws)).rejects.toThrow(BudgetExceededError);
    expect(calls).toHaveLength(0);
    const r = await routed.searchVolume(client(), kws);
    expect(calls.map((c) => c.url.searchParams.get("keywords")!.split(",").length)).toEqual([100, 50]);
    expect(r.result).toHaveLength(150);
    expect(r.units).toBe(20);
  });

  it("a timeout records the estimated units and says so", async () => {
    fakeAhrefs({
      respond: () => {
        throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
      },
    });
    const c = client();
    await expect(routed.rankedKeywords(c, c.domain, 10)).rejects.toThrow(/timed out after 30s; Ahrefs may still have billed it/);
    expect(ledger(c)).toEqual([{ provider: "ahrefs", endpoint: "/site-explorer/organic-keywords (timeout, estimated)", cost_usd: 0, units: 230 }]);
  });

  it("retries one 429 after Retry-After; a second 429 surfaces with the rate-limit message", async () => {
    const waits: number[] = [];
    ahrefsTiming.sleep = async (ms) => void waits.push(ms);
    const once = fakeAhrefs({ respond: (_c, k) => (k === 1 ? new Response(JSON.stringify({ error: "Too many" }), { status: 429, headers: { "retry-after": "3" } }) : undefined) });
    const c = client();
    expect((await routed.backlinksSummary(c)).provider).toBe("ahrefs");
    expect(waits).toEqual([3000]);
    expect(once).toHaveLength(3);

    waits.length = 0;
    fakeAhrefs({ respond: () => new Response(JSON.stringify({ error: "Too many" }), { status: 429 }) });
    const c2 = client();
    await expect(routed.backlinksSummary(c2)).rejects.toThrow("Ahrefs rate limit hit (60 requests/min by default); try again in a minute.");
    expect(waits).toEqual([2000]);
    expect(ledger(c2)).toEqual([]);
  });

  it("other errors are never retried and show the vendor text with the key redacted", async () => {
    const calls = fakeAhrefs({ respond: () => new Response(JSON.stringify({ error: `bad key ${SENTINEL}` }), { status: 401 }) });
    const err = (await routed.backlinksSummary(client()).catch((e: unknown) => e)) as Error;
    expect(err.message).toMatch(/^Ahrefs rejected the API key for .+ \(HTTP 401\)\. .*To fix the key: .* setup --step ahrefs\.$/);
    expect(err.message).not.toContain(SENTINEL);
    expect((err.cause as Error).message).toBe("Ahrefs rejected the API key (AHREFS_API_KEY): bad key <redacted>. Create one under Account settings > API keys.");
    expect(calls).toHaveLength(1);
  });

  it("a client with a city-level location code and no country is unavailable with the documented message", async () => {
    const calls = fakeAhrefs();
    const c = client({ country: null, locationCode: 1023191 });
    await expect(routed.rankedKeywords(c)).rejects.toThrow(
      `Set country: XX for ${c.domain} in clients.yaml (or clients set ${c.domain} --country XX); Ahrefs/Semrush need a country, and locationCode 1023191 is not a country.`,
    );
    expect(calls).toHaveLength(0);
  });
});

describe("checkAhrefsKey (free limits-and-usage)", () => {
  it("works: plan and units, no key in the result", async () => {
    const calls = fakeAhrefs();
    const r = await checkAhrefsKey(SENTINEL);
    expect(r).toMatchObject({ works: true, plan: "Standard", unitsUsageApiKey: 1200, unitsLimitApiKey: 50000, resetDate: "2026-11-01", costUsd: 0 });
    expect(calls[0]!.url.pathname).toBe("/v3/subscription-info/limits-and-usage");
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
  });

  it("rejected (401/403, or any other 4xx) vs unreachable (network, 429, 5xx)", async () => {
    fakeAhrefs({ respond: () => new Response(fx("error-401.json"), { status: 401 }) });
    expect(await checkAhrefsKey(SENTINEL)).toMatchObject({ works: false, reachable: true, status: 401 });
    fakeAhrefs({ respond: () => new Response("", { status: 503 }) });
    expect(await checkAhrefsKey(SENTINEL)).toMatchObject({ works: null, reachable: false });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError(`fetch failed ${SENTINEL}`); }));
    const net = await checkAhrefsKey(SENTINEL);
    expect(net).toMatchObject({ works: null, reachable: false });
    expect(JSON.stringify(net)).not.toContain(SENTINEL);
    expect(await checkAhrefsKey(undefined)).toMatchObject({ configured: false, works: false });
  });
});

describe("the Ahrefs key never leaks", () => {
  it("is in no ledger row, cache key or value, or tool-usage row", () => {
    for (const table of ["spend", "cache", "tool_calls"]) {
      const rows = db.prepare(`SELECT * FROM ${table}`).all();
      expect(JSON.stringify(rows), table).not.toContain(SENTINEL);
    }
  });
});

describe("SEC-1 (Ahrefs): a comma inside a keyword is counted as the keywords Ahrefs will bill", () => {
  it("splits on commas before estimating and sending", async () => {
    ahrefsTiming.sleep = async () => {};
    ahrefsTiming.spacing = async () => {};
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "10" } });
    // 10 keywords hidden in one entry: 12 x 10 = 120 > 100.
    const entry = Array.from({ length: 10 }, (_, i) => `example kw${i}`).join(",");
    await expect(routed.searchVolume(client({ monthlyUnits: { ahrefs: 100, semrush: 1 } }), [entry])).rejects.toThrow(BudgetExceededError);
    expect(calls).toHaveLength(0);
    await routed.searchVolume(client(), ["example widgets,example gadgets"]);
    expect(calls[0]!.url.searchParams.get("keywords")).toBe("example widgets,example gadgets");
    expect(calls[0]!.url.searchParams.get("limit")).toBe("2");
  });
});

describe("SEC-4: concurrent calls can't each pass the unit cap", () => {
  it("two calls started together that exceed the cap: the second is refused before any request", async () => {
    ahrefsTiming.sleep = async () => {};
    ahrefsTiming.spacing = async () => {};
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const calls = fakeAhrefs({ headers: { "x-api-units-cost-total-actual": "50" } });
    const fetchFn = globalThis.fetch;
    // Hold the first request open so both calls overlap.
    vi.stubGlobal("fetch", async (...a: Parameters<typeof fetch>) => (await gate, fetchFn(...a)));
    const c = client({ monthlyUnits: { ahrefs: 3_000, semrush: 1 } });
    // Each ranked call estimates 23 x 100 = 2,300; together 4,600 > 3,000.
    const first = routed.rankedKeywords(c, c.domain, 100);
    const second = routed.rankedKeywords(c, "example.org", 100);
    await expect(second).rejects.toThrow(/Ahrefs unit cap hit .*0 of 3,000 units this month \(plus 2,300 reserved by calls in progress\)/);
    release();
    await expect(first).resolves.toMatchObject({ provider: "ahrefs" });
    expect(calls).toHaveLength(1);
    // Once the first call has finished, its reservation is gone (only recorded units count).
    expect((await routed.rankedKeywords(c, "example.net", 10)).provider).toBe("ahrefs");
  });
});

describe("R-3: a 200 whose body isn't JSON", () => {
  it("throws a clear, redacted, control-free error and records the billed units (headers, else the estimate)", async () => {
    ahrefsTiming.sleep = async () => {};
    ahrefsTiming.spacing = async () => {};
    fakeAhrefs({ respond: () => new Response(`<html>\u001b[31moops ${SENTINEL}</html>`, { status: 200, headers: { "x-api-units-cost-total-actual": "77" } }) });
    const c = client();
    const err = (await routed.rankedKeywords(c, c.domain, 10).catch((e: unknown) => e)) as Error;
    expect(err.name).toBe("AhrefsBadBodyError");
    expect(err.message).toMatch(/^Ahrefs \/site-explorer\/organic-keywords answered with an unreadable body: <html>\[31moops <redacted><\/html>$/);
    expect(err.message).not.toContain("\u001b");
    expect(ledger(c)).toEqual([{ provider: "ahrefs", endpoint: "/site-explorer/organic-keywords (unreadable body)", cost_usd: 0, units: 77 }]);

    fakeAhrefs({ respond: () => new Response("not json", { status: 200 }) });
    const c2 = client();
    await expect(routed.rankedKeywords(c2, c2.domain, 10)).rejects.toThrow(/unreadable body: not json/);
    expect(ledger(c2)).toEqual([{ provider: "ahrefs", endpoint: "/site-explorer/organic-keywords (unreadable body, estimated)", cost_usd: 0, units: 230 }]);
  });
});
