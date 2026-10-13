import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  mapBacklinksSummary,
  mapCompetitors,
  mapInstantPage,
  mapRankedKeywords,
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
