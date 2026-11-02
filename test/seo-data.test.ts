/**
 * The provider layer (spec 9.2, 9.5): the resolveProvider truth table, and the routed
 * DataForSEO path returning today's fields plus provider/units (fetch stubbed with the
 * recorded sandbox fixtures; nothing leaves the process).
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { resolveProvider, type Capability, type ProviderEnv } from "../src/providers/seo-data.js";
import { cliHint } from "../src/lib/cli-hint.js";

const all = { dataforseo: true, ahrefs: true, semrush: true };
const none = { dataforseo: false, ahrefs: false, semrush: false };
const env = (defaultProvider: ProviderEnv["defaultProvider"], configured: Partial<typeof all>): ProviderEnv => ({ defaultProvider, configured: { ...none, ...configured } });
const c = (dataProvider?: "dataforseo" | "ahrefs" | "semrush") => ({ slug: "example.com", ...(dataProvider ? { dataProvider } : {}) });

describe("resolveProvider (9.5 rules 1-6)", () => {
  it("rule 1: the client's override beats the default", () => {
    expect(resolveProvider(c("semrush"), "keywordVolume", env("ahrefs", all))).toEqual({ provider: "semrush" });
    expect(resolveProvider(c(), "rankedKeywords", env("ahrefs", all))).toEqual({ provider: "ahrefs" });
  });

  it("rule 1: an invalid default with no override is unavailable for routed capabilities, with the change command", () => {
    const r = resolveProvider(c(), "keywordVolume", { ...env({ invalid: "moz" }, all), cli: "npx crawlmark-mcp" });
    expect(r).toEqual({
      unavailable:
        'SEO_DATA_PROVIDER is "moz", which isn\'t a provider crawlmark knows. Use dataforseo, ahrefs or semrush, or leave it blank for dataforseo. ' +
        "Change it with: npx crawlmark-mcp setup --step provider, or in Claude Desktop's extension settings.",
    });
    // A client override still works, and DataForSEO-only capabilities are unaffected.
    expect(resolveProvider(c("ahrefs"), "keywordVolume", env({ invalid: "moz" }, all))).toEqual({ provider: "ahrefs" });
    expect(resolveProvider(c(), "serpLive", env({ invalid: "moz" }, all))).toEqual({ provider: "dataforseo" });
  });

  it("rule 2: a configured provider with the capability serves it", () => {
    for (const cap of ["keywordVolume", "rankedKeywords", "competitorDomains", "backlinksSummary"] as Capability[]) {
      for (const p of ["dataforseo", "ahrefs"] as const) expect(resolveProvider(c(), cap, env(p, all)), `${p} ${cap}`).toEqual({ provider: p });
    }
    // Semrush's v4 API serves keyword volume and backlinks only.
    for (const cap of ["keywordVolume", "backlinksSummary"] as Capability[]) expect(resolveProvider(c(), cap, env("semrush", all)), `semrush ${cap}`).toEqual({ provider: "semrush" });
    for (const cap of ["rankedKeywords", "competitorDomains"] as Capability[]) expect(resolveProvider(c(), cap, env("semrush", all)), `semrush ${cap}`).toEqual({ provider: "dataforseo", fallbackFrom: "semrush" });
  });

  it("rule 3: a provider without the capability falls back to DataForSEO, or says DataForSEO is needed", () => {
    for (const cap of ["serpLive", "onPageInstant", "siteCrawl"] as Capability[]) {
      expect(resolveProvider(c(), cap, env("ahrefs", all))).toEqual({ provider: "dataforseo", fallbackFrom: "ahrefs" });
      expect(resolveProvider(c("semrush"), cap, env("dataforseo", all))).toEqual({ provider: "dataforseo", fallbackFrom: "semrush" });
    }
    expect(resolveProvider(c(), "serpLive", env("ahrefs", { ahrefs: true }))).toEqual({
      unavailable: `Live SERP checks need DataForSEO; ahrefs (the provider for example.com) doesn't offer them. Run ${cliHint()} setup --step dataforseo.`,
    });
    expect(resolveProvider(c(), "onPageInstant", env("semrush", { semrush: true }))).toHaveProperty("unavailable", expect.stringMatching(/^On-page checks need DataForSEO/));
    expect(resolveProvider(c(), "siteCrawl", env("semrush", { semrush: true }))).toHaveProperty("unavailable", expect.stringMatching(/^Site crawls need DataForSEO/));
  });

  it("rule 4: the chosen provider has the capability but no key: unavailable, never a fallback", () => {
    expect(resolveProvider(c(), "rankedKeywords", env("ahrefs", { dataforseo: true }))).toEqual({
      unavailable: `SEO_DATA_PROVIDER is ahrefs but AHREFS_API_KEY is not set. Run ${cliHint()} setup --step ahrefs, or ${cliHint()} setup --step provider to pick another default.`,
    });
    expect(resolveProvider(c("semrush"), "backlinksSummary", env("dataforseo", { dataforseo: true }))).toHaveProperty(
      "unavailable",
      expect.stringContaining("example.com uses dataProvider semrush (clients.yaml) but SEMRUSH_API_KEY is not set"),
    );
  });

  it("rule 5 is not resolution's job: a configured provider is chosen whatever might fail later", () => {
    expect(resolveProvider(c(), "backlinksSummary", env("semrush", { semrush: true }))).toEqual({ provider: "semrush" });
  });

  it("rule 6: DataForSEO chosen and not configured gives today's wording", () => {
    expect(resolveProvider(c(), "keywordVolume", env("dataforseo", { ahrefs: true }))).toEqual({
      unavailable: "DATAFORSEO_LOGIN / DATAFORSEO_PASSWORD are not set. See .env.example.",
    });
    expect(resolveProvider(c(), "serpLive", env("dataforseo", {}))).toHaveProperty("unavailable", expect.stringContaining("DATAFORSEO_LOGIN"));
  });
});

// ------------------------------------------------------------ DataForSEO through the routed layer

const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/dataforseo/${name}.json`, import.meta.url), "utf8"));
const SEARCH_VOLUME = {
  status_code: 20000,
  status_message: "Ok.",
  tasks: [{ id: "t", status_code: 20000, status_message: "Ok.", cost: 0.075, result: [{ keyword: "example widgets", search_volume: 1900, competition: "LOW", cpc: 1.25 }] }],
};
const BY_PATH: Record<string, unknown> = {
  "/keywords_data/google_ads/search_volume/live": SEARCH_VOLUME,
  "/dataforseo_labs/google/ranked_keywords/live": fixture("dataforseo_labs_google_ranked_keywords_live"),
  "/dataforseo_labs/google/competitors_domain/live": fixture("dataforseo_labs_google_competitors_domain_live"),
  "/backlinks/summary/live": fixture("backlinks_summary_live"),
  "/serp/google/organic/live/regular": fixture("serp_google_organic_live_regular"),
};

function stubDfs() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const u = new URL(url);
      expect(u.hostname).toBe("127.0.0.1"); // test/setup.ts points DataForSEO at a closed local port
      const path = u.pathname.replace(/^\/v3/, "");
      calls.push(path);
      const body = BY_PATH[path];
      if (!body) throw new Error(`unexpected ${path}`);
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
  return calls;
}

const client = {
  slug: "example.com",
  domain: "example.com",
  aliases: [],
  monthlyBudgetUsd: 100,
  locationCode: 2840,
  languageCode: "en",
  country: "US",
  monthlyUnits: { ahrefs: 10_000, semrush: 5_000 },
} as unknown as Client;

describe("routed DataForSEO results keep every field and add provider/units", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keyword_volume, ranked_keywords, competitor_domains, backlinks_summary and serp_check", async () => {
    process.env.GLOBAL_MONTHLY_BUDGET_USD = "1000";
    stubDfs();
    const dfs = await import("../src/providers/dataforseo.js");
    const routed = await import("../src/providers/seo-data.js");
    const keys = (o: object) => Object.keys(o).sort();
    const plus = (o: object, ...extra: string[]) => [...Object.keys(o), ...extra].sort();

    const pairs: [object, object][] = [
      [await dfs.searchVolume(client, ["example widgets"]), await routed.searchVolume(client, ["example widgets"])],
      [await dfs.rankedKeywords(client), await routed.rankedKeywords(client)],
      [await dfs.competitorDomains(client), await routed.competitorDomains(client)],
      [await dfs.backlinksSummary(client), await routed.backlinksSummary(client)],
    ];
    for (const [direct, viaLayer] of pairs) {
      expect(keys(viaLayer)).toEqual(plus(direct, "provider", "units"));
      expect(viaLayer).toMatchObject({ provider: "dataforseo", units: null });
    }
    const [direct, viaLayer] = pairs[3] as [{ summary: object }, { summary: { rank: number | null; authority: unknown } }];
    expect(keys(viaLayer.summary)).toEqual(plus(direct.summary, "authority"));
    expect(viaLayer.summary.authority).toEqual({ metric: "dataforseo_rank", value: viaLayer.summary.rank });

    const s1 = await dfs.serp(client, "example widgets");
    const s2 = await routed.serp(client, "example widgets");
    expect(keys(s2)).toEqual(plus(s1, "provider"));
    expect(s2.provider).toBe("dataforseo");
  });
});
