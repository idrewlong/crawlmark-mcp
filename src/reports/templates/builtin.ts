/**
 * The builtin templates (always available, even with no template file or an
 * invalid one): `monthly`, `quarterly`, `executive`, `technical` and `local`, and the
 * starter file `report templates init` writes. The starter's `monthly` and
 * `quarterly` are the builtin ones, so they stay in step (tested).
 */
import type { Format, TemplateSpec } from "./schema.js";

export const BUILTIN_MONTHLY: TemplateSpec = {
  title: "Monthly SEO report",
  description: "The same data as monthly_report.",
  period: { range: "last_month" },
  compare: ["previous_period", "previous_year"],
  sections: [
    { id: "search", type: "search_overview", metrics: ["clicks", "impressions", "ctr", "position"] },
    { id: "brand", type: "branded_split" },
    { id: "traffic", type: "organic_traffic", metrics: ["sessions", "users", "engagementRate", "keyEvents"] },
    { id: "queries", type: "top_queries", limit: 20 },
    { id: "query-movers", type: "query_movers", limit: 10 },
    { id: "pages", type: "top_pages", limit: 15 },
    { id: "page-movers", type: "page_movers", limit: 10 },
    { id: "landing", type: "landing_pages", limit: 15 },
    { id: "tracked", type: "tracked_keywords" },
    { id: "opportunities", type: "opportunities", limit: 5 },
    { id: "audit", type: "audit_changes" },
    // Paid data spend is operator information: it's in the tool and CLI results, and in the file only when asked for.
    { id: "spend", type: "data_spend", optional: true },
    { id: "cwv", type: "core_web_vitals_history", optional: true, formFactor: "PHONE", weeks: 25 },
    { id: "gtm", type: "tag_manager", optional: true, limit: 20 },
    { id: "ranks", type: "rank_trend", optional: true, since: "180d" },
    { id: "ai", type: "ai_readiness", optional: true },
    // Phase 13 A (free): one technical-issues list from stored results, and Google indexing of a sample of URLs.
    { id: "issues", type: "technical_issues", optional: true },
    { id: "indexing", type: "indexing_issues", optional: true },
  ],
};

export const BUILTIN_QUARTERLY: TemplateSpec = {
  title: "Quarterly SEO review",
  description: "The last quarter against the quarter before and the same quarter last year: trends, movers and rank history.",
  period: { range: "last_quarter" },
  compare: ["previous_period", "previous_year"],
  sections: [
    { id: "search", type: "search_overview", metrics: ["clicks", "impressions", "ctr", "position"] },
    { id: "brand", type: "branded_split" },
    { id: "traffic", type: "organic_traffic", metrics: ["sessions", "users", "engagementRate", "keyEvents"] },
    { id: "ranks", type: "rank_trend", since: "180d" },
    { id: "queries", type: "top_queries", limit: 15, includeBranded: false },
    { id: "query-movers", type: "query_movers", limit: 10 },
    { id: "pages", type: "top_pages", limit: 15 },
    { id: "page-movers", type: "page_movers", limit: 10 },
    { id: "landing", type: "landing_pages", limit: 10 },
    { id: "tracked", type: "tracked_keywords" },
    { id: "opportunities", type: "opportunities", limit: 5 },
    { id: "audit", type: "audit_changes" },
    { id: "cwv", type: "core_web_vitals_history", optional: true, formFactor: "PHONE", weeks: 25 },
    { id: "issues", type: "technical_issues", optional: true },
  ],
};

export const BUILTIN_EXECUTIVE: TemplateSpec = {
  title: "Executive summary",
  description: "One page: the key figures, the clicks trend, the top wins and the biggest opportunities.",
  period: { range: "last_month" },
  compare: ["previous_period", "previous_year"],
  layout: "onepage",
  sections: [
    { id: "search", type: "search_overview", title: "Clicks this period" },
    { id: "wins", type: "query_movers", limit: 3, title: "Top wins" },
    { id: "next", type: "opportunities", limit: 3, title: "Next steps" },
  ],
};

export const BUILTIN_TECHNICAL: TemplateSpec = {
  title: "Technical SEO report",
  description: "For web teams: the local site crawl, Core Web Vitals history, audit changes, AI readiness and (opt-in) Tag Manager, technical issues and Google indexing.",
  period: { range: "last_month" },
  compare: ["previous_period"],
  sections: [
    { id: "crawl", type: "site_crawl", limit: 15, title: "Site health (crawl)" },
    { id: "cwv", type: "core_web_vitals_history", formFactor: "PHONE", weeks: 25 },
    { id: "audit", type: "audit_changes", limit: 20 },
    { id: "ai", type: "ai_readiness" },
    { id: "gtm", type: "tag_manager", optional: true, limit: 20 },
    { id: "issues", type: "technical_issues", optional: true, limit: 30 },
    { id: "indexing", type: "indexing_issues", optional: true, maxInspections: 25 },
  ],
};

export const BUILTIN_LOCAL: TemplateSpec = {
  title: "Local SEO report",
  description: "For local businesses: search clicks and the branded split, the Google Business Profile and map-pack positions (paid), local-intent searches, landing pages and tracked keywords.",
  period: { range: "last_month" },
  compare: ["previous_period", "previous_year"],
  sections: [
    { id: "search", type: "search_overview", metrics: ["clicks", "impressions", "ctr", "position"] },
    { id: "brand", type: "branded_split" },
    // Paid (DataForSEO): runs with allowPaid / --paid and a confirmed gbpPlaceId; otherwise it is left out of the file.
    { id: "local", type: "local_profile", paid: true, packKeywords: 5 },
    { id: "queries", type: "top_queries", limit: 15, intent: "local", title: "Local searches" },
    { id: "landing", type: "landing_pages", limit: 10 },
    { id: "tracked", type: "tracked_keywords" },
  ],
};

/** Builtin template ids, in listing order. */
export const BUILTIN_TEMPLATES: Readonly<Record<string, TemplateSpec>> = {
  monthly: BUILTIN_MONTHLY,
  quarterly: BUILTIN_QUARTERLY,
  executive: BUILTIN_EXECUTIVE,
  technical: BUILTIN_TECHNICAL,
  local: BUILTIN_LOCAL,
};
/** One PDF unless a template file says otherwise: reports are never exported in every format by default. */
export const BUILTIN_DEFAULTS: { template: string; formats: Format[] } = { template: "monthly", formats: ["pdf"] };

/** `<home>/config/report-templates.yaml` as `crawlmark-cli report templates init` writes it. */
export const STARTER_YAML = `# crawlmark report templates. Docs: docs/reports.md
# Builtin templates: monthly, quarterly, executive (one page), technical (for web teams) and local (Local SEO).
# The two below are copies of the builtin monthly and quarterly; edit them, or add your own.
version: 1
branding:                                # optional; a per-client file can override any field
  agencyName: Example Agency
  # logo: branding/logo.png              # relative to the config home; PNG or JPEG, at most 512 KB
  primaryColor: "#1f4e79"
  accentColor: "#2e8540"
  footer: "Prepared by Example Agency"
  paper: Letter                          # Letter or A4 (PDF and Word)
  # hideCrawlmark: true                  # white label: no crawlmark name or version in client files
defaults:
  template: monthly
  formats: [pdf]                         # any of pdf, docx, html, md; --format (CLI) or formats (export_report) wins
templates:
  monthly:
    title: Monthly SEO report
    description: The same data as monthly_report.
    period: { range: last_month }
    compare: [previous_period, previous_year]
    sections:
      - { id: search, type: search_overview, metrics: [clicks, impressions, ctr, position] }
      - { id: brand, type: branded_split }
      - { id: traffic, type: organic_traffic, metrics: [sessions, users, engagementRate, keyEvents] }
      - { id: queries, type: top_queries, limit: 20 }
      - { id: query-movers, type: query_movers, limit: 10 }
      - { id: pages, type: top_pages, limit: 15 }
      - { id: page-movers, type: page_movers, limit: 10 }
      - { id: landing, type: landing_pages, limit: 15 }
      - { id: tracked, type: tracked_keywords }
      - { id: opportunities, type: opportunities, limit: 5 }
      - { id: audit, type: audit_changes }
      # Optional: rendered only when asked for (include: [cwv] or --include cwv).
      # Paid data spend this month (operator information; the tool and CLI results always have it): --include spend.
      - { id: spend, type: data_spend, optional: true }
      - { id: cwv, type: core_web_vitals_history, optional: true, formFactor: PHONE, weeks: 25 }
      - { id: gtm, type: tag_manager, optional: true, limit: 20 }
      # Stored rank history (free; fill it with crawlmark-cli check-ranks): --include ranks.
      - { id: ranks, type: rank_trend, optional: true, since: 180d }
      # llms.txt and AI crawler access from the newest saved audit (free): --include ai.
      - { id: ai, type: ai_readiness, optional: true }
      # One deduplicated technical-issues list from stored audits and crawls (free): --include issues.
      - { id: issues, type: technical_issues, optional: true }
      # Google indexing of a sample of URLs (free URL Inspection, within a daily budget): --include indexing.
      - { id: indexing, type: indexing_issues, optional: true }
      # Paid example: competitor keyword gap (needs paid: true here and --paid / allowPaid at run time).
      # - { id: gap, type: keyword_gap, optional: true, paid: true, limit: 25 }
  quarterly:
    title: Quarterly SEO review
    description: "The last quarter against the quarter before and the same quarter last year: trends, movers and rank history."
    period: { range: last_quarter }
    compare: [previous_period, previous_year]
    sections:
      - { id: search, type: search_overview, metrics: [clicks, impressions, ctr, position] }
      - { id: brand, type: branded_split }
      - { id: traffic, type: organic_traffic, metrics: [sessions, users, engagementRate, keyEvents] }
      - { id: ranks, type: rank_trend, since: 180d }
      - { id: queries, type: top_queries, limit: 15, includeBranded: false }
      - { id: query-movers, type: query_movers, limit: 10 }
      - { id: pages, type: top_pages, limit: 15 }
      - { id: page-movers, type: page_movers, limit: 10 }
      - { id: landing, type: landing_pages, limit: 10 }
      - { id: tracked, type: tracked_keywords }
      - { id: opportunities, type: opportunities, limit: 5 }
      - { id: audit, type: audit_changes }
      - { id: cwv, type: core_web_vitals_history, optional: true, formFactor: PHONE, weeks: 25 }
      - { id: issues, type: technical_issues, optional: true }
`;
