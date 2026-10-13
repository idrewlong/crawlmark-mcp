/**
 * The builtin `monthly` template (always available, even with no template file
 * or an invalid one) and the starter file `report templates init` writes.
 * The starter's `monthly` is the builtin one, so both stay in step (tested).
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
    { id: "spend", type: "data_spend" },
    { id: "cwv", type: "core_web_vitals_history", optional: true, formFactor: "PHONE", weeks: 25 },
    { id: "gtm", type: "tag_manager", optional: true, limit: 20 },
  ],
};

export const BUILTIN_TEMPLATES: Readonly<Record<string, TemplateSpec>> = { monthly: BUILTIN_MONTHLY };
export const BUILTIN_DEFAULTS: { template: string; formats: Format[] } = { template: "monthly", formats: ["md", "html"] };

/** `<home>/config/report-templates.yaml` as `crawlmark-cli report templates init` writes it. */
export const STARTER_YAML = `# crawlmark report templates. Docs: docs/reports.md
version: 1
branding:                                # optional; a per-client file can override any field
  agencyName: Example Agency
  # logo: branding/logo.png              # relative to the config home; PNG or JPEG, at most 512 KB
  primaryColor: "#1f4e79"
  accentColor: "#2e8540"
  footer: "Prepared by Example Agency"
  paper: Letter                          # Letter or A4 (PDF only)
defaults:
  template: monthly
  formats: [md, html]
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
      - { id: spend, type: data_spend }
      # Optional: rendered only when asked for (include: [cwv] or --include cwv).
      - { id: cwv, type: core_web_vitals_history, optional: true, formFactor: PHONE, weeks: 25 }
      - { id: gtm, type: tag_manager, optional: true, limit: 20 }
  quarterly:
    title: Quarterly SEO review
    period: { range: last_quarter }
    compare: [previous_year]
    sections:
      - { id: search, type: search_overview }
      - { id: brand, type: branded_split }
      - { id: traffic, type: organic_traffic }
      - { id: queries, type: top_queries, limit: 25, includeBranded: false }
      - { id: pages, type: top_pages, limit: 25 }
      - { id: audit, type: audit_changes }
      - { id: note, type: text, text: "Next review: early next quarter." }
`;
