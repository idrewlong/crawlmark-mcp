/**
 * The TemplateReport model (12.A.2) shared by runTemplate, the highlights and
 * every renderer. Types only, so renderers never load provider code.
 */
import type { DateRange } from "../lib/dates.js";
import type { Comparison } from "./templates/schema.js";
import type { TemplateSource } from "./templates/load.js";

export type { Comparison, DateRange, TemplateSource };

export interface PeriodTotals {
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}

export interface ComparedTotals {
  clicks: { value: number; change: number | null };
  impressions: { value: number; change: number | null };
  ctr: { value: number; change: number | null };
  position: { value: number; change: number | null };
  previous: PeriodTotals | null;
}

/** One day of Search Console totals (the `date` dimension). */
export interface DailySearchPoint {
  date: string;
  clicks: number;
  impressions: number;
}

/** A daily series for the period and its first comparison (charts in the report files). */
export interface DailySeries<T> {
  current: T[];
  /** The first comparison's days, or null when there is no comparison or it couldn't be fetched. */
  previous: T[] | null;
  comparedWith: Comparison | null;
}

export interface SearchOverviewData {
  metrics: ("clicks" | "impressions" | "ctr" | "position")[];
  current: PeriodTotals;
  vsPreviousPeriod: ComparedTotals | null;
  vsPreviousYear: ComparedTotals | null;
  /** Why a comparison is null because its fetch failed (tool result only; the files show fixed text). */
  comparisonErrors?: Partial<Record<Comparison, string>>;
  /** Clicks and impressions per day (free; absent when the daily rows couldn't be fetched). */
  daily?: DailySeries<DailySearchPoint>;
}

export interface SplitSide {
  current: { queries: number; clicks: number; impressions: number; ctr: number; position: number | null };
  previous: { queries: number; clicks: number; impressions: number; ctr: number; position: number | null };
  change: { clicks: number | null; impressions: number | null; ctr: number | null; position: number | null };
}

export interface BrandedSplitData {
  comparedWith: Comparison | null;
  branded: SplitSide;
  nonBranded: SplitSide;
  brandedShareOfClicks: { current: number | null; previous: number | null };
  queryRows: { current: number; previous: number; limit: number };
  note: string;
  brandTerms: string[];
}

export interface OrganicTrafficData {
  metrics: ("sessions" | "users" | "engagementRate" | "keyEvents")[];
  comparedWith: Comparison | null;
  sessions: { value: number; change: number | null };
  users: { value: number; change: number | null };
  engagementRate: { value: number; change: number | null };
  keyEvents: { value: number; change: number | null };
  previous: { sessions: number; users: number; engagementRate: number; keyEvents: number } | null;
  /** Organic sessions per day (GA4 `date` dimension; absent when it couldn't be fetched). */
  daily?: DailySeries<{ date: string; sessions: number }>;
}

export interface QueryRowOut {
  keys: string[];
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  branded?: boolean;
}

export interface TopRowsData {
  rows: QueryRowOut[];
  /** top_queries with `intent: local`: the rows are local-intent searches, or (fallback) the top queries overall when there were none. */
  intent?: "local";
  intentFallback?: boolean;
}

export interface Mover {
  key: string;
  clicks: number;
  clicksDelta: number;
  position: number;
  positionDelta: number | null;
  branded?: boolean;
}

export interface MoversData {
  comparedWith: Comparison;
  gainers: Mover[];
  losers: Mover[];
}

export interface LandingPagesData {
  rows: Record<string, string | number>[];
}

export interface TrackedKeywordRow {
  keyword: string;
  branded: boolean;
  gscPosition: number | null;
  gscClicks: number;
  gscImpressions: number;
  liveRank: number | null;
  liveUrl: string | null;
  /** Search Console average position in the comparison period, when there is one. */
  gscPositionPrevious: number | null;
  /** gscPosition - gscPositionPrevious (negative is an improvement). */
  positionChange: number | null;
}

export interface TrackedKeywordsData {
  comparedWith: Comparison | null;
  keywords: TrackedKeywordRow[];
  liveRanks?: { available: true } | { available: false; reason: string };
}

/** monthly_report's `opportunities` section (type-only import: renderers never load provider code). */
export type OpportunityLists = Awaited<ReturnType<typeof import("./opportunities.js").opportunitiesForMonth>>;

export interface AuditFindingOut {
  id: string;
  source: string;
  rule: string;
  url: string;
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  evidence?: string;
}

export interface AuditChangesData {
  limit: number;
  /** Null when there is no audit from before the period and a newer one to compare it with. */
  comparison: {
    auditId: string;
    ranAt: string;
    summary: unknown;
    diff: {
      base: { auditId: string; ranAt: string };
      target: { auditId: string; ranAt: string };
      new: AuditFindingOut[];
      resolved: AuditFindingOut[];
      persistent: AuditFindingOut[];
      unverified: AuditFindingOut[];
      scoreChanges: { url: string; category: string; from: number; to: number }[];
      warnings: string[];
      counts: { new: number; resolved: number; persistent: number; unverified: number };
    };
  } | null;
}

export type CwvRating = "good" | "needs-improvement" | "poor";

export interface CwvSeries {
  unit: "ms" | "score";
  p75: (number | null)[];
  latest: number | null;
  first: number | null;
  change: number | null;
  rating: (CwvRating | null)[];
  trend: "improving" | "worsening" | "flat" | "insufficient-data";
}

export type CwvMetric = "lcp" | "inp" | "cls" | "fcp" | "ttfb";

export type CruxHistoryResult =
  | {
      key: { origin?: string; url?: string; formFactor: string };
      keySource: "CRUX_API_KEY" | "PSI_API_KEY";
      available: true;
      periods: { start: string; end: string }[];
      metrics: Partial<Record<CwvMetric, CwvSeries>>;
      fromCache: boolean;
    }
  | { key: { origin?: string; url?: string; formFactor: string }; keySource: "CRUX_API_KEY" | "PSI_API_KEY"; available: false; reason: string };

export interface TagManagerData {
  limit: number;
  container: { publicId: string; name: string };
  liveVersion: { versionId: string; name: string | null } | null;
  summary: { tags: number; triggers: number; variables: number; findings: number; bySeverity: Record<"medium" | "low", number>; consentModeDetected: boolean };
  /** The first `limit` findings (most severe first); `summary.findings` is the total. */
  findings: { id: string; rule: string; severity: "medium" | "low"; title: string; entity: { kind: "tag" | "trigger" | "variable"; id: string; name: string }; evidence?: string }[];
  notes: string[];
}

export interface DataSpendData {
  month: string;
  usd: number;
  units: { ahrefs: number; semrush: number };
}

/** Phase 12 B: one source's summary for a keyword (analysis/ranks.ts RankSummary; lower is better). */
export interface RankTrendSummary {
  latest: number | null;
  first: number | null;
  latestDay: string | null;
  firstDay: string | null;
  best: number | null;
  worst: number | null;
  change: number | null;
  change30d: number | null;
  change90d: number | null;
  checks: number;
  noRank: number;
}

export interface RankTrendData {
  since: string;
  until: string;
  source: "gsc" | "serp" | "both";
  keywords: {
    keyword: string;
    gsc?: RankTrendSummary;
    serp?: RankTrendSummary;
    /** The stored points (at most RANK_SERIES_MAX per source, evenly thinned), for the trend chart. */
    series?: { gsc?: { day: string; rank: number | null }[]; serp?: { day: string; rank: number | null }[] };
  }[];
}

export interface KeywordGapData {
  provider: "dataforseo" | "ahrefs" | "semrush";
  competitors: string[];
  limit: number;
  gaps: {
    keyword: string;
    volume: number | null;
    difficulty: { metric: "dataforseo_kd" | "ahrefs_kd" | "semrush_kd"; value: number | null };
    competitors: { domain: string; position: number | null; url: string | null }[];
    clientPosition: number | null;
    clientCheck: "provider" | "gsc";
  }[];
  perCompetitor: { domain: string; returned: number }[];
  notes?: string[];
}

/** Phase 12 C1: the newest saved local crawl, summarised (site_crawl section). */
export interface SiteCrawlData {
  crawlId: string;
  ranAt: string;
  exhaustive: boolean;
  /** Pages fetched. */
  pages: number;
  summary: {
    brokenLinks: number;
    redirects: number;
    missingTitles: number;
    duplicateTitles: number;
    missingDescriptions: number;
    duplicateDescriptions: number;
    canonicalIssues: number;
    noindex: number;
    orphans: { available: true; count: number } | { available: false; reason: string };
  };
  limit: number;
  findingCount: number;
  issues: { severity: "critical" | "high" | "medium" | "low"; rule: string; title: string; url: string }[];
}

/** Phase 12 C3: Bing Webmaster Tools for the report period (bing_overview section). Text fields are stripControl'd. */
export interface BingOverviewData {
  site: string;
  window: DateRange;
  comparedWith: { which: Comparison; range: DateRange } | null;
  totals: { clicks: number; impressions: number; ctr: number; change: { clicks: number | null; impressions: number | null; ctr: number | null } };
  previous: { clicks: number; impressions: number; ctr: number } | null;
  topQueries: { query: string; clicks: number; impressions: number; avgPosition: number | null }[];
  topPages: { page: string; clicks: number; impressions: number; avgPosition: number | null }[];
  crawl: { latest: { date: string; crawledPages: number; crawlErrors: number; inIndex: number } | null; issueCount: number };
  limit: number;
  notes: string[];
}

/** Phase 12 C4: the client's confirmed Google Business Profile and its map-pack positions (local_profile section, paid). Text is stripControl'd. */
export interface LocalProfileData {
  business: {
    title: string | null;
    category: string | null;
    address: string | null;
    url: string | null;
    rating: number | null;
    votes: number | null;
    ratingDistribution: { "1": number; "2": number; "3": number; "4": number; "5": number } | null;
    isClaimed: boolean | null;
    totalPhotos: number | null;
    currentStatus: string | null;
  };
  /** The area searched (a DataForSEO location name), or the location code when no area is set. */
  location: string;
  /** Map-pack position per keyword (null: not within the results read), and the business in first place. */
  pack: { keyword: string; clientRank: number | null; leader: { title: string | null; rating: number | null; votes: number | null } | null; failed?: boolean }[];
  notes: string[];
}

/** Phase 12 C5: AI-search visibility (ai_visibility section, paid, opt-in). Questions and URLs are stripControl'd. */
export interface AiVisibilityData {
  mode: "mentions" | "metrics";
  platform: string;
  domain: string;
  /** mentions: answers citing the domain, by AI search volume. */
  mentions?: { total: number | null; items: { question: string | null; aiSearchVolume: number | null; citedUrl: string | null; position: number | null }[] };
  /** metrics: aggregate mention counts. */
  metrics?: { total: { mentions: number | null; aiSearchVolume: number | null }; platform: { key: string; mentions: number | null; aiSearchVolume: number | null }[]; sourcesDomain: { key: string; mentions: number | null; aiSearchVolume: number | null }[] };
}

export interface TextData {
  text: string;
}

interface SectionBase {
  id: string;
  type: string;
  title: string;
}

export type SectionResult =
  | (SectionBase & { status: "ok"; data: unknown })
  | (SectionBase & { status: "error"; error: string })
  | (SectionBase & { status: "unavailable"; reason: string })
  | (SectionBase & { status: "skipped"; reason: string });

export interface Highlight {
  kind: string;
  sectionId: string;
  text: string;
  value?: number;
}

export interface TemplateReport {
  reportId: string;
  client: { slug: string; name: string; domain: string };
  template: { id: string; title: string; source: TemplateSource; layout?: "onepage" };
  period: { current: DateRange; label: string; folderMonth: string; comparisons: { previous_period?: DateRange; previous_year?: DateRange } };
  generatedAt: string;
  sections: SectionResult[];
  highlights: Highlight[];
  notes: string[];
  spend: { usd: number; units: { ahrefs: number; semrush: number } };
  /** Operator-only problems (for example an invalid template file that was ignored). Never rendered into report files. */
  warnings?: string[];
}

/** llms.txt and AI crawler access from the newest saved audit's site hygiene (ai_readiness section). Text fields are stripControl'd. */
export interface AiReadinessData {
  auditId: string;
  ranAt: string;
  llmsTxt:
    | { checked: false }
    | {
        checked: true;
        url: string;
        present: boolean;
        status: number;
        contentType: string | null;
        bytes: number;
        /** The H1, stripped of control characters; render as escaped text, never as Markdown. */
        title: string | null;
        hasSummary: boolean;
        sections: number;
        links: number;
        hasOptionalSection: boolean;
        /** crawlmark's own fixed text, one per format problem. */
        issues: string[];
        linksChecked: number;
        brokenLinks: { url: string; status: number }[];
        full: { present: boolean; status: number; bytes: number } | null;
      };
  crawlers:
    | { checked: false }
    | {
        checked: true;
        robotsFound: boolean;
        /** Key pages other than the homepage. */
        keyPages: number;
        rows: { bot: string; vendor: string; purpose: "search" | "user" | "training"; honorsRobots: boolean; group: "named" | "*" | "none"; access: "allowed" | "partial" | "blocked"; homepage: "allowed" | "blocked"; blockedKeyPages: number }[];
      };
}

// ---------------------------------------------------------------- Phase 13 A (spec 13.6.2)

export type IssueSeverity = "critical" | "high" | "medium" | "low";

/** Where a technical issue was found. The Ahrefs and Semrush Site Audit sources arrive in Stage B. */
export type IssueSource = "audit" | "local_crawl" | "site_hygiene" | "dataforseo_crawl" | "gsc_inspection" | "ahrefs_site_audit" | "semrush_site_audit";

/** One source run a technical-issues snapshot read (D10). */
export interface SourceRun {
  source: IssueSource;
  /** Audit ID, local crawl ID, DataForSEO task ID, inspection batch day, … */
  runId: string;
  ranAt: string;
  /** Older than the section's maxAgeDays: still shown, with its date and a note. */
  stale: boolean;
  /** Audit: the finding sources that ran (lighthouse, axe, indexing, …). Local crawl: `site:crawl-complete` when it was exhaustive. */
  checks?: string[];
}

export interface TechIssueSource {
  source: IssueSource;
  rule: string;
  /** The source's own severity label (crawlmark severity, DataForSEO check severity, Ahrefs importance, …). */
  nativeSeverity: string;
  /** Pages the source reports (count-only sources), or null for a URL-level finding. */
  count: number | null;
  /** Up to 3 example URLs. */
  examples: string[];
}

export interface TechIssue {
  /** Canonical key (tech-issues catalogue) or "<source>:<rule>" when unmapped. */
  key: string;
  title: string;
  category: string;
  /** Merged severity (D9). */
  severity: IssueSeverity;
  /** Null for count-only items. */
  url: string | null;
  /** Pages affected: the largest count any one source reports (D8). */
  affected: number;
  sources: TechIssueSource[];
  change: "new" | "persistent" | "resolved" | "unverified" | "first_run";
}

export interface TechnicalIssuesData {
  sources: SourceRun[];
  unavailable: { source: IssueSource; reason: string }[];
  /** Open items only. */
  counts: Record<IssueSeverity, number>;
  /** Null on the first run (nothing to compare with). */
  changes: { new: number; resolved: number; persistent: number; unverified: number } | null;
  base: { snapshotId: string; capturedAt: string } | null;
  /** Open, sorted severity → affected desc → key; at most `limit`. */
  issues: TechIssue[];
  /** At most 10. */
  resolved: TechIssue[];
  limit: number;
  /** Open items in all (before `limit`). */
  total: number;
  /** Earlier not re-checked issues dropped because no source that reported them is read any more (or its data is too old). */
  noLongerChecked?: number;
}

export interface IndexingIssuesData {
  /** The Search Console property (operator detail; the files say "Google URL Inspection"). */
  property: string;
  sample: { inspected: number; inspectedThisRun: number; keyPages: number; sitemapUrls: number; sitemapUrlsKnown: number; oldestDays: number | null };
  /** PASS among the latest inspection per URL. */
  indexed: { count: number; share: number | null };
  /** Coverage states (stripControl'd), most common first. */
  byCoverage: { state: string; count: number; severity: IssueSeverity | null }[];
  worst: { url: string; coverage: string; severity: IssueSeverity; inSitemap: boolean; keyPage: boolean; lastCrawl: string | null; googleCanonical: string | null; inspectedAt: string }[];
  /** Google canonical differs from the page's own (among the latest inspections). */
  canonicalMismatches: number;
  sitemaps: { path: string; errors: number; warnings: number; submitted: number | null; lastDownloaded: string | null; isPending: boolean }[];
  trend: { month: string; inspected: number; indexedShare: number | null }[];
  /** Operator-only (tool result; never rendered). */
  quota: { day: string; used: number; budget: number; exhausted: boolean };
  notes: string[];
}
