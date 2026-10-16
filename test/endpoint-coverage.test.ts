/**
 * Coverage map: every endpoint a provider module calls must have a response fixture (or a named, reasoned gap).
 * Endpoints are read out of the provider source, so a new call added without a fixture fails here and the author has to
 * either record one (and add it to CONTRACTS in api-contracts.test.ts) or write down why there isn't one.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AHREFS_PATHS } from "../src/providers/ahrefs-shape.js";
import { BING_READ_METHODS } from "../src/providers/bing.js";

const SRC = join(import.meta.dirname, "..", "src", "providers");
const FIX = join(import.meta.dirname, "fixtures");
const src = (f: string) => readFileSync(join(SRC, f), "utf8");
const all = (re: RegExp, text: string) => [...text.matchAll(re)].map((m) => m[1]!);

/** Endpoint ids read from the provider source, per vendor. */
function discover(): Record<string, string[]> {
  const uniq = (xs: string[]) => [...new Set(xs)].sort();
  const dfsSrc = src("dataforseo.ts");
  const semrushSrc = src("semrush.ts");
  const googleSrc = ["gsc.ts", "ga4.ts", "discovery.ts", "gtm.ts"].map(src).join("\n");
  return {
    dataforseo: uniq(all(/"(\/(?:serp|dataforseo_labs|keywords_data|backlinks|on_page|business_data|ai_optimization|appendix)\/[a-z_/]+)"/g, dfsSrc)),
    ahrefs: uniq([...Object.values(AHREFS_PATHS), ...all(/"(\/site-audit\/[a-z-]+)"/g, src("ahrefs-site-audit.ts"))]),
    semrush: uniq(all(/path: "(\/apis\/v4\/[a-z0-9/]+)"/g, semrushSrc)),
    bing: uniq([...BING_READ_METHODS]),
    crux: uniq(all(/(records:queryHistoryRecord)/g, src("crux.ts"))),
    google: uniq(all(/\b(?:sc|admin|data|tm)\.((?:[a-zA-Z]+\.)+[a-zA-Z]+)\(/g, googleSrc)),
  };
}

/** endpoint -> fixture paths under test/fixtures (all must exist), or a reason there is none yet. */
type Entry = string[] | { gap: string };
const FILES: Record<string, Record<string, Entry>> = {
  dataforseo: {
    "/serp/google/organic/live/regular": ["dataforseo/serp_google_organic_live_regular.json"],
    "/dataforseo_labs/google/ranked_keywords/live": ["dataforseo/dataforseo_labs_google_ranked_keywords_live.json"],
    "/dataforseo_labs/google/competitors_domain/live": ["dataforseo/dataforseo_labs_google_competitors_domain_live.json", "dataforseo/p13/competitors_domain_live.json"],
    "/dataforseo_labs/google/keyword_ideas/live": ["dataforseo/dataforseo_labs_google_keyword_ideas_live.json"],
    "/dataforseo_labs/google/keyword_suggestions/live": ["dataforseo/dataforseo_labs_google_keyword_suggestions_live.json"],
    "/dataforseo_labs/google/domain_intersection/live": ["dataforseo/dataforseo_labs_google_domain_intersection_live.json"],
    "/dataforseo_labs/google/domain_rank_overview/live": ["dataforseo/p13/domain_rank_overview_live.json"],
    "/dataforseo_labs/google/historical_rank_overview/live": ["dataforseo/p13/historical_rank_overview_live.json"],
    "/backlinks/summary/live": ["dataforseo/backlinks_summary_live.json"],
    "/backlinks/history/live": ["dataforseo/p13/backlinks_history_live.json"],
    "/on_page/instant_pages": ["dataforseo/on_page_instant_pages.json"],
    "/business_data/google/my_business_info/live": ["dataforseo/business_data_google_my_business_info_live.json"],
    "/serp/google/maps/live/advanced": ["dataforseo/serp_google_maps_live_advanced.json"],
    "/business_data/google/reviews/task_post": ["dataforseo/business_data_google_reviews_task_post.json"],
    "/business_data/google/reviews/task_get": ["dataforseo/business_data_google_reviews_task_get.json", "dataforseo/business_data_google_reviews_task_get_pending.json"],
    "/ai_optimization/llm_mentions/search_mentions/live": ["dataforseo/ai_optimization_llm_mentions_search_mentions_live.json"],
    "/ai_optimization/llm_mentions/target_metrics/live": ["dataforseo/ai_optimization_llm_mentions_target_metrics_live.json"],
    "/appendix/user_data": ["dataforseo/appendix_user_data.json"],
    "/keywords_data/google_ads/search_volume/live": { gap: "keyword volume goes through the shared envelope reader but has no recorded response; record one from the sandbox with scripts/record-fixtures.ts" },
    "/on_page/task_post": { gap: "site-crawl task start; only the task id is read, no recorded response" },
    "/on_page/pages": { gap: "site-crawl page listing; no recorded response" },
  },
  ahrefs: {
    "/subscription-info/limits-and-usage": ["ahrefs/limits-and-usage.json"],
    "/site-explorer/organic-keywords": ["ahrefs/organic-keywords.json", "ahrefs/organic-keywords-gap.json", "ahrefs/organic-keywords-gap-client.json"],
    "/site-explorer/organic-competitors": ["ahrefs/organic-competitors.json", "ahrefs/p13/organic-competitors-full.json"],
    "/site-explorer/backlinks-stats": ["ahrefs/backlinks-stats.json"],
    "/site-explorer/domain-rating": ["ahrefs/domain-rating.json"],
    "/keywords-explorer/overview": ["ahrefs/keywords-overview.json"],
    "/keywords-explorer/related-terms": ["ahrefs/related-terms.json"],
    "/keywords-explorer/matching-terms": ["ahrefs/matching-terms.json"],
    "/site-explorer/metrics": ["ahrefs/p13/metrics.json"],
    "/site-explorer/metrics-history": ["ahrefs/p13/metrics-history.json"],
    "/site-explorer/keywords-history": ["ahrefs/p13/keywords-history.json"],
    "/site-explorer/refdomains-history": ["ahrefs/p13/refdomains-history.json"],
    "/site-explorer/domain-rating-history": ["ahrefs/p13/domain-rating-history.json"],
    "/site-audit/projects": ["ahrefs/p13/site-audit-projects.json"],
    "/site-audit/issues": ["ahrefs/p13/site-audit-issues.json"],
    "/site-audit/page-explorer": ["ahrefs/p13/site-audit-page-explorer.json"],
  },
  semrush: {
    "/apis/v4/backlinks/v1/overview": ["semrush/v4-backlinks-overview.json"],
    "/apis/v4/keywords/v1/metrics": ["semrush/v4-keyword-metrics.json"],
  },
  bing: {
    GetUserSites: ["bing/user-sites.json"],
    GetRankAndTrafficStats: ["bing/traffic.json"],
    GetQueryStats: ["bing/query-stats.json"],
    GetPageStats: ["bing/page-stats.json"],
    GetCrawlStats: ["bing/crawl-stats.json"],
    GetCrawlIssues: ["bing/crawl-issues.json"],
    GetUrlInfo: { gap: "per-URL lookup; not used by any report template and no documented sample recorded" },
  },
  crux: {
    "records:queryHistoryRecord": ["crux/history-origin.json"],
  },
  google: {
    "sites.list": ["google/sites-list.json"],
    "accountSummaries.list": ["google/account-summaries.json"],
    "properties.dataStreams.list": ["google/data-streams/200000001.json"],
    "searchanalytics.query": ["google/search-analytics-query.json"],
    "properties.runReport": ["google/ga4-run-report.json"],
    "urlInspection.index.inspect": ["google/p13/url-inspection-indexed.json", "google/p13/url-inspection-not-indexed.json"],
    "sitemaps.list": ["google/p13/sitemaps-list.json"],
    "accounts.list": ["google/gtm-accounts.json"],
    "accounts.containers.list": ["google/gtm-containers.json"],
    "accounts.containers.versions.live": ["gtm/container-version.json"],
    "accounts.containers.get": { gap: "single container lookup used to name a container; no recorded response" },
    "accounts.containers.workspaces.list": { gap: "GTM workspace listing used by gtm_audit's unpublished-changes rule; no recorded response" },
    "accounts.containers.workspaces.getStatus": { gap: "GTM workspace status used by gtm_audit's unpublished-changes rule; no recorded response" },
  },
};

const found = discover();

describe("endpoint to fixture coverage map", () => {
  for (const vendor of Object.keys(FILES)) {
    describe(vendor, () => {
      it("finds the endpoints in the provider source (the scan itself works)", () => {
        expect(found[vendor]!.length, `scan found no ${vendor} endpoints`).toBeGreaterThan(0);
      });

      it("every endpoint the provider calls has a fixture or a written-down gap", () => {
        const unmapped = found[vendor]!.filter((e) => !(e in FILES[vendor]!));
        expect(unmapped, `${vendor} calls endpoint(s) with no fixture. Record one (see test/fixtures/${vendor}/README.md), add it to CONTRACTS in api-contracts.test.ts, then list it here.`).toEqual([]);
      });

      it("no entry names an endpoint the provider no longer calls", () => {
        expect(Object.keys(FILES[vendor]!).filter((e) => !found[vendor]!.includes(e))).toEqual([]);
      });

      it("every fixture named exists", () => {
        for (const [endpoint, entry] of Object.entries(FILES[vendor]!)) {
          if (Array.isArray(entry)) for (const f of entry) expect(existsSync(join(FIX, f)), `${endpoint}: ${f} is missing`).toBe(true);
          else expect(entry.gap.length, `${endpoint}: say why there is no fixture`).toBeGreaterThan(10);
        }
      });
    });
  }

  it("report-template endpoints are never a gap", () => {
    // The endpoints behind the monthly, ranking, backlinks, indexing, speed and local sections must have recordings.
    const mustHave: [string, string][] = [
      ["google", "searchanalytics.query"],
      ["google", "properties.runReport"],
      ["google", "urlInspection.index.inspect"],
      ["dataforseo", "/dataforseo_labs/google/ranked_keywords/live"],
      ["dataforseo", "/backlinks/summary/live"],
      ["ahrefs", "/site-explorer/organic-keywords"],
      ["semrush", "/apis/v4/backlinks/v1/overview"],
      ["bing", "GetRankAndTrafficStats"],
      ["crux", "records:queryHistoryRecord"],
    ];
    for (const [vendor, endpoint] of mustHave) expect(Array.isArray(FILES[vendor]![endpoint]), `${vendor} ${endpoint}`).toBe(true);
  });
});
