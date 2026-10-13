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

export interface SearchOverviewData {
  metrics: ("clicks" | "impressions" | "ctr" | "position")[];
  current: PeriodTotals;
  vsPreviousPeriod: ComparedTotals | null;
  vsPreviousYear: ComparedTotals | null;
  /** Why a comparison is null because its fetch failed (tool result only; the files show fixed text). */
  comparisonErrors?: Partial<Record<Comparison, string>>;
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
  template: { id: string; title: string; source: TemplateSource };
  period: { current: DateRange; label: string; folderMonth: string; comparisons: { previous_period?: DateRange; previous_year?: DateRange } };
  generatedAt: string;
  sections: SectionResult[];
  highlights: Highlight[];
  notes: string[];
  spend: { usd: number; units: { ahrefs: number; semrush: number } };
  /** Operator-only problems (for example an invalid template file that was ignored). Never rendered into report files. */
  warnings?: string[];
}
