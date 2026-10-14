/**
 * Phase 13 A fixture data (spec A-2): TemplateReports with the technical_issues and indexing_issues
 * sections, data only (example.com), for the renderer tests and the sample PDF. No network.
 */
import type { IndexingIssuesData, SectionResult, TechIssue, TechnicalIssuesData, TemplateReport } from "../../../src/reports/report-types.js";

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
  changes: { new: 2, resolved: 1, persistent: 4, unverified: 1 },
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
