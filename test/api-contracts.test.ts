/**
 * API contract checks (offline). Every recorded or documented response fixture for a provider is run through the same
 * parser and mapper production uses, and the result must be non-trivial: a changed mapper that silently returns nothing
 * fails here. A fixture that isn't listed in CONTRACTS (or in COVERED_ELSEWHERE, which names the test that exercises it)
 * fails too, so adding a fixture without a contract is caught. test/endpoint-coverage.test.ts is the other half: it
 * checks that every endpoint a provider calls has a fixture.
 *
 * Google's list/report calls go through the real discovery, gsc and ga4 functions with only the googleapis client stubbed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FIX = join(import.meta.dirname, "fixtures");
const text = (rel: string) => readFileSync(join(FIX, rel), "utf8");
const json = (rel: string) => JSON.parse(text(rel)) as any;

// ---- googleapis stub: serves the fixtures where the real client would call Google
const google$ = vi.hoisted(() => ({ calls: [] as string[], fixtureDir: "" }));
vi.mock("googleapis", async () => {
  const { readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const fx = (rel: string) => ({ data: JSON.parse(readFileSync(join(google$.fixtureDir, rel), "utf8")) });
  return {
    google: {
      options: () => undefined,
      auth: {},
      searchconsole: () => ({
        sites: { list: async () => (google$.calls.push("sites.list"), fx("google/sites-list.json")) },
        searchanalytics: { query: async () => (google$.calls.push("searchanalytics.query"), fx("google/search-analytics-query.json")) },
      }),
      analyticsadmin: () => ({
        accountSummaries: { list: async () => (google$.calls.push("accountSummaries.list"), fx("google/account-summaries.json")) },
        properties: {
          dataStreams: { list: async ({ parent }: { parent: string }) => (google$.calls.push("dataStreams.list"), fx(`google/data-streams/${parent.replace("properties/", "")}.json`)) },
        },
      }),
      analyticsdata: () => ({ properties: { runReport: async () => (google$.calls.push("runReport"), fx("google/ga4-run-report.json")) } }),
    },
  };
});
vi.mock("../src/providers/google.js", () => ({
  googleAuth: () => ({}),
  googleAuthIdentity: () => "contract-test-identity",
  assertGoogleConfigured: () => undefined,
  googleAuthStatus: () => ({ mode: "service_account", auto: false, configured: true, email: "crawlmark@example-project.iam.gserviceaccount.com" }),
}));
google$.fixtureDir = FIX;

const dfs = await import("../src/providers/dataforseo-shape.js");
const ah = await import("../src/providers/ahrefs-shape.js");
const sr = await import("../src/providers/semrush-shape.js");
const bing = await import("../src/analysis/bing.js");
const cruxA = await import("../src/analysis/crux.js");
const clientsLib = await import("../src/lib/clients.js");
const { listGscSites, listGa4Properties } = await import("../src/providers/discovery.js");
const { gscQuery } = await import("../src/providers/gsc.js");
const { ga4Report } = await import("../src/providers/ga4.js");

const client = { slug: "example", domain: "example.com", gscProperty: "sc-domain:example.com", ga4PropertyId: "99999999" } as never;

/** DataForSEO envelope: HTTP-level 20000 and the first task's result[0], the argument every mapper takes. */
function dfsResult(rel: string, expectCode = 20000) {
  const j = json(rel);
  expect(j.status_code, `${rel} envelope status_code`).toBe(20000);
  expect(j.tasks, `${rel} tasks`).toHaveLength(1);
  expect(j.tasks[0].status_code, `${rel} task status_code`).toBe(expectCode);
  return j.tasks[0].result?.[0];
}
const nonEmpty = (a: unknown) => expect(Array.isArray(a) && a.length > 0, "expected a non-empty array").toBe(true);

type Check = () => void | Promise<void>;

/** fixture (relative to test/fixtures) -> a check that parses it with production code and asserts something real came out. */
const CONTRACTS: Record<string, Check> = {
  // ---------------------------------------------------------------- DataForSEO
  "dataforseo/dataforseo_labs_google_ranked_keywords_live.json": () => {
    const o = dfs.mapRankedKeywords(dfsResult("dataforseo/dataforseo_labs_google_ranked_keywords_live.json"));
    nonEmpty(o.items);
    expect(o.items[0]!.keyword).toBeTruthy();
  },
  "dataforseo/dataforseo_labs_google_competitors_domain_live.json": () => nonEmpty(dfs.mapCompetitors(dfsResult("dataforseo/dataforseo_labs_google_competitors_domain_live.json")).items),
  "dataforseo/backlinks_summary_live.json": () => expect(dfs.mapBacklinksSummary(dfsResult("dataforseo/backlinks_summary_live.json"))?.backlinks).toEqual(expect.any(Number)),
  "dataforseo/on_page_instant_pages.json": () => expect(dfs.mapInstantPage(dfsResult("dataforseo/on_page_instant_pages.json"))).not.toBeNull(),
  "dataforseo/serp_google_organic_live_regular.json": () => nonEmpty(dfs.mapSerpOrganic(dfsResult("dataforseo/serp_google_organic_live_regular.json")).items),
  "dataforseo/appendix_user_data.json": () => {
    const s = dfs.mapUserData(dfsResult("dataforseo/appendix_user_data.json"), "https://sandbox.dataforseo.com/v3");
    expect(s).toMatchObject({ mode: "sandbox", apiHost: "sandbox.dataforseo.com" });
    expect(s.balanceUsd).toEqual(expect.any(Number));
  },
  "dataforseo/dataforseo_labs_google_keyword_ideas_live.json": () => nonEmpty(dfs.mapLabsKeywordIdeas(dfsResult("dataforseo/dataforseo_labs_google_keyword_ideas_live.json"), "example widgets")),
  "dataforseo/dataforseo_labs_google_keyword_suggestions_live.json": () => nonEmpty(dfs.mapLabsKeywordIdeas(dfsResult("dataforseo/dataforseo_labs_google_keyword_suggestions_live.json"), "example widgets")),
  "dataforseo/dataforseo_labs_google_domain_intersection_live.json": () => nonEmpty(dfs.mapDomainIntersection(dfsResult("dataforseo/dataforseo_labs_google_domain_intersection_live.json"))),
  "dataforseo/business_data_google_my_business_info_live.json": () => nonEmpty(dfs.mapBusinessInfo(dfsResult("dataforseo/business_data_google_my_business_info_live.json"))),
  "dataforseo/serp_google_maps_live_advanced.json": () => nonEmpty(dfs.mapMapsSerp(dfsResult("dataforseo/serp_google_maps_live_advanced.json"))),
  "dataforseo/business_data_google_reviews_task_post.json": () => {
    // reviewsTaskPost reads task.id from the envelope.
    const j = json("dataforseo/business_data_google_reviews_task_post.json");
    expect(j.tasks[0].status_code).toBe(20100);
    expect(typeof j.tasks[0].id).toBe("string");
  },
  "dataforseo/business_data_google_reviews_task_get.json": () => {
    const r = dfs.mapReviews(dfsResult("dataforseo/business_data_google_reviews_task_get.json"));
    nonEmpty(r.reviews);
  },
  "dataforseo/business_data_google_reviews_task_get_pending.json": () => {
    // reviewsTaskGet treats 40601/40602 as "not ready".
    const j = json("dataforseo/business_data_google_reviews_task_get_pending.json");
    expect([40601, 40602]).toContain(j.tasks[0].status_code);
  },
  "dataforseo/ai_optimization_llm_mentions_search_mentions_live.json": () => nonEmpty(dfs.mapLlmMentions(dfsResult("dataforseo/ai_optimization_llm_mentions_search_mentions_live.json"), "example.com").items),
  "dataforseo/ai_optimization_llm_mentions_target_metrics_live.json": () => expect(dfs.mapLlmTargetMetrics(dfsResult("dataforseo/ai_optimization_llm_mentions_target_metrics_live.json"))).toBeTruthy(),
  "dataforseo/p13/domain_rank_overview_live.json": () => expect(dfs.mapRankOverview(dfsResult("dataforseo/p13/domain_rank_overview_live.json"))).toBeTruthy(),
  "dataforseo/p13/historical_rank_overview_live.json": () => nonEmpty(dfs.mapRankHistory(dfsResult("dataforseo/p13/historical_rank_overview_live.json"))),
  "dataforseo/p13/backlinks_history_live.json": () => nonEmpty(dfs.mapBacklinksHistory(dfsResult("dataforseo/p13/backlinks_history_live.json"))),
  "dataforseo/p13/competitors_domain_live.json": () => nonEmpty(dfs.mapCompetitorsFull(dfsResult("dataforseo/p13/competitors_domain_live.json"), "example.com")),

  // ---------------------------------------------------------------- Ahrefs
  "ahrefs/organic-keywords.json": () => nonEmpty(ah.mapAhrefsRankedKeywords(json("ahrefs/organic-keywords.json"), "example.com").items),
  "ahrefs/organic-competitors.json": () => nonEmpty(ah.mapAhrefsCompetitors(json("ahrefs/organic-competitors.json"), "example.com").items),
  "ahrefs/keywords-overview.json": () => {
    const rows = ah.mapAhrefsKeywordVolumes(json("ahrefs/keywords-overview.json"), json("ahrefs/keywords-overview.json").keywords.map((k: { keyword: string }) => k.keyword));
    nonEmpty(rows);
    expect(rows.some((r) => r.search_volume !== null)).toBe(true);
  },
  "ahrefs/related-terms.json": () => nonEmpty(ah.mapAhrefsIdeas(json("ahrefs/related-terms.json"), "example widgets")),
  "ahrefs/matching-terms.json": () => nonEmpty(ah.mapAhrefsIdeas(json("ahrefs/matching-terms.json"), "example widgets")),
  "ahrefs/organic-keywords-gap.json": () => nonEmpty(ah.mapAhrefsGapRows(json("ahrefs/organic-keywords-gap.json"))),
  "ahrefs/organic-keywords-gap-client.json": () => nonEmpty(ah.mapAhrefsGapRows(json("ahrefs/organic-keywords-gap-client.json"))),
  "ahrefs/backlinks-stats.json": () => {
    const b = ah.mapAhrefsBacklinks(json("ahrefs/backlinks-stats.json"), json("ahrefs/domain-rating.json"), "example.com");
    expect(b.backlinks).toEqual(expect.any(Number));
    expect(b.authority.value).toEqual(expect.any(Number));
  },
  "ahrefs/domain-rating.json": () => expect(ah.mapAhrefsBacklinks(json("ahrefs/backlinks-stats.json"), json("ahrefs/domain-rating.json"), "example.com").authority.value).toEqual(expect.any(Number)),
  "ahrefs/limits-and-usage.json": () => {
    const a = ah.mapAhrefsAccount(json("ahrefs/limits-and-usage.json"));
    expect(a.plan).toBeTruthy();
    expect(a.unitsLimitWorkspace).toEqual(expect.any(Number));
    expect(ah.describeAhrefsAccount(a)).toContain(a.plan!);
  },
  "ahrefs/error-401.json": () => expect(ah.ahrefsErrorText(text("ahrefs/error-401.json"))).not.toBe(""),
  "ahrefs/error-400.json": () => expect(ah.ahrefsErrorText(text("ahrefs/error-400.json"))).not.toBe(""),
  "ahrefs/p13/metrics.json": () => expect(ah.mapAhrefsVisibility(json("ahrefs/p13/metrics.json"), json("ahrefs/p13/keywords-history.json"))).toBeTruthy(),
  "ahrefs/p13/keywords-history.json": () => expect(ah.mapAhrefsVisibilityHistory(json("ahrefs/p13/keywords-history.json"), json("ahrefs/p13/metrics-history.json"))).toBeTruthy(),
  "ahrefs/p13/metrics-history.json": () => nonEmpty(ah.mapAhrefsVisibilityHistory(json("ahrefs/p13/keywords-history.json"), json("ahrefs/p13/metrics-history.json"))),
  "ahrefs/p13/refdomains-history.json": () => nonEmpty(ah.mapAhrefsBacklinksHistory(json("ahrefs/p13/refdomains-history.json"), json("ahrefs/p13/domain-rating-history.json"))),
  "ahrefs/p13/domain-rating-history.json": () => nonEmpty(ah.mapAhrefsBacklinksHistory(json("ahrefs/p13/refdomains-history.json"), json("ahrefs/p13/domain-rating-history.json"))),
  "ahrefs/p13/organic-competitors-full.json": () => nonEmpty(ah.mapAhrefsCompetitorsFull(json("ahrefs/p13/organic-competitors-full.json"), "example.com")),

  // ---------------------------------------------------------------- Semrush
  "semrush/v4-keyword-metrics.json": () => expect(sr.mapSemrushKeywordMetricsV4(json("semrush/v4-keyword-metrics.json"), "seo tools")).toMatchObject({ keyword: "seo tools", search_volume: 60500, competition: "HIGH", cpc: 1245 }),
  "semrush/v4-backlinks-overview.json": () => expect(sr.mapSemrushBacklinksV4(json("semrush/v4-backlinks-overview.json"), "example.com").backlinks).toEqual(expect.any(Number)),
  "semrush/v4-error-403.json": () => expect(sr.parseSemrushV4Error(json("semrush/v4-error-403.json"))).toMatchObject({ code: expect.any(Number) }),

  // ---------------------------------------------------------------- Bing (every method answers { d: ... })
  "bing/user-sites.json": () => {
    const sites = bing.parseUserSites(json("bing/user-sites.json").d);
    nonEmpty(sites);
    expect(sites.some((s) => s.verified)).toBe(true);
  },
  "bing/traffic.json": () => nonEmpty(bing.parseTraffic(json("bing/traffic.json").d)),
  "bing/query-stats.json": () => nonEmpty(bing.parseStatRows(json("bing/query-stats.json").d, 200)),
  "bing/page-stats.json": () => nonEmpty(bing.parseStatRows(json("bing/page-stats.json").d, 2000)),
  "bing/crawl-stats.json": () => nonEmpty(bing.parseCrawlStats(json("bing/crawl-stats.json").d)),
  "bing/crawl-issues.json": () => nonEmpty(bing.parseCrawlIssues(json("bing/crawl-issues.json").d)),

  // ---------------------------------------------------------------- CrUX
  "crux/history-origin.json": () => {
    const r = cruxA.parseCruxHistory(json("crux/history-origin.json"), { origin: "https://example.com", formFactor: "PHONE", metrics: cruxA.ALL_CRUX_METRICS }, "CRUX_API_KEY");
    expect(r.periods.length).toBeGreaterThan(0);
    expect(Object.keys(r.metrics).sort()).toEqual([...cruxA.ALL_CRUX_METRICS].sort());
    expect(r.metrics.lcp?.p75).toHaveLength(r.periods.length);
    expect(r.metrics.lcp?.latest).toEqual(expect.any(Number));
  },

  // ---------------------------------------------------------------- Google (through the real functions, googleapis stubbed)
  "google/sites-list.json": async () => {
    const sites = (await listGscSites({ refresh: true })).value;
    nonEmpty(sites);
    expect(sites.map((s) => s.siteUrl)).toContain("sc-domain:example.com");
  },
  "google/account-summaries.json": async () => nonEmpty((await listGa4Properties({ refresh: true })).value.properties),
  "google/data-streams/200000001.json": async () => {
    const p = (await listGa4Properties({ refresh: true })).value.properties;
    expect(p.some((x) => x.webStreamUris.length > 0)).toBe(true);
  },
  "google/data-streams/99999999.json": async () => expect((await listGa4Properties({ refresh: true })).value.errors).toEqual([]),
  "google/data-streams/400000001.json": async () => expect((await listGa4Properties({ refresh: true })).value.errors).toEqual([]),
  "google/data-streams/300000002.json": async () => expect((await listGa4Properties({ refresh: true })).value.errors).toEqual([]),
  "google/search-analytics-query.json": async () => {
    const rows = await gscQuery(client, { startDate: "2026-09-01", endDate: "2026-09-30", dimensions: ["query", "page"] });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ keys: ["example widgets", "https://example.com/widgets"], clicks: 42, impressions: 1234, ctr: 3.4, position: 3.5 });
  },
  "google/ga4-run-report.json": async () => {
    const rows = await ga4Report(client, { startDate: "2026-09-01", endDate: "2026-09-30", metrics: ["sessions", "engagementRate"], dimensions: ["landingPage"] });
    expect(rows).toEqual([
      { landingPage: "/widgets", sessions: 310, engagementRate: 0.62 },
      { landingPage: "/repair", sessions: 45, engagementRate: 0.4 },
    ]);
  },
};

/** Fixtures whose parser needs more than a one-liner (a stubbed transport, a database): the test that exercises them, which must still name them. */
const COVERED_ELSEWHERE: Record<string, string> = {
  "ahrefs/p13/site-audit-projects.json": "p13b-site-audit.test.ts",
  "ahrefs/p13/site-audit-issues.json": "p13b-site-audit.test.ts",
  "ahrefs/p13/site-audit-page-explorer.json": "p13b-site-audit.test.ts",
  "google/p13/url-inspection-indexed.json": "p13-indexing.test.ts",
  "google/p13/url-inspection-not-indexed.json": "p13-indexing.test.ts",
  "google/p13/sitemaps-list.json": "p13-indexing.test.ts",
  "google/gtm-accounts.json": "discovery.test.ts",
  "google/gtm-containers.json": "gtm.test.ts",
  "google/gtm-containers-by-name.json": "discovery.test.ts",
  "gtm/container-version.json": "gtm-provider.test.ts",
};

const PROVIDER_DIRS = ["dataforseo", "ahrefs", "semrush", "bing", "crux", "google", "gtm"];
function listFixtures(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return listFixtures(p);
    return n === "README.md" ? [] : [relative(FIX, p).split(sep).join("/")];
  });
}
const ALL = PROVIDER_DIRS.flatMap((d) => listFixtures(join(FIX, d))).sort();

beforeEach(() => {
  google$.calls.length = 0;
});

describe("provider fixtures parse with the production mappers", () => {
  for (const [rel, check] of Object.entries(CONTRACTS)) {
    it(rel, async () => {
      expect(existsSync(join(FIX, rel)), `${rel} is listed but missing`).toBe(true);
      await check();
    });
  }
});

describe("fixture coverage", () => {
  it("every provider fixture has a contract check or a named test that exercises it", () => {
    const missing = ALL.filter((f) => !(f in CONTRACTS) && !(f in COVERED_ELSEWHERE));
    expect(missing, "add a CONTRACTS entry (or COVERED_ELSEWHERE) for each new fixture").toEqual([]);
  });

  it("no entry is stale, and each COVERED_ELSEWHERE test really names its fixture", () => {
    expect(Object.keys(CONTRACTS).filter((f) => !ALL.includes(f))).toEqual([]);
    for (const [rel, testFile] of Object.entries(COVERED_ELSEWHERE)) {
      expect(ALL, `${rel} no longer exists`).toContain(rel);
      const src = readFileSync(join(import.meta.dirname, testFile), "utf8");
      const base = rel.split("/").pop()!;
      expect(src.includes(base) || src.includes(rel), `${testFile} doesn't mention ${base}`).toBe(true);
    }
  });

  it("the Google contracts reached the stubbed API (the stub is what they exercise, not a fixture read)", async () => {
    await gscQuery(client, { startDate: "2026-09-02", endDate: "2026-09-30", dimensions: ["query"] });
    expect(google$.calls).toContain("searchanalytics.query");
    expect(clientsLib.gscSitesFromResponse(json("google/sites-list.json")).length).toBeGreaterThan(0);
  });
});
