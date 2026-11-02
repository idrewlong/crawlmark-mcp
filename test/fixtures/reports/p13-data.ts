/**
 * Phase 13 A fixture data (spec A-2): TemplateReports with the technical_issues and indexing_issues
 * sections, data only (example.com), for the renderer tests and the sample PDF. No network.
 */
import type { BacklinksData, CompetitorOverviewData, IndexingIssuesData, SectionResult, TechIssue, TechnicalIssuesData, TemplateReport, VisibilityData } from "../../../src/reports/report-types.js";

const issue = (o: Partial<TechIssue> & Pick<TechIssue, "key" | "title" | "severity">): TechIssue => ({
  category: "content",
  url: null,
  affected: 1,
  sources: [],
  change: "persistent",
  ...o,
});

export const TECH_ISSUES: TechnicalIssuesData = {
  sources: [
    { source: "audit", runId: "20261009T080000000Z-0a1b2c3d", ranAt: "2026-10-09T08:00:00.000Z", stale: false, checks: ["lighthouse", "axe", "indexing", "onpage", "rendering", "site"] },
    { source: "local_crawl", runId: "crawl_20261011T060000000Z-1a2b3c4d", ranAt: "2026-10-11T06:00:00.000Z", stale: false },
    { source: "site_hygiene", runId: "20261009T080000000Z-0a1b2c3d", ranAt: "2026-10-09T08:00:00.000Z", stale: false },
    { source: "dataforseo_crawl", runId: "10111213-1415-1617-1819-202122232425", ranAt: "2026-08-20T10:00:00.000Z", stale: true },
  ],
  unavailable: [{ source: "gsc_inspection", reason: "no stored URL Inspection results for example.com yet" }],
  counts: { critical: 1, high: 2, medium: 3, low: 2 },
  changes: { new: 2, firstChecked: 0, resolved: 1, persistent: 4, unverified: 1, retired: 0 },
  base: { snapshotId: "iss_01JBASE00000000000000000000", capturedAt: "2026-09-01T07:00:00.000Z" },
  issues: [
    issue({ key: "a11y:button-name", title: "Buttons must have discernible text", severity: "critical", category: "accessibility", url: "https://example.com/contact", sources: [{ source: "audit", rule: "button-name", nativeSeverity: "critical", count: null, examples: ["https://example.com/contact"] }] }),
    issue({ key: "broken-internal-link", title: "Broken internal link", severity: "high", category: "links", url: "https://example.com/services", affected: 4, change: "new", sources: [{ source: "local_crawl", rule: "broken-internal-link", nativeSeverity: "high", count: null, examples: ["https://example.com/services"] }] }),
    issue({ key: "not-indexed", title: "Page is not indexed", severity: "high", category: "indexability", url: "https://example.com/old-offer", sources: [{ source: "audit", rule: "not-indexed", nativeSeverity: "high", count: null, examples: ["https://example.com/old-offer"] }] }),
    issue({
      key: "missing-title",
      title: "Page has no title",
      severity: "medium",
      category: "content",
      url: "https://example.com/thanks",
      change: "new",
      sources: [
        { source: "local_crawl", rule: "missing-title", nativeSeverity: "medium", count: null, examples: ["https://example.com/thanks"] },
        { source: "audit", rule: "no_title", nativeSeverity: "medium", count: null, examples: ["https://example.com/thanks"] },
      ],
    }),
    issue({ key: "duplicate-title", title: "Duplicate title tags", severity: "medium", category: "duplicates", affected: 6, sources: [{ source: "dataforseo_crawl", rule: "duplicate_title_tag", nativeSeverity: "medium", count: 6, examples: ["https://example.com/blog/page/2", "https://example.com/blog/page/3"] }] }),
    issue({ key: "canonical-mismatch", title: "Google chose a different canonical than the page declares", severity: "medium", category: "indexability", url: "https://example.com/pricing", change: "unverified", sources: [{ source: "audit", rule: "canonical-mismatch", nativeSeverity: "medium", count: null, examples: ["https://example.com/pricing"] }] }),
    issue({ key: "orphan-page", title: "Page in a sitemap with no internal links to it", severity: "low", category: "links", url: "https://example.com/landing/spring", sources: [{ source: "site_hygiene", rule: "orphan-page", nativeSeverity: "low", count: null, examples: ["https://example.com/landing/spring"] }] }),
    issue({ key: "ai-crawler-blocked", title: "An AI search crawler is blocked", severity: "low", category: "ai-discoverability", url: "https://example.com/", sources: [{ source: "site_hygiene", rule: "ai-search-crawler-blocked", nativeSeverity: "low", count: null, examples: ["https://example.com/"] }] }),
  ],
  resolved: [issue({ key: "redirect-chain", title: "Redirect chain", severity: "medium", category: "redirects", url: "https://example.com/old-blog", change: "resolved", sources: [{ source: "local_crawl", rule: "redirect-chain", nativeSeverity: "medium", count: null, examples: ["https://example.com/old-blog"] }] })],
  limit: 25,
  total: 8,
};

export const INDEXING: IndexingIssuesData = {
  property: "sc-domain:example.com",
  sample: { inspected: 40, inspectedThisRun: 25, keyPages: 5, sitemapUrls: 30, sitemapUrlsKnown: 120, oldestDays: 6 },
  indexed: { count: 31, share: 77.5 },
  byCoverage: [
    { state: "Submitted and indexed", count: 31, severity: null },
    { state: "Crawled - currently not indexed", count: 4, severity: "medium" },
    { state: "Discovered - currently not indexed", count: 2, severity: "medium" },
    { state: "Duplicate, Google chose different canonical than user", count: 2, severity: "medium" },
    { state: "Page with redirect", count: 1, severity: "low" },
  ],
  worst: [
    { url: "https://example.com/services/old", coverage: "Not found (404)", severity: "high", inSitemap: true, keyPage: false, lastCrawl: "2026-10-02T04:00:00Z", googleCanonical: null, inspectedAt: "2026-10-12T08:00:00.000Z" },
    { url: "https://example.com/blog/spring-tips", coverage: "Crawled - currently not indexed", severity: "medium", inSitemap: true, keyPage: false, lastCrawl: "2026-09-21T11:00:00Z", googleCanonical: null, inspectedAt: "2026-10-12T08:00:00.000Z" },
    { url: "https://example.com/pricing", coverage: "Duplicate, Google chose different canonical than user", severity: "medium", inSitemap: true, keyPage: true, lastCrawl: "2026-10-05T09:00:00Z", googleCanonical: "https://example.com/plans", inspectedAt: "2026-10-12T08:00:00.000Z" },
    { url: "https://example.com/tag/news", coverage: "Discovered - currently not indexed", severity: "medium", inSitemap: false, keyPage: false, lastCrawl: null, googleCanonical: null, inspectedAt: "2026-10-11T08:00:00.000Z" },
  ],
  canonicalMismatches: 2,
  sitemaps: [
    { path: "https://example.com/sitemap.xml", errors: 0, warnings: 1, submitted: 118, lastDownloaded: "2026-10-12T02:00:00Z", isPending: false },
    { path: "https://example.com/news-sitemap.xml", errors: 2, warnings: 0, submitted: 12, lastDownloaded: "2026-10-10T02:00:00Z", isPending: false },
  ],
  trend: [
    { month: "2026-07", inspected: 18, indexedShare: 72.2 },
    { month: "2026-08", inspected: 25, indexedShare: 76 },
    { month: "2026-09", inspected: 32, indexedShare: 75 },
    { month: "2026-10", inspected: 40, indexedShare: 77.5 },
  ],
  quota: { day: "2026-10-13", used: 25, budget: 1000, exhausted: false },
  notes: [],
};

/** A hostile title, coverage state and URL: must be inert in every format. */
export const XSS = "<img src=x onerror=alert(1)>";
export const TECH_ISSUES_XSS: TechnicalIssuesData = {
  ...TECH_ISSUES,
  issues: [issue({ key: "crawl:x", title: `${XSS} title`, severity: "high", url: `https://example.com/${XSS}`, sources: [{ source: "local_crawl", rule: "x", nativeSeverity: "high", count: null, examples: [] }] })],
  resolved: [],
  counts: { critical: 0, high: 1, medium: 0, low: 0 },
  total: 1,
};
export const INDEXING_XSS: IndexingIssuesData = {
  ...INDEXING,
  byCoverage: [{ state: `${XSS} state`, count: 3, severity: "medium" }],
  worst: [{ ...INDEXING.worst[0]!, url: `https://example.com/${XSS}`, coverage: `${XSS} state` }],
};

export const EMPTY_TECH_ISSUES: TechnicalIssuesData = { ...TECH_ISSUES, sources: [], counts: { critical: 0, high: 0, medium: 0, low: 0 }, changes: null, base: null, issues: [], resolved: [], total: 0 };
export const EMPTY_INDEXING: IndexingIssuesData = { ...INDEXING, sample: { inspected: 0, inspectedThisRun: 0, keyPages: 0, sitemapUrls: 0, sitemapUrlsKnown: 0, oldestDays: null }, indexed: { count: 0, share: null }, byCoverage: [], worst: [], canonicalMismatches: 0, sitemaps: [], trend: [] };

/** A fixed `technical` report holding the two Phase 13 A sections. */
export function p13Report(o: { issues?: TechnicalIssuesData; indexing?: IndexingIssuesData; extra?: SectionResult[] } = {}): TemplateReport {
  return {
    reportId: "rpt_01JP13FIXTURE00000000000000",
    client: { slug: "example.com", name: "Example Co", domain: "example.com" },
    template: { id: "technical", title: "Technical SEO report", source: "builtin" },
    period: { current: { startDate: "2026-09-01", endDate: "2026-09-30" }, label: "September 2026", folderMonth: "2026-09", comparisons: { previous_period: { startDate: "2026-08-01", endDate: "2026-08-31" } } },
    generatedAt: "2026-10-13T09:00:00.000Z",
    sections: [
      ...(o.extra ?? []),
      { id: "issues", type: "technical_issues", title: "Technical SEO issues", status: "ok", data: o.issues ?? TECH_ISSUES },
      { id: "indexing", type: "indexing_issues", title: "Google indexing", status: "ok", data: o.indexing ?? INDEXING },
    ],
    highlights: [],
    notes: [],
    spend: { usd: 0, units: { ahrefs: 0, semrush: 0 } },
  };
}

// ---------------------------------------------------------------- Phase 13 B (spec B-1): provider sections

export const BACKLINKS: BacklinksData = {
  provider: "dataforseo",
  target: "example.com",
  asOf: "2026-10-02",
  origin: "live",
  authority: { metric: "dataforseo_rank", label: "DataForSEO Rank (0–1000)", scale: "0-1000" },
  current: { backlinks: 1840, referringDomains: 212, authority: 312, newBacklinks: 96, lostBacklinks: 41, newReferringDomains: 19, lostReferringDomains: 5 },
  newLostLabel: "September 2026 (DataForSEO, monthly)",
  comparisons: {
    previous_period: {
      asOf: "2026-09-01",
      origin: "provider_history",
      previous: { backlinks: 1702, referringDomains: 198, authority: 305, newBacklinks: 80, lostBacklinks: 52, newReferringDomains: 12, lostReferringDomains: 7 },
      change: { backlinks: 138, referringDomains: 14, authority: 7, newBacklinks: 16, lostBacklinks: -11, newReferringDomains: 7, lostReferringDomains: -2 },
    },
    previous_year: null,
  },
  trend: [
    { day: "2026-05-01", referringDomains: 171, backlinks: 1420, authority: 290, origin: "provider_history" },
    { day: "2026-06-01", referringDomains: 180, backlinks: 1510, authority: 294, origin: "provider_history" },
    { day: "2026-07-01", referringDomains: 186, backlinks: 1588, authority: 298, origin: "provider_history" },
    { day: "2026-08-01", referringDomains: 191, backlinks: 1650, authority: 301, origin: "provider_history" },
    { day: "2026-09-01", referringDomains: 198, backlinks: 1702, authority: 305, origin: "provider_history" },
    { day: "2026-10-02", referringDomains: 212, backlinks: 1840, authority: 312, origin: "live" },
  ],
  notes: [],
};

export const VISIBILITY: VisibilityData = {
  provider: "dataforseo",
  target: "example.com",
  market: "2840",
  asOf: "2026-10-02",
  origin: "live",
  trafficLabel: "DataForSEO estimated traffic",
  distributionAvailable: true,
  current: { keywords: 1204, top3: 41, pos4_10: 118, pos11_20: 160, pos21_100: 885, traffic: 3950 },
  comparisons: {
    previous_period: {
      asOf: "2026-09-01",
      origin: "provider_history",
      previous: { keywords: 1130, top3: 36, pos4_10: 109, pos11_20: 151, pos21_100: 834, traffic: 3610 },
      change: { keywords: 74, top3: 5, pos4_10: 9, pos11_20: 9, pos21_100: 51, traffic: 340 },
    },
  },
  trend: [
    { day: "2026-06-01", origin: "provider_history", keywords: 1010, top3: 30, pos4_10: 97, pos11_20: 140, pos21_100: 743, traffic: 3200 },
    { day: "2026-07-01", origin: "provider_history", keywords: 1062, top3: 33, pos4_10: 101, pos11_20: 146, pos21_100: 782, traffic: 3390 },
    { day: "2026-08-01", origin: "provider_history", keywords: 1098, top3: 35, pos4_10: 105, pos11_20: 148, pos21_100: 810, traffic: 3500 },
    { day: "2026-09-01", origin: "provider_history", keywords: 1130, top3: 36, pos4_10: 109, pos11_20: 151, pos21_100: 834, traffic: 3610 },
    { day: "2026-10-02", origin: "live", keywords: 1204, top3: 41, pos4_10: 118, pos11_20: 160, pos21_100: 885, traffic: 3950 },
  ],
  notes: [],
};

export const COMPETITORS: CompetitorOverviewData = {
  provider: "dataforseo",
  market: "2840",
  asOf: "2026-10-02",
  trafficLabel: "DataForSEO estimated traffic",
  client: { domain: "example.com", origin: "client", commonKeywords: null, keywords: 1204, traffic: 3950, inProviderList: true, keywordsChange: 74 },
  competitors: [
    { domain: "competitor-a.example", origin: "saved", commonKeywords: 312, keywords: 2410, traffic: 8800, inProviderList: true, keywordsChange: 55 },
    { domain: "competitor-b.example", origin: "saved", commonKeywords: null, keywords: 640, traffic: 1200, inProviderList: false, keywordsChange: null },
    { domain: "rival.example.net", origin: "suggested", commonKeywords: 205, keywords: 1890, traffic: 5100, inProviderList: true, keywordsChange: null },
    { domain: "another.example.org", origin: "suggested", commonKeywords: 166, keywords: 980, traffic: 2050, inProviderList: true, keywordsChange: -12 },
  ],
  providerListSize: 20,
  notes: [],
};

export const BACKLINKS_AHREFS: BacklinksData = {
  ...BACKLINKS,
  provider: "ahrefs",
  authority: { metric: "domain_rating", label: "Ahrefs Domain Rating (0–100)", scale: "0-100" },
  current: { ...BACKLINKS.current, authority: 41, newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null },
  newLostLabel: null,
  comparisons: { previous_period: { ...BACKLINKS.comparisons.previous_period!, previous: { ...BACKLINKS.comparisons.previous_period!.previous, authority: 40, newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null }, change: { ...BACKLINKS.comparisons.previous_period!.change, authority: 1, newBacklinks: null, lostBacklinks: null, newReferringDomains: null, lostReferringDomains: null } } },
  trend: BACKLINKS.trend.map((p) => ({ ...p, backlinks: null, authority: 40 })),
};

export const VISIBILITY_SEMRUSH: VisibilityData = {
  ...VISIBILITY,
  provider: "semrush",
  market: "us",
  trafficLabel: "Semrush organic traffic",
  distributionAvailable: false,
  current: { keywords: 1204, top3: null, pos4_10: null, pos11_20: null, pos21_100: null, traffic: 3950 },
  comparisons: { previous_period: { asOf: "2026-09-15", origin: "provider_history", previous: { keywords: 1130, top3: null, pos4_10: null, pos11_20: null, pos21_100: null, traffic: 3610 }, change: { keywords: 74, top3: null, pos4_10: null, pos11_20: null, pos21_100: null, traffic: 340 } } },
  trend: VISIBILITY.trend.map((p) => ({ ...p, top3: null, pos4_10: null, pos11_20: null, pos21_100: null })),
  notes: ["Semrush's API doesn't report keywords by position band."],
};

export const COMPETITORS_XSS: CompetitorOverviewData = {
  ...COMPETITORS,
  competitors: [{ domain: `${XSS}.example`, origin: "suggested", commonKeywords: 3, keywords: 4, traffic: 5, inProviderList: true, keywordsChange: null }],
};

/** A fixed `monthly` report with the three Phase 13 B sections (and anything in `extra` first). */
export function p13bReport(o: { backlinks?: BacklinksData; visibility?: VisibilityData; competitors?: CompetitorOverviewData; extra?: SectionResult[]; hideCrawlmark?: boolean } = {}): TemplateReport {
  return {
    ...p13Report(),
    template: { id: "monthly", title: "Monthly SEO report", source: "builtin" },
    sections: [
      ...(o.extra ?? []),
      { id: "backlinks", type: "backlinks", title: "Backlinks", status: "ok", data: o.backlinks ?? BACKLINKS },
      { id: "visibility", type: "organic_visibility", title: "Organic search visibility", status: "ok", data: o.visibility ?? VISIBILITY },
      { id: "competitors", type: "competitor_overview", title: "Competitors", status: "ok", data: o.competitors ?? COMPETITORS },
    ],
  };
}
