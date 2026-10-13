import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mapBacklinksSummary,
  mapCompetitors,
  mapInstantPage,
  mapRankedKeywords,
  mapUserData,
  dataForSeoMode,
  isAuthRejection,
} from "../src/providers/dataforseo-shape.js";

function fixture(name: string) {
  const json = JSON.parse(readFileSync(new URL(`./fixtures/dataforseo/${name}.json`, import.meta.url), "utf8"));
  return json.tasks[0].result[0];
}

describe("mapRankedKeywords", () => {
  const out = mapRankedKeywords(fixture("dataforseo_labs_google_ranked_keywords_live"));

  it("shapes a full item", () => {
    expect(out.target).toBe("example.com");
    expect(out.totalCount).toBe(9528);
    expect(out.items[0]).toEqual({
      keyword: "1000 keywords",
      position: 1,
      searchVolume: 40,
      url: "https://example.com/free-seo-stats/top-1000-keywords",
      estimatedTraffic: 12.16,
    });
  });

  it("keeps items with null volume/traffic and with a missing serp item", () => {
    expect(out.items.find((i) => i.keyword === "edge case null volume and traffic")).toMatchObject({
      position: 4,
      searchVolume: null,
      estimatedTraffic: null,
    });
    expect(out.items.find((i) => i.keyword === "edge case missing serp item")).toEqual({
      keyword: "edge case missing serp item",
      position: null,
      searchVolume: null,
      url: null,
      estimatedTraffic: null,
    });
  });

  it("excludes non-organic (paid) items", () => {
    expect(out.items.map((i) => i.keyword)).not.toContain("edge case paid item");
    expect(out.items).toHaveLength(5);
  });

  it("handles an empty result", () => {
    expect(mapRankedKeywords(undefined)).toEqual({ target: null, totalCount: null, items: [] });
  });
});

describe("mapCompetitors", () => {
  const out = mapCompetitors(fixture("dataforseo_labs_google_competitors_domain_live"));

  it("shapes a full item", () => {
    expect(out.items[0]).toEqual({
      domain: "competitor-one.example",
      intersectingKeywords: 116,
      avgPosition: 13.91,
      estimatedTraffic: 236.52,
    });
  });

  it("tolerates null metrics and drops items without a domain", () => {
    expect(out.items).toHaveLength(4);
    expect(out.items.find((i) => i.domain === "edge-case-null-metrics.example")).toMatchObject({ estimatedTraffic: null });
  });
});

describe("mapBacklinksSummary", () => {
  it("shapes the summary", () => {
    expect(mapBacklinksSummary(fixture("backlinks_summary_live"))).toEqual({
      target: "example.com",
      backlinks: 285501,
      referringDomains: 3044,
      rank: 52,
      spamScore: 16,
      newBacklinks: null,
      lostBacklinks: null,
    });
  });

  it("returns null for no result and nulls for missing fields", () => {
    expect(mapBacklinksSummary(undefined)).toBeNull();
    expect(mapBacklinksSummary({ target: "example.com", rank: null })).toMatchObject({ rank: null, backlinks: null });
  });
});

describe("mapInstantPage", () => {
  it("shapes the page; failedChecks has known problem checks only (not is_https, canonical, high_content_rate)", () => {
    expect(mapInstantPage(fixture("on_page_instant_pages"))).toEqual({
      url: "https://example.com/blog",
      status: 200,
      title: "Example Blog - Insights",
      description: "Example description text",
      h1: "Blog",
      canonical: "https://example.com/blog",
      wordCount: 554,
      failedChecks: ["flash", "has_micromarkup_errors", "low_content_rate", "no_image_alt", "no_image_title"],
    });
  });

  it("collapses repeated whitespace in title, description and h1", () => {
    const page = mapInstantPage({
      items: [{ url: "https://example.com/", meta: { title: " Example \n  Co ", description: "A  B", htags: { h1: ["Example   Systems"] } } }],
    });
    expect(page).toMatchObject({ title: "Example Co", description: "A B", h1: "Example Systems" });
  });

  it("handles missing meta, h1 and checks", () => {
    expect(mapInstantPage({ items: [{ url: "https://example.com/", status_code: 404, meta: null, checks: null }] })).toEqual({
      url: "https://example.com/",
      status: 404,
      title: null,
      description: null,
      h1: null,
      canonical: null,
      wordCount: null,
      failedChecks: [],
    });
    expect(mapInstantPage({ items: [] })).toBeNull();
    expect(mapInstantPage(undefined)).toBeNull();
  });
});

describe("mapUserData", () => {
  const raw = fixture("appendix_user_data");

  it("keeps only mode, host, balance, total and timezone, never the login", () => {
    const out = mapUserData(raw, "https://sandbox.dataforseo.com/v3");
    expect(out).toEqual({ mode: "sandbox", apiHost: "sandbox.dataforseo.com", balanceUsd: 42.125, totalUsd: 250.5, timezone: "Europe/Kyiv" });
    expect(JSON.stringify(out)).not.toContain("example.com/");
    expect(JSON.stringify(out)).not.toContain("login@");
  });

  it("is live for the production host", () => {
    expect(mapUserData(raw, "https://api.dataforseo.com/v3").mode).toBe("live");
  });

  it("returns nulls for a missing or odd result", () => {
    expect(mapUserData(undefined, "https://api.dataforseo.com/v3")).toMatchObject({ balanceUsd: null, totalUsd: null, timezone: null });
    expect(mapUserData({ money: { balance: "x" as unknown as number } }, "https://api.dataforseo.com/v3").balanceUsd).toBeNull();
  });
});

describe("dataForSeoMode", () => {
  it("treats sandbox hosts as sandbox and anything else (including junk) as live", () => {
    expect(dataForSeoMode("https://sandbox.dataforseo.com/v3")).toBe("sandbox");
    expect(dataForSeoMode("https://api.dataforseo.com/v3")).toBe("live");
    expect(dataForSeoMode("not a url")).toBe("live");
  });
});

describe("isAuthRejection", () => {
  it("is true only for an auth rejection", () => {
    expect(isAuthRejection("DataForSEO /appendix/user_data HTTP 401: Unauthorized")).toBe(true);
    expect(isAuthRejection("DataForSEO /appendix/user_data HTTP 403: Forbidden")).toBe(true);
    expect(isAuthRejection("DataForSEO /appendix/user_data 40101: Authentication failed")).toBe(true);
    for (const m of ["fetch failed", "DataForSEO /x HTTP 500: boom", "DataForSEO /x HTTP 429: slow down", "The operation was aborted due to timeout", "DataForSEO /x 40200: Payment required"]) {
      expect(isAuthRejection(m), m).toBe(false);
    }
  });
});
