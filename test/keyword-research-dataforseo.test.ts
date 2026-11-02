/**
 * Phase 12 B-3: keyword ideas and keyword gap through the routed provider layer with DataForSEO Labs.
 * DataForSEO is a stubbed fetch on the closed local port (test/setup.ts) answering with the hand-built
 * fixtures; every request body is recorded. No real network; spend goes to the temp ledger.
 */
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Client } from "../src/config.js";
import { BudgetExceededError, spentThisMonth } from "../src/lib/budget.js";
import { ProviderUnavailableError } from "../src/lib/provider-ids.js";
import { gapCompetitors, keywordGap, keywordIdeas, resolveProvider, ROUTED_CAPABILITIES, type EstimateResult, type GapContext, type KeywordGapRouted, type KeywordIdeasRouted } from "../src/providers/seo-data.js";

const fx = (name: string) => readFileSync(new URL(`./fixtures/dataforseo/${name}`, import.meta.url), "utf8");
const FIX: Record<string, string> = {
  "/v3/dataforseo_labs/google/keyword_ideas/live": fx("dataforseo_labs_google_keyword_ideas_live.json"),
  "/v3/dataforseo_labs/google/keyword_suggestions/live": fx("dataforseo_labs_google_keyword_suggestions_live.json"),
  "/v3/dataforseo_labs/google/domain_intersection/live": fx("dataforseo_labs_google_domain_intersection_live.json"),
};

interface Sent {
  path: string;
  body: unknown;
}
function fakeDfs(): Sent[] {
  const sent: Sent[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init: RequestInit) => {
      const url = new URL(input);
      if (url.hostname !== "127.0.0.1") throw new Error(`test tried to reach a real host: ${url.hostname}`);
      sent.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
      const body = FIX[url.pathname];
      return body ? new Response(body, { status: 200 }) : new Response("{}", { status: 404 });
    }),
  );
  return sent;
}
afterEach(() => vi.unstubAllGlobals());

function makeClient(slug: string, extra: Partial<Client> = {}): Client {
  return {
    slug, domain: slug, name: "Example Co", aliases: [], sources: [], brandTerms: [], trackedKeywords: [], competitors: ["competitor-a.example", "www.competitor-b.example"], competitorEntries: [],
    keyPages: [], alternates: { gsc: [], ga4: [] }, locationCode: 2840, languageCode: "en", monthlyBudgetUsd: 5, country: "US", monthlyUnits: { ahrefs: 10_000, semrush: 5_000 }, ...extra,
  } as Client;
}
const noGsc: GapContext = { gscAvailable: false, clientQueries: async () => { throw new Error("not used"); } };

describe("routing", () => {
  it("keyword ideas and gap are routed capabilities that DataForSEO and Ahrefs serve; Semrush's v4 API doesn't, so DataForSEO does", () => {
    expect(ROUTED_CAPABILITIES).toEqual(expect.arrayContaining(["keywordIdeas", "keywordGap"]));
    const env = { defaultProvider: "dataforseo" as const, configured: { dataforseo: true, ahrefs: true, semrush: true } };
    for (const p of ["dataforseo", "ahrefs"] as const) {
      expect(resolveProvider({ slug: "x", dataProvider: p }, "keywordIdeas", env)).toEqual({ provider: p });
      expect(resolveProvider({ slug: "x", dataProvider: p }, "keywordGap", env)).toEqual({ provider: p });
    }
    for (const cap of ["keywordIdeas", "keywordGap"] as const) expect(resolveProvider({ slug: "x", dataProvider: "semrush" }, cap, env)).toEqual({ provider: "dataforseo", fallbackFrom: "semrush" });
  });

  it("never falls back to DataForSEO when the client's provider has no key (error names the step)", async () => {
    const sent = fakeDfs();
    const c = makeClient("ahrefs-nokey.example.com", { dataProvider: "ahrefs" });
    await expect(keywordIdeas(c, { seeds: ["plumber"], mode: "related", limit: 10 })).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(keywordGap(c, { competitors: ["competitor-a.example"], limit: 10, minVolume: 0 }, { ctx: noGsc })).rejects.toThrow(/AHREFS_API_KEY is not set\. Run .+ setup --step ahrefs/);
    expect(sent).toEqual([]);
  });
});

describe("keyword_ideas (DataForSEO Labs)", () => {
  it("related: one keyword_ideas task with every seed; mapped, de-duplicated, difficulty labelled, cost recorded", async () => {
    const sent = fakeDfs();
    const c = makeClient("ideas-related.example.com");
    const r = (await keywordIdeas(c, { seeds: ["emergency plumber", "water heater repair"], mode: "related", limit: 50 })) as KeywordIdeasRouted;
    expect(sent).toEqual([{ path: "/v3/dataforseo_labs/google/keyword_ideas/live", body: [{ keywords: ["emergency plumber", "water heater repair"], location_code: 2840, language_code: "en", limit: 50 }] }]);
    expect(r).toMatchObject({ provider: "dataforseo", units: null, costUsd: 0.0156, fromCache: false });
    expect(r.ideas).toHaveLength(3);
    expect(r.ideas[0]).toEqual({ keyword: "emergency plumber near me", volume: 74000, cpc: 12.31, competition: 0.42, difficulty: { metric: "dataforseo_kd", value: 38 }, intent: "transactional", seed: null });
    expect(spentThisMonth(c.slug)).toBeCloseTo(0.0156, 6);
    // Cached: the same request again makes no call and costs nothing.
    const again = (await keywordIdeas(c, { seeds: ["emergency plumber", "water heater repair"], mode: "related", limit: 50 })) as KeywordIdeasRouted;
    expect(again).toMatchObject({ fromCache: true, costUsd: 0 });
    expect(sent).toHaveLength(1);
  });

  it("matching: one keyword_suggestions task per seed with ceil(limit / seeds)", async () => {
    const sent = fakeDfs();
    const r = (await keywordIdeas(makeClient("ideas-matching.example.com"), { seeds: ["water heater", "drain"], mode: "matching", limit: 25 })) as KeywordIdeasRouted;
    expect(sent.map((s) => s.body)).toEqual([
      [{ keyword: "water heater", location_code: 2840, language_code: "en", limit: 13 }],
      [{ keyword: "drain", location_code: 2840, language_code: "en", limit: 13 }],
    ]);
    expect(r.ideas.map((i) => [i.keyword, i.seed])).toEqual([["water heater repair", "water heater"], ["tankless water heater", "water heater"]]);
    expect(r.ideas[1]!.difficulty).toEqual({ metric: "dataforseo_kd", value: null });
  });

  it("estimateOnly follows the documented formula and makes no request", async () => {
    const sent = fakeDfs();
    const c = makeClient("ideas-estimate.example.com");
    const related = (await keywordIdeas(c, { seeds: ["a", "b"], mode: "related", limit: 50 }, { estimateOnly: true })) as EstimateResult;
    expect(related).toMatchObject({ estimateOnly: true, provider: "dataforseo", wouldExceed: false, estimate: { requests: 1, usd: 0.018, units: null, cached: false }, remaining: { unit: "usd", client: 5 } });
    const matching = (await keywordIdeas(c, { seeds: ["a", "b", "c"], mode: "matching", limit: 50 }, { estimateOnly: true })) as EstimateResult;
    // 3 tasks x ($0.012 + 17 x $0.00012)
    expect(matching.estimate).toMatchObject({ requests: 3, usd: 0.04212 });
    expect(sent).toEqual([]);
  });

  it("refuses before any request when the whole call doesn't fit, naming a limit that does", async () => {
    const sent = fakeDfs();
    const c = makeClient("ideas-cap.example.com", { monthlyBudgetUsd: 0.016 });
    const err = await keywordIdeas(c, { seeds: ["a"], mode: "related", limit: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BudgetExceededError);
    expect((err as Error).message).toMatch(/^That needs \$0\.0360 of DataForSEO .* but ideas-cap\.example\.com has \$0\.0160 left this month\. Use limit 25 \(\$0\.0150\), or raise monthlyBudgetUsd/);
    expect(sent).toEqual([]);
  });
});

describe("keyword_gap (DataForSEO Labs)", () => {
  it("one domain_intersection per competitor with intersections: false, bare domains, merged and sorted by volume", async () => {
    const sent = fakeDfs();
    const c = makeClient("gap.example.com");
    const competitors = gapCompetitors(c, undefined);
    expect(competitors).toEqual(["competitor-a.example", "competitor-b.example"]);
    const r = (await keywordGap(c, { competitors, limit: 50, minVolume: 1000 }, { ctx: noGsc })) as KeywordGapRouted;
    expect(sent.map((s) => s.body)).toEqual(
      competitors.map((target1) => [{ target1, target2: "gap.example.com", intersections: false, item_types: ["organic"], location_code: 2840, language_code: "en", limit: 50 }]),
    );
    expect(r.perCompetitor).toEqual([{ domain: "competitor-a.example", returned: 3 }, { domain: "competitor-b.example", returned: 3 }]);
    // The same fixture for both: each keyword once, both competitors listed; 880 is under minVolume.
    expect(r.gaps.map((g) => [g.keyword, g.volume, g.competitors.length])).toEqual([["drain cleaning service", 18100, 2], ["sewer line repair", 8100, 2]]);
    expect(r.gaps[0]).toMatchObject({ difficulty: { metric: "dataforseo_kd", value: 27 }, clientPosition: null, clientCheck: "provider", competitors: [{ domain: "competitor-a.example", position: 3, url: "https://competitor-a.example/drains" }, expect.anything()] });
    expect(r).toMatchObject({ provider: "dataforseo", units: null, costUsd: 0.0248 });
  });

  it("estimates per competitor and makes no request with estimateOnly", async () => {
    const sent = fakeDfs();
    const e = (await keywordGap(makeClient("gap-estimate.example.com"), { competitors: ["a.example", "b.example", "c.example"], limit: 100, minVolume: 0 }, { estimateOnly: true, ctx: noGsc })) as EstimateResult;
    expect(e.estimate).toMatchObject({ requests: 3, usd: 0.072 });
    expect(sent).toEqual([]);
  });

  it("competitors: passed ones are normalised; the client itself, non-domains and none saved are errors", () => {
    const c = makeClient("own.example.com");
    expect(gapCompetitors(c, ["https://www.Competitor-C.example/page", "competitor-c.example"])).toEqual(["competitor-c.example"]);
    expect(() => gapCompetitors(c, ["blog.own.example.com"])).toThrow(/is own\.example\.com itself/);
    expect(() => gapCompetitors(c, ["not a domain"])).toThrow(/isn't a domain/);
    expect(() => gapCompetitors(makeClient("lonely.example.com", { competitors: [] }), undefined)).toThrow(/suggest_competitors/);
    expect(gapCompetitors(makeClient("many.example.com", { competitors: ["a.example", "b.example", "c.example", "d.example"] }), undefined)).toEqual(["a.example", "b.example", "c.example"]);
  });
});
