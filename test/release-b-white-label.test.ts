/**
 * Release B (B2.4): white label. With hideCrawlmark the generated text in every format names neither crawlmark,
 * Claude nor DataForSEO, in every section type that used to. Attribution stays: "Source: Ahrefs" and "Source:
 * Semrush" lines are never changed, and a branding can keep the DataForSEO name with hideProviders: false.
 * Fixture data only (example.com); no network.
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import type { AiVisibilityData, KeywordGapData, LocalProfileData, RankTrendData, SectionResult, TemplateReport } from "../src/reports/report-types.js";
import { BACKLINKS_AHREFS, p13bReport, p13Report, VISIBILITY_SEMRUSH } from "./fixtures/reports/p13-data.js";

const v = { version: "0.3.0" };
const LEAK = /crawlmark|claude|dataforseo/i;

const LOCAL: LocalProfileData = {
  business: { title: "Example Plumbing", category: "Plumber", address: "1 Main St, Springfield", url: "https://example.com/", rating: 4.8, votes: 120, ratingDistribution: { "1": 1, "2": 1, "3": 3, "4": 20, "5": 95 }, isClaimed: true, totalPhotos: 40, currentStatus: "open" },
  location: "Springfield,Example State,United States",
  pack: [{ keyword: "plumber springfield", clientRank: 2, leader: { title: "Example Rival", rating: 4.9, votes: 300 } }],
  notes: ["No area is set for this client: set_client_profile adds one."],
};
const AI: AiVisibilityData = {
  mode: "mentions",
  platform: "google",
  domain: "example.com",
  mentions: { total: 1, items: [{ question: "how to fix a leaking tap", aiSearchVolume: 900, citedUrl: "https://example.com/leaks", position: 2 }] },
};
const AI_EMPTY: AiVisibilityData = { mode: "mentions", platform: "chat_gpt", domain: "example.com", mentions: { total: 0, items: [] } };
const GAP = (provider: KeywordGapData["provider"]): KeywordGapData => ({
  provider,
  competitors: ["rival.example"],
  limit: 10,
  gaps: [{ keyword: "emergency plumber", volume: 1900, difficulty: { metric: `${provider}_kd` as "dataforseo_kd", value: 31 }, competitors: [{ domain: "rival.example", position: 3, url: null }], clientPosition: null, clientCheck: "provider" }],
  perCompetitor: [{ domain: "rival.example", returned: 1 }],
});
const RANKS: RankTrendData = {
  since: "2026-08-01",
  until: "2026-09-30",
  source: "both",
  keywords: [{ keyword: "plumber springfield", gsc: { latest: 5, first: 7, latestDay: "2026-09-30", firstDay: "2026-08-01", best: 4, worst: 8, change: -2, change30d: -1, change90d: null, checks: 8, noRank: 0 }, serp: { latest: 4, first: 6, latestDay: "2026-09-30", firstDay: "2026-08-01", best: 3, worst: 7, change: -2, change30d: -1, change90d: null, checks: 3, noRank: 0 } }],
};

const ok = (id: string, type: string, title: string, data: unknown): SectionResult => ({ id, type, title, status: "ok", data });

/** Every section type that has provider-specific wording, with data, plus commentary-free generated text. */
function fullReport(): TemplateReport {
  const r = p13bReport({
    extra: [
      ok("local", "local_profile", "Local search", LOCAL),
      ok("ai", "ai_visibility", "AI search visibility", AI),
      ok("ai-empty", "ai_visibility", "AI search visibility (ChatGPT)", AI_EMPTY),
      ok("gap", "keyword_gap", "Keyword gap", GAP("dataforseo")),
      ok("ranks", "rank_trend", "Rank trend", RANKS),
      ok("spend", "data_spend", "Data spend", { month: "2026-09", usd: 1.23, units: { ahrefs: 12, semrush: 5 } }),
    ],
  });
  r.sections.push(...p13Report().sections);
  r.notes = ["Rank trends use stored checks."];
  return r;
}

const docXml = async (doc: ReturnType<typeof buildReportDoc>) => (await JSZip.loadAsync(await toDocx(doc))).file("word/document.xml")!.async("string");
const texts = async (doc: ReturnType<typeof buildReportDoc>) => [toMarkdown(doc), toHtml(doc), await docXml(doc)];

describe("white label", () => {
  it("the full fixture has no crawlmark, Claude or DataForSEO in Markdown, HTML or DOCX text", async () => {
    const doc = buildReportDoc(fullReport(), { ...v, narrative: { summary: "Clicks grew.", sections: { local: "Maps look good." } }, branding: { hideCrawlmark: true } });
    for (const text of await texts(doc)) expect(text).not.toMatch(LEAK);
    // The sections really were rendered (the test would pass vacuously on an empty report).
    const md = toMarkdown(doc);
    for (const h of ["## Local search", "## AI search visibility", "## Keyword gap", "## Rank trend", "## Data spend", "## Technical SEO issues", "## Backlinks"]) expect(md).toContain(h);
  });

  it("the replacement wording", async () => {
    const md = toMarkdown(buildReportDoc(fullReport(), { ...v, narrative: { summary: "Clicks grew." }, branding: { hideCrawlmark: true } }));
    expect(md).toContain("Source: a third-party SEO data provider. Figures as of");
    expect(md).toContain("Keyword difficulty");
    expect(md).toContain("Site crawl (third-party)");
    expect(md).toContain("Live rank is Google's organic position on the day it was checked; ");
    expect(md).toContain("From Google Maps and the Google Business Profile when this report was generated.");
    expect(md).toContain("From an AI-answer dataset when this report was generated (paid).");
    expect(md).toContain("No Google AI Overviews in this AI-answer dataset cite this site yet.".replace("Google AI Overviews", "ChatGPT answers (United States, English)"));
    expect(md).toContain("pay-per-use data $1.23, Ahrefs 12 units, Semrush 5 units");
    expect(md).toContain("Keywords rival.example rank for and this site doesn't (third-party data, up to 10 per competitor)");
    expect(md).toContain("Written commentary; all figures come from the data below.");
  });

  it("the Source line for Ahrefs and Semrush is kept", async () => {
    const r = p13bReport({ backlinks: BACKLINKS_AHREFS, visibility: VISIBILITY_SEMRUSH });
    r.sections.push(ok("gap", "keyword_gap", "Keyword gap", GAP("ahrefs")));
    const doc = buildReportDoc(r, { ...v, branding: { hideCrawlmark: true } });
    for (const text of await texts(doc)) {
      expect(text).toContain("Source: Ahrefs.");
      expect(text).toContain("Source: Semrush.");
      expect(text).not.toMatch(LEAK);
    }
    expect(toMarkdown(doc)).toContain("Ahrefs KD");
  });

  it("hideProviders: false with hideCrawlmark: true keeps DataForSEO but not crawlmark or Claude", async () => {
    const doc = buildReportDoc(fullReport(), { ...v, narrative: { summary: "Clicks grew." }, branding: { hideCrawlmark: true, hideProviders: false } });
    for (const text of await texts(doc)) {
      expect(text).toMatch(/dataforseo/i);
      expect(text).not.toMatch(/crawlmark|claude/i);
    }
    expect(toMarkdown(doc)).toContain("DataForSEO difficulty");
  });

  it("hideProviders: true alone hides DataForSEO and keeps the crawlmark footer", async () => {
    const doc = buildReportDoc(fullReport(), { ...v, branding: { hideProviders: true } });
    const md = toMarkdown(doc);
    expect(md).not.toMatch(/dataforseo/i);
    expect(md).toMatch(/crawlmark/i);
  });

  it("without any white label the generated text names DataForSEO as before", async () => {
    const md = toMarkdown(buildReportDoc(fullReport(), v));
    expect(md).toContain("Source: DataForSEO. Figures as of");
    expect(md).toContain("via DataForSEO");
    expect(md).toContain("DataForSEO difficulty");
  });

  it("commentaryNote: a custom note is shown, an empty one removes the line, in every format", async () => {
    const r = fullReport();
    const custom = buildReportDoc(r, { ...v, narrative: { summary: "Clicks grew." }, branding: { hideCrawlmark: true, commentaryNote: "Analysis by Example Agency." } });
    for (const text of await texts(custom)) {
      expect(text).toContain("Analysis by Example Agency.");
      expect(text).not.toMatch(/Written commentary|written with/i);
    }
    const none = buildReportDoc(r, { ...v, narrative: { summary: "Clicks grew." }, branding: { hideCrawlmark: true, commentaryNote: "" } });
    for (const text of await texts(none)) {
      expect(text).not.toMatch(/Written commentary|written with/i);
      expect(text).toContain("Clicks grew.");
    }
  });
});
