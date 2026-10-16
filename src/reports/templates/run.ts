/**
 * runTemplate (12.A.2 tool 4): resolve a template and its period, fetch each
 * section's data on its own (one failing source never sinks the report), and
 * store the result for 24 hours under a reportId so export_report renders the
 * exact numbers the commentary was written from (D9). Sources are injected
 * (RunDeps) so tests never touch Google; the defaults load the real providers.
 */
import type { Client } from "../../config.js";
import { markBranded } from "../../analysis/branded.js";
import { isBranded } from "../../lib/brand.js";
import { cacheKey, peekCache, putCache, TTL } from "../../lib/cache.js";
import { fillDays, type DateRange } from "../../lib/dates.js";
import { GoogleNotConfiguredError } from "../../lib/google-auth.js";
import { ProviderUnavailableError } from "../../lib/provider-ids.js";
import { BudgetExceededError } from "../../lib/budget.js";
import { spendKeys } from "../../lib/spend.js";
import { stripControl } from "../../lib/terminal-text.js";
import type { StoredAudit } from "../../analysis/diff.js";
import type { GscQueryOptions, GscRow } from "../../providers/gsc.js";
import { computeHighlights } from "../highlights.js";
import { brandedSplitFor, compare, liveRanksAvailability, movers, organicTrafficCompare, QUERY_ROW_LIMIT, trackedKeywordRows, type Ga4Summary, type PeriodTotals } from "../monthly.js";
import { aiReadinessFrom } from "../ai-readiness.js";
import type { SiteHygiene } from "../../analysis/hygiene.js";
import type {
  AiReadinessData,
  AiVisibilityData,
  AuditChangesData,
  BingOverviewData,
  BrandedSplitData,
  Comparison,
  DailySearchPoint,
  CruxHistoryResult,
  DataSpendData,
  KeywordGapData,
  LocalProfileData,
  RankTrendData,
  SiteCrawlData,
  LandingPagesData,
  MoversData,
  OpportunityLists,
  OrganicTrafficData,
  SearchOverviewData,
  SectionResult,
  TagManagerData,
  TechnicalIssuesData,
  IndexingIssuesData,
  TemplateReport,
  TopRowsData,
  TrackedKeywordsData,
} from "../report-types.js";
import { loadTemplates, resolveTemplate, templateFileWarnings, type LoadedTemplates, type ResolvedTemplate } from "./load.js";
import { resolvePeriod, type ResolvedPeriod, type RunPeriodOverride } from "./period.js";
import { isPaidSection, PAID_ISSUE_SOURCES, REMOVED_ISSUE_SOURCE, REMOVED_ISSUE_SOURCE_NOTE, SECTION_TITLES, type SectionSpec } from "./schema.js";
import type { IssueSource } from "../report-types.js";
import type { RankHistoryOptions, RankHistoryResult } from "../../ranks.js";
import type { EstimateResult, KeywordGapRequest, KeywordGapRouted } from "../../providers/seo-data.js";
import { analyzeCrawl, topFindings } from "../../analysis/crawl.js";
import type { TechIssuesOptions, TechIssuesResult } from "../technical-issues.js";
import type { StoredCrawl } from "../../lib/crawls.js";
import type { ProviderEstimate, SectionRequest, SectionWindow } from "../provider-sections.js";
import type { BacklinksData, CompetitorOverviewData, VisibilityData } from "../report-types.js";
import { wholeQuarter } from "./period.js";

/** At most this many stored points per keyword and source go into a report (evenly thinned). */
export const RANK_SERIES_MAX = 120;

/** Keep at most `max` points, evenly spaced, always including the first and the last. */
export function thin<T>(points: T[], max: number): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => points[Math.round(i * step)]!);
}

/** Words that mark a search as local ("near me", "open now"), plus the client's town and region from its area. */
const LOCAL_WORDS = /\b(near me|nearby|near by|close to me|closest|open now|open today|open late|24 ?hours?|24\/7|in my area|local)\b/i;
export function isLocalIntent(query: string, area: string | undefined): boolean {
  const q = query.toLowerCase();
  if (LOCAL_WORDS.test(q)) return true;
  // A DataForSEO location name is "Town,Region,Country": the country is too broad to mean local, so it's dropped.
  const parts = (area ?? "").split(",").map((p) => p.trim().toLowerCase());
  const places = (parts.length > 1 ? parts.slice(0, -1) : parts).filter((p) => p.length >= 3);
  return places.some((p) => new RegExp(`(^|[^\\p{L}])${p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(q));
}

/** Rough ceiling per live SERP check (DataForSEO's own estimate for a SERP task). */
export const LIVE_RANK_ESTIMATE_USD = 0.002;

export interface RunDeps {
  googleConfigured(): boolean;
  gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]>;
  gscTotals(client: Client, range: DateRange): Promise<PeriodTotals>;
  ga4OrganicSummary(client: Client, range: DateRange): Promise<Ga4Summary>;
  ga4TopLandingPages(client: Client, range: DateRange, limit: number): Promise<Record<string, string | number>[]>;
  /** Organic sessions per day, for the report files' trend chart (optional: without it the chart is left out). */
  ga4OrganicDaily?(client: Client, range: DateRange): Promise<{ date: string; sessions: number }[]>;
  opportunitiesForMonth(client: Client, range: DateRange, n: number): Promise<OpportunityLists>;
  latestAudit(client: string): StoredAudit | undefined;
  latestAuditBefore(client: string, beforeMs: number): StoredAudit | undefined;
  monthlyAuditSection(latest: StoredAudit | undefined, before: StoredAudit | undefined): AuditChangesData["comparison"];
  spentThisMonth(keys: string[]): number;
  unitsThisMonth(keys: string[], provider: "ahrefs" | "semrush"): number;
  assertBudget(client: Client, estimateUsd: number): void;
  /** Check and reserve the run's whole paid USD estimate while the sections run (SEC-1); `aiUsd` is its AI-visibility share (C5). */
  withUsdReservation<T>(client: Client, usd: number, fn: () => Promise<T>, opts?: { aiUsd?: number }): Promise<T>;
  serp(client: Client, keyword: string): Promise<{ clientRank: number | null; clientUrl: string | null }>;
  runGtmAudit(client: Client): Promise<Omit<TagManagerData, "limit">>;
  cruxHistory(client: Client, opts: { formFactor: "PHONE" | "DESKTOP" | "TABLET" | "ALL"; weeks: number; url?: string | undefined }): Promise<CruxHistoryResult>;
  /** Phase 12 B: stored rank history (local, free). */
  rankHistory(client: Client, opts: RankHistoryOptions): RankHistoryResult;
  /** Phase 12 B: the routed keyword gap (paid); estimateOnly makes no request. */
  keywordGap(client: Client, req: KeywordGapRequest, opts: { estimateOnly?: boolean }): Promise<KeywordGapRouted | EstimateResult>;
  /** The competitors a gap section compares (passed ones normalised, else the client's first 3 saved); throws when there are none. */
  gapCompetitors(client: Client, passed: readonly string[] | undefined): string[];
  /** Phase 12 C1: the client's newest saved local crawl (local, free). */
  latestLocalCrawl(client: string): StoredCrawl | undefined;
  /** Phase 12 C3: Bing Webmaster Tools for a period (free, read-only; BingUnavailableError without a key, BingSiteError without a verified site). */
  bingOverview(client: Client, req: { window: DateRange; compare?: { which: Comparison; range: DateRange } | undefined; limit: number }): Promise<BingOverviewData>;
  /** Phase 12 C4: the confirmed Google Business Profile and map-pack positions (paid; LocalNotConfirmedError without a saved place ID). */
  localProfile(client: Client, opts: { packKeywords: number }): Promise<LocalProfileData>;
  /** Phase 12 C4: that section's whole USD estimate (0 when it can't run); no request. */
  localProfileEstimateUsd(client: Client, opts: { packKeywords: number }): number;
  /** Phase 12 C5: whether AI_VISIBILITY_ENABLED=true (else the ai_visibility section is unavailable, with no request). */
  aiVisibilityEnabled(): boolean;
  /** Phase 12 C5: the ai_visibility section's estimate against its sub-cap and the client and global caps; no request. */
  aiVisibilityEstimate(client: Client, req: AiSectionRequest): { usd: number; wouldExceed: boolean; message: string };
  /** Phase 12 C5: what's left of AI_VISIBILITY_MONTHLY_BUDGET_USD this month (reservations in progress included). */
  remainingAiUsd(): number;
  /** Phase 12 C5: AI-search visibility (paid). */
  aiVisibility(client: Client, req: AiSectionRequest): Promise<AiVisibilityData>;
  /** Phase 13 (D16): check and reserve the run's whole Ahrefs or Semrush unit estimate while the sections run. */
  withUnitsReservation<T>(client: Client, provider: "ahrefs" | "semrush", units: number, fn: () => Promise<T>): Promise<T>;
  /** Phase 13 (D17): USD left this month for the client and for everyone (reservations in progress included). */
  remainingUsd(client: Client): { clientUsd: number; globalUsd: number };
  /** Phase 13 (D17): Ahrefs or Semrush units left this month for the client and for everyone. */
  remainingUnits(client: Client, provider: "ahrefs" | "semrush"): { client: number; global: number };
  /** Phase 13 A: the deduplicated technical-issues list from stored sources (saves an issue snapshot). */
  technicalIssues(client: Client, opts: TechIssuesOptions): Promise<TechIssuesResult>;
  /** Phase 13 A: Google indexing from stored URL Inspection results, topping up at most maxInspections first (free; Google's daily quota). */
  indexingSection(client: Client, opts: { maxInspections: number; staleDays: number; limit: number; trendMonths: number }): Promise<IndexingIssuesData>;
  /**
   * Phase 13 B: plan a provider section (backlinks, organic_visibility, competitor_overview) with no request: its
   * estimate (stored snapshots and the cache honoured, provider history included when it would be bought) and a
   * `run` that makes exactly those requests and builds the section. Throws ProviderUnavailableError when the
   * client's provider can't serve it (never another provider).
   */
  planProviderSection(client: Client, req: SectionRequest, window: SectionWindow): Promise<PlannedProviderSection>;
  /** Phase 13 B: the technical_issues section's paid sources (the Ahrefs Site Audit) priced, no request. */
  planIssueSources(client: Client, sources: readonly string[], issueUrls: number): Promise<{ source: string; provider: "ahrefs"; units: number; requests: number; breakdown: string }[]>;
}

export interface PlannedProviderSection {
  estimate: ProviderEstimate;
  run(): Promise<BacklinksData | VisibilityData | CompetitorOverviewData>;
}

const PROVIDER_SECTION_TYPES: ReadonlySet<string> = new Set(["backlinks", "organic_visibility", "competitor_overview"]);

/** The provider sections' window (D3): the period's last day, tolerance 20 days for a quarter and 10 otherwise, the comparisons' last days. */
export function providerWindow(period: { current: DateRange; comparisons: { previous_period?: DateRange | undefined; previous_year?: DateRange | undefined } }): SectionWindow {
  return {
    kind: "period",
    end: period.current.endDate,
    toleranceDays: wholeQuarter(period.current) ? 20 : 10,
    comparisons: { previous_period: period.comparisons.previous_period?.endDate, previous_year: period.comparisons.previous_year?.endDate },
    trendMonths: 12,
  };
}

const sectionRequest = (s: SectionSpec): SectionRequest | null =>
  s.type === "backlinks" || s.type === "organic_visibility"
    ? { type: s.type, trendMonths: s.trendMonths, history: s.history }
    : s.type === "competitor_overview"
      ? { type: s.type, limit: s.limit, source: s.source }
      : null;

export interface AiSectionRequest {
  mode: "mentions" | "metrics";
  platform: "google" | "chat_gpt";
  limit: number;
}

/** The real sources. Modules load on first use, so planning a run (or a dry run) never loads Google clients. */
export async function loadDefaultRunDeps(): Promise<RunDeps> {
  const [google, gsc, ga4, opp, audits, diff, budget, seoData, gtm, crux, ranks] = await Promise.all([
    import("../../providers/google.js"),
    import("../../providers/gsc.js"),
    import("../../providers/ga4.js"),
    import("../opportunities.js"),
    import("../../lib/audits.js"),
    import("../../analysis/diff.js"),
    import("../../lib/budget.js"),
    import("../../providers/seo-data.js"),
    import("../gtm.js"),
    import("../../providers/crux.js"),
    import("../../ranks.js"),
  ]);
  const crawls = await import("../../lib/crawls.js");
  const bing = await import("../../providers/bing.js");
  const local = await import("../../local-seo.js");
  const ai = await import("../../ai-visibility.js");
  const config = await import("../../config.js");
  const units = await import("../../providers/units-billing.js");
  return {
    googleConfigured: google.googleConfigured,
    gscQuery: gsc.gscQuery,
    gscTotals: gsc.gscTotals,
    ga4OrganicSummary: ga4.ga4OrganicSummary,
    ga4TopLandingPages: ga4.ga4TopLandingPages,
    ga4OrganicDaily: ga4.ga4OrganicDaily,
    opportunitiesForMonth: opp.opportunitiesForMonth,
    latestAudit: audits.latestAudit,
    latestAuditBefore: audits.latestAuditBefore,
    monthlyAuditSection: diff.monthlyAuditSection as RunDeps["monthlyAuditSection"],
    spentThisMonth: (keys) => budget.spentThisMonth(keys),
    unitsThisMonth: (keys, p) => budget.unitsThisMonth(keys, p),
    assertBudget: budget.assertBudget,
    withUsdReservation: budget.withUsdReservation,
    // Live ranks are also saved to rank history (tracked keywords only), as monthly_report does.
    serp: async (c, k) => {
      const r = await seoData.serp(c, k);
      ranks.recordLiveRank(c, k, r);
      return r;
    },
    runGtmAudit: gtm.runGtmAudit,
    cruxHistory: async (c, o) => crux.cruxHistory({ ...(o.url ? { url: o.url } : { origin: crux.clientOrigin(c) }), formFactor: o.formFactor, weeks: o.weeks }),
    rankHistory: ranks.rankHistory,
    keywordGap: (c, r, o) => seoData.keywordGap(c, r, o),
    gapCompetitors: seoData.gapCompetitors,
    latestLocalCrawl: (slug) => crawls.latestCrawl(slug),
    bingOverview: (c, req) => bing.bingOverview(c, req),
    localProfile: (c, o) => local.localProfileSection(c, o),
    localProfileEstimateUsd: (c, o) => local.localSectionEstimateUsd(c, o),
    aiVisibilityEnabled: () => config.env.AI_VISIBILITY_ON,
    aiVisibilityEstimate: (c, r) => {
      const e = ai.aiVisibilityEstimate(c, r);
      return { usd: e.estimate.usd, wouldExceed: e.wouldExceed, message: e.message };
    },
    aiVisibility: (c, r) => ai.aiVisibilitySection(c, r),
    remainingAiUsd: () => budget.remainingAiUsd().remainingUsd,
    withUnitsReservation: (c, p, u, fn) => units.withUnitsReservation(c, p, u, fn),
    remainingUsd: (c) => budget.remainingUsd(c),
    remainingUnits: (c, p) => units.remainingUnits(c, p),
    technicalIssues: async (c, o) => {
      const ti = await import("../technical-issues.js");
      return ti.technicalIssues(c, o, await ti.loadTechIssuesDeps());
    },
    indexingSection: async (c, o) => {
      const ix = await import("../indexing.js");
      return ix.indexingSection(c, o, await ix.loadIndexingDeps());
    },
    planIssueSources: async (c, sources, n) => (await import("../technical-issues.js")).planPaidIssueSources(c, sources as never, n),
    planProviderSection: async (c, req, window) => {
      const ps = await import("../provider-sections.js");
      const deps = await ps.loadProviderSectionDeps();
      const planned = await ps.planSection(c, req, window, deps);
      return { estimate: ps.estimateOf(planned), run: () => ps.runSection(planned, deps) };
    },
  };
}

type PaidProvider = "dataforseo" | "ahrefs" | "semrush";

/** One paid section's estimate (D17). No request is made to produce it. */
export interface SectionEstimate {
  id: string;
  type: string;
  /** Null when the section can't spend anything in this run (see `note`). */
  provider: PaidProvider | null;
  usd: number;
  units: number;
  requests: number;
  /** Served from the cache (or a stored snapshot), so it costs nothing. */
  reused: boolean;
  note?: string;
  /** Set when this section alone would go over a cap: the provider's own message. */
  exceeded?: string;
}

/** run_report_template / export_report with estimateOnly (D17): the run's paid part, priced, with no provider request. */
export interface RunEstimate {
  estimateOnly: true;
  template: string;
  period: { label: string; current: DateRange };
  sections: SectionEstimate[];
  total: { usd: number; units: { ahrefs: number; semrush: number } };
  remaining: { usd: { client: number; global: number }; units: { ahrefs: { client: number; global: number }; semrush: { client: number; global: number } }; aiUsd?: number };
  wouldExceed: boolean;
  message: string;
}

const r4 = (n: number) => Number(n.toFixed(4));

/**
 * Price every paid section of a planned run (D17), with no provider request: live ranks per tracked keyword,
 * keyword gap and AI visibility through their own estimate functions (caches honoured), local profile from its
 * plan. Sections that couldn't run (no competitors, AI visibility off) are listed with 0 and a note.
 */
export async function estimatePaidSections(
  client: Client,
  sections: SectionSpec[],
  deps: RunDeps,
  ctx: { window?: SectionWindow; plans?: Map<string, PlannedProviderSection> } = {},
): Promise<SectionEstimate[]> {
  const out: SectionEstimate[] = [];
  for (const s of sections) {
    const base = { id: s.id, type: s.type };
    const req = sectionRequest(s);
    if (req && ctx.window) {
      try {
        const planned = await deps.planProviderSection(client, req, ctx.window);
        ctx.plans?.set(s.id, planned);
        const e = planned.estimate;
        out.push({ ...base, provider: e.provider, usd: r4(e.usd), units: e.units, requests: e.requests, reused: e.reused, ...(e.parts.length ? { note: e.parts.join(" + ") } : {}) });
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        out.push({ ...base, provider: null, usd: 0, units: 0, requests: 0, reused: false, note: errorText(err) });
      }
      continue;
    }
    if (s.type === "tracked_keywords" && s.liveRanks === true) {
      const n = client.trackedKeywords.length;
      out.push({ ...base, provider: "dataforseo", usd: r4(n * LIVE_RANK_ESTIMATE_USD), units: 0, requests: n, reused: false, ...(n ? {} : { note: `no tracked keywords for ${client.domain}` }) });
    } else if (s.type === "keyword_gap") {
      let competitors: string[];
      try {
        competitors = deps.gapCompetitors(client, s.competitors);
      } catch (err) {
        out.push({ ...base, provider: null, usd: 0, units: 0, requests: 0, reused: false, note: errorText(err) });
        continue;
      }
      let e: KeywordGapRouted | EstimateResult;
      try {
        e = await deps.keywordGap(client, { competitors, limit: s.limit ?? 50, minVolume: 0 }, { estimateOnly: true });
      } catch (err) {
        if (err instanceof BudgetExceededError) throw err;
        out.push({ ...base, provider: null, usd: 0, units: 0, requests: 0, reused: false, note: errorText(err) });
        continue;
      }
      if (!("estimateOnly" in e)) continue;
      out.push({ ...base, provider: e.provider, usd: r4(e.estimate.usd), units: e.estimate.units ?? 0, requests: e.estimate.requests, reused: e.estimate.cached, ...(e.wouldExceed ? { exceeded: e.message } : {}) });
    } else if (s.type === "local_profile") {
      const usd = deps.localProfileEstimateUsd(client, { packKeywords: s.packKeywords ?? 3 });
      const pack = Math.min(s.packKeywords ?? 3, client.trackedKeywords.length);
      out.push({ ...base, provider: usd > 0 ? "dataforseo" : null, usd: r4(usd), units: 0, requests: usd > 0 ? 1 + pack : 0, reused: false, ...(usd > 0 ? {} : { note: "nothing to fetch (no confirmed Google Business Profile, no DataForSEO, or already cached)" }) });
    } else if (s.type === "ai_visibility") {
      if (!deps.aiVisibilityEnabled()) {
        out.push({ ...base, provider: null, usd: 0, units: 0, requests: 0, reused: false, note: "AI-search visibility is off (AI_VISIBILITY_ENABLED), so the section is left out" });
        continue;
      }
      try {
        const e = deps.aiVisibilityEstimate(client, aiReq(s));
        out.push({ ...base, provider: "dataforseo", usd: r4(e.usd), units: 0, requests: e.usd > 0 ? 1 : 0, reused: e.usd === 0, ...(e.wouldExceed ? { exceeded: e.message } : {}) });
      } catch (err) {
        // The estimate threw before any request (no DataForSEO, or chat_gpt for a non-US client); the section reports it when it runs.
        out.push({ ...base, provider: null, usd: 0, units: 0, requests: 0, reused: false, note: errorText(err) });
      }
    } else if (s.type === "technical_issues" && isPaidSection(s)) {
      // One estimate per paid source (Ahrefs and Semrush units are capped separately).
      for (const p of await deps.planIssueSources(client, s.sources ?? [], s.issueUrls ?? 0)) {
        out.push({ ...base, provider: p.provider, usd: 0, units: p.units, requests: p.requests, reused: p.units === 0, note: p.breakdown });
      }
    }
  }
  return out;
}

/** Plan a run and price its paid sections (D17). Reads only the template files, caches and the spend ledger. */
export async function estimateTemplate(client: Client, opts: RunOptions, deps: RunDeps): Promise<RunEstimate> {
  const plan = planRun(client, opts);
  const paid = plan.sections.filter((s) => isPaidSection(s) || s.paid === true);
  const sections = await estimatePaidSections(client, paid, deps, { window: providerWindow(plan.period) });
  const usd = r4(sections.filter((x) => x.provider === "dataforseo").reduce((a, x) => a + x.usd, 0));
  const unitsOf = (p: "ahrefs" | "semrush") => sections.filter((x) => x.provider === p).reduce((a, x) => a + x.units, 0);
  const total = { usd, units: { ahrefs: unitsOf("ahrefs"), semrush: unitsOf("semrush") } };
  const ru = deps.remainingUsd(client);
  const ra = deps.remainingUnits(client, "ahrefs");
  const rs = deps.remainingUnits(client, "semrush");
  const aiUsd = r4(sections.filter((x) => x.type === "ai_visibility").reduce((a, x) => a + x.usd, 0));
  const aiLeft = aiUsd > 0 ? deps.remainingAiUsd() : undefined;
  const problems: string[] = sections.flatMap((x) => (x.exceeded ? [`${x.id}: ${x.exceeded}`] : []));
  const usdLeft = Math.min(ru.clientUsd, ru.globalUsd);
  if (usd > usdLeft) problems.push(`DataForSEO: the paid sections need $${usd.toFixed(4)} but ${ru.clientUsd <= ru.globalUsd ? client.domain : "the global cap"} has $${usdLeft.toFixed(4)} left this month. Raise monthlyBudgetUsd for this client (or DEFAULT_CLIENT_MONTHLY_BUDGET_USD), or leave a paid section out.`);
  for (const [p, r, label] of [["ahrefs", ra, "Ahrefs"], ["semrush", rs, "Semrush"]] as const) {
    const need = total.units[p];
    const left = Math.min(r.client, r.global);
    if (need > left) problems.push(`${label}: the paid sections need ${need.toLocaleString("en-US")} units but ${r.client <= r.global ? client.domain : "the global cap"} has ${left.toLocaleString("en-US")} left this month. Raise monthlyUnits.${p} in clients.yaml (or DEFAULT_CLIENT_MONTHLY_${p.toUpperCase()}_UNITS), or leave a paid section out.`);
  }
  if (aiLeft !== undefined && aiUsd > aiLeft) problems.push(`AI visibility: the ai_visibility sections need about $${aiUsd.toFixed(4)} but AI_VISIBILITY_MONTHLY_BUDGET_USD has $${aiLeft.toFixed(4)} left this month.`);
  const parts = [
    usd > 0 ? `DataForSEO $${usd.toFixed(4)}` : "",
    total.units.ahrefs > 0 ? `Ahrefs ${total.units.ahrefs.toLocaleString("en-US")} units` : "",
    total.units.semrush > 0 ? `Semrush ${total.units.semrush.toLocaleString("en-US")} units` : "",
  ].filter(Boolean);
  const message = !paid.length
    ? `Template "${plan.template.id}" has no paid sections in this run: it costs nothing.`
    : problems.length
      ? `Over a cap: ${problems.join(" ")}`
      : parts.length
        ? `${paid.length} paid section${paid.length === 1 ? "" : "s"}: ${parts.join(" + ")} (estimates; actual costs are recorded). ${client.domain} has $${ru.clientUsd.toFixed(4)} of DataForSEO budget left this month${total.units.ahrefs ? `, ${ra.client.toLocaleString("en-US")} Ahrefs units` : ""}${total.units.semrush ? `, ${rs.client.toLocaleString("en-US")} Semrush units` : ""}. Run with allowPaid: true (tool) or --paid (CLI) to spend it.`
        : `${paid.length} paid section${paid.length === 1 ? "" : "s"}, but nothing to buy this run (cached, or the sections can't run; see each section's note).`;
  return {
    estimateOnly: true,
    template: plan.template.id,
    period: { label: plan.period.label, current: plan.period.current },
    sections,
    total,
    remaining: { usd: { client: ru.clientUsd, global: ru.globalUsd }, units: { ahrefs: ra, semrush: rs }, ...(aiLeft !== undefined ? { aiUsd: aiLeft } : {}) },
    wouldExceed: problems.length > 0,
    message,
  };
}

export interface RunOptions extends RunPeriodOverride {
  template?: string | undefined;
  include?: string[] | undefined;
  allowPaid?: boolean | undefined;
  homeDir: string;
  today?: Date;
  /** Keep the report for export_report (default true). */
  store?: boolean;
}

/** A section's data is unavailable (no property, no key), not failed. */
export class SectionUnavailableError extends Error {
  override name = "SectionUnavailableError";
}

const GSC_TYPES = new Set(["search_overview", "branded_split", "top_queries", "query_movers", "top_pages", "page_movers", "tracked_keywords", "opportunities", "indexing_issues"]);
const GA4_TYPES = new Set(["organic_traffic", "landing_pages"]);

export interface RunPlan {
  loaded: LoadedTemplates;
  template: ResolvedTemplate;
  period: ResolvedPeriod;
  /** Sections that will run, in template order. */
  sections: SectionSpec[];
  paidSections: string[];
}

/** Everything a run decides before fetching: template, period, sections. Throws on a bad template id, include or period. */
export function planRun(client: Pick<Client, "slug">, opts: RunOptions): RunPlan {
  const loaded = loadTemplates({ homeDir: opts.homeDir, clientSlug: client.slug, ...(opts.today ? { today: opts.today } : {}) });
  const template = resolveTemplate(loaded, opts.template);
  const include = opts.include ?? [];
  const optionalIds = template.spec.sections.filter((s) => s.optional).map((s) => s.id);
  for (const id of include) {
    if (!template.spec.sections.some((s) => s.id === id)) throw new Error(`include: template "${template.id}" has no section "${id}". Optional sections: ${optionalIds.join(", ") || "(none)"}.`);
    if (!optionalIds.includes(id)) throw new Error(`include: section "${id}" isn't optional (it is always included). Optional sections: ${optionalIds.join(", ") || "(none)"}.`);
  }
  const period = resolvePeriod(template.spec.period, template.spec.compare, opts, opts.today ?? new Date());
  const sections = template.spec.sections.filter((s) => !s.optional || include.includes(s.id));
  return { loaded, template, period, sections, paidSections: sections.filter((s) => isPaidSection(s) || s.paid === true).map((s) => s.id) };
}

export { ulid } from "../../lib/ulid.js";
import { ulid } from "../../lib/ulid.js";
import { trackCacheKey } from "../../lib/provider-data.js";

const storeKey = (reportId: string) => cacheKey("report-run", reportId);

export function storeReport(report: TemplateReport): void {
  putCache(storeKey(report.reportId), TTL.day, report);
  // A run can carry Ahrefs-derived figures for a day; the Ahrefs and client purges delete it too (storage rule).
  if (report.spend.units.ahrefs > 0 || JSON.stringify([report.sections, report.highlights, report.notes]).toLowerCase().includes("ahrefs")) trackCacheKey("ahrefs", report.client.slug, storeKey(report.reportId));
}

/** A stored report, or an error telling the caller to run the template again. */
export function getStoredReport(reportId: string): TemplateReport {
  if (!/^rpt_[0-9A-Z]{26}$/.test(reportId)) throw new Error(`"${reportId}" isn't a report ID (they look like rpt_01J...). Run run_report_template again.`);
  const r = peekCache<TemplateReport>(storeKey(reportId));
  if (!r) throw new Error(`Report ${reportId} has expired or doesn't exist (reports are kept for 24 hours). Run run_report_template again.`);
  return r;
}

function primary(period: ResolvedPeriod): { which: Comparison; range: DateRange } | undefined {
  if (period.comparisons.previous_period) return { which: "previous_period", range: period.comparisons.previous_period };
  if (period.comparisons.previous_year) return { which: "previous_year", range: period.comparisons.previous_year };
  return undefined;
}

const aiReq = (s: Extract<SectionSpec, { type: "ai_visibility" }>): AiSectionRequest => ({ mode: s.mode ?? "mentions", platform: s.platform ?? "google", limit: s.limit ?? 10 });

const errorText = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err)).slice(0, 1000);

/** Run a template for one client. */
export async function runTemplate(client: Client, opts: RunOptions, deps: RunDeps): Promise<TemplateReport> {
  const plan = planRun(client, opts);
  const { template, period } = plan;
  const allowPaid = opts.allowPaid === true;
  const keys = spendKeys(client);

  // Pre-flight for the whole paid part, before any paid request: every paid section priced (no request), each
  // section's own cap check, then the run's totals per provider against what's left (D16).
  // Phase 13 B: the provider sections' plans made for the pre-flight are the ones that run (same requests).
  const providerPlans = new Map<string, PlannedProviderSection>();
  const window = providerWindow(plan.period);
  const estimates = allowPaid ? await estimatePaidSections(client, plan.sections, deps, { window, plans: providerPlans }) : [];
  for (const e of estimates) if (e.exceeded) throw new BudgetExceededError(e.exceeded);
  let paidUsd = estimates.filter((e) => e.provider === "dataforseo" && e.type !== "ai_visibility").reduce((a, e) => a + e.usd, 0);
  const runUnits = { ahrefs: 0, semrush: 0 };
  for (const e of estimates) if (e.provider === "ahrefs" || e.provider === "semrush") runUnits[e.provider] += e.units;
  for (const p of ["ahrefs", "semrush"] as const) {
    if (runUnits[p] <= 0) continue;
    const left = deps.remainingUnits(client, p);
    const min = Math.min(left.client, left.global);
    if (runUnits[p] > min) {
      throw new BudgetExceededError(`The paid sections together need ${runUnits[p].toLocaleString("en-US")} ${p} units but ${client.domain} has ${min.toLocaleString("en-US")} left this month. Lower their limits, or raise the cap.`);
    }
  }
  // AI visibility sections (Phase 12 C5): every AI section together against the AI sub-cap (R-1/SEC-4), before any paid request.
  const aiUsd = estimates.filter((e) => e.type === "ai_visibility").reduce((a, e) => a + e.usd, 0);
  if (aiUsd > 0) {
    const aiLeft = deps.remainingAiUsd();
    if (aiUsd > aiLeft) {
      throw new BudgetExceededError(
        `The ai_visibility sections together need about $${aiUsd.toFixed(4)} but the AI visibility cap (AI_VISIBILITY_MONTHLY_BUDGET_USD) has $${aiLeft.toFixed(4)} left this month. Remove a section, lower its limit, or raise the cap.`,
      );
    }
    paidUsd += aiUsd;
  }
  const reservedUsd = Number(paidUsd.toFixed(4));
  const spentBefore = { usd: deps.spentThisMonth(keys), ahrefs: deps.unitsThisMonth(keys, "ahrefs"), semrush: deps.unitsThisMonth(keys, "semrush") };

  // Issue snapshots this run saved (Phase 13): never the base of another technical_issues section in the same run.
  const issueSnapshotIds = new Set<string>();
  // Shared fetches: several sections read the same rows.
  const memo = new Map<string, Promise<unknown>>();
  const once = <T>(key: string, fn: () => Promise<T>): Promise<T> => {
    if (!memo.has(key)) memo.set(key, fn());
    return memo.get(key) as Promise<T>;
  };
  const queries = (r: DateRange) => once(`q:${r.startDate}:${r.endDate}`, () => deps.gscQuery(client, { ...r, dimensions: ["query"], rowLimit: QUERY_ROW_LIMIT }));
  const pages = (r: DateRange) => once(`p:${r.startDate}:${r.endDate}`, () => deps.gscQuery(client, { ...r, dimensions: ["page"], rowLimit: 200 }));
  const totals = (r: DateRange) => once(`t:${r.startDate}:${r.endDate}`, () => deps.gscTotals(client, r));
  const ga4 = (r: DateRange) => once(`g:${r.startDate}:${r.endDate}`, () => deps.ga4OrganicSummary(client, r));
  const cur = period.current;
  const prim = primary(period);
  const notes: string[] = [];
  const note = (n: string) => {
    if (!notes.includes(n)) notes.push(n);
  };

  // Daily series for the report files' charts (free). Extra data only: a failure leaves the chart out, never the section.
  // Search Console and GA4 leave out days with nothing: every day between the first and last reported day gets a
  // row (0 when missing), so the x-axis isn't compressed and a "week" is 7 days. Trailing days not reported yet
  // (Search Console lags 2-3 days) are left out, not shown as a drop to 0.
  const byDate = (rows: GscRow[], range: DateRange): DailySearchPoint[] => {
    const days = rows.filter((r) => /^\d{4}-\d{2}-\d{2}$/.test(r.keys[0] ?? "")).map((r) => ({ date: r.keys[0]!, clicks: r.clicks, impressions: r.impressions }));
    return days.length ? fillDays(range, days, (date) => ({ date, clicks: 0, impressions: 0 })) : [];
  };
  const daysOf = (r: DateRange) => once(`d:${r.startDate}:${r.endDate}`, () => deps.gscQuery(client, { ...r, dimensions: ["date"], rowLimit: 500 }));
  const searchDaily = async (): Promise<SearchOverviewData["daily"]> => {
    try {
      const current = byDate(await daysOf(cur), cur);
      if (current.length < 2) return undefined;
      const previous = prim ? byDate(await daysOf(prim.range).catch(() => []), prim.range) : [];
      return { current, previous: previous.length ? previous : null, comparedWith: previous.length && prim ? prim.which : null };
    } catch {
      return undefined;
    }
  };
  const sessionsDaily = async (): Promise<OrganicTrafficData["daily"]> => {
    if (!deps.ga4OrganicDaily) return undefined;
    try {
      const sessions = (rows: { date: string; sessions: number }[], range: DateRange) => (rows.length ? fillDays(range, rows, (date) => ({ date, sessions: 0 })) : []);
      const current = sessions(await deps.ga4OrganicDaily(client, cur), cur);
      if (current.length < 2) return undefined;
      const previous = prim ? sessions(await deps.ga4OrganicDaily(client, prim.range).catch(() => []), prim.range) : [];
      return { current, previous: previous.length ? previous : null, comparedWith: previous.length && prim ? prim.which : null };
    } catch {
      return undefined;
    }
  };

  const providerSection = async (s: SectionSpec) => {
    const planned = providerPlans.get(s.id) ?? (await deps.planProviderSection(client, sectionRequest(s)!, window));
    return planned.run();
  };

  const fetchers: Record<SectionSpec["type"], (s: never) => Promise<unknown>> = {
    search_overview: async (s: Extract<SectionSpec, { type: "search_overview" }>): Promise<SearchOverviewData> => {
      const c = await totals(cur);
      // The raw error stays in the tool result (comparisonErrors); the report's note is fixed text.
      const comparisonErrors: Partial<Record<Comparison, string>> = {};
      const vs = async (which: Comparison) => {
        const r = period.comparisons[which];
        if (!r) return null;
        try {
          return compare(c, await totals(r));
        } catch (err) {
          comparisonErrors[which] = errorText(err);
          note(`Search performance: the ${which === "previous_period" ? "previous period" : "previous year"} comparison couldn't be fetched.`);
          return null;
        }
      };
      const [vsPreviousPeriod, vsPreviousYear] = [await vs("previous_period"), await vs("previous_year")];
      const daily = await searchDaily();
      return {
        metrics: s.metrics ?? ["clicks", "impressions", "ctr", "position"],
        current: c,
        vsPreviousPeriod,
        vsPreviousYear,
        ...(Object.keys(comparisonErrors).length ? { comparisonErrors } : {}),
        ...(daily ? { daily } : {}),
      };
    },
    branded_split: async (): Promise<BrandedSplitData> => {
      const qc = await queries(cur);
      const qp = prim ? await queries(prim.range) : [];
      return { comparedWith: prim?.which ?? null, ...brandedSplitFor(client, qc, qp) };
    },
    organic_traffic: async (s: Extract<SectionSpec, { type: "organic_traffic" }>): Promise<OrganicTrafficData> => {
      const c = await ga4(cur);
      const p = prim ? await ga4(prim.range) : undefined;
      const metrics = s.metrics ?? ["sessions", "users", "engagementRate", "keyEvents"];
      const daily = await sessionsDaily();
      const extra = daily ? { daily } : {};
      if (!p) {
        return { metrics, comparedWith: null, previous: null, sessions: { value: c.sessions, change: null }, users: { value: c.users, change: null }, engagementRate: { value: c.engagementRate, change: null }, keyEvents: { value: c.keyEvents, change: null }, ...extra };
      }
      return { metrics, comparedWith: prim!.which, ...organicTrafficCompare(c, p), previous: { sessions: p.sessions, users: p.users, engagementRate: p.engagementRate, keyEvents: p.keyEvents }, ...extra };
    },
    top_queries: async (s: Extract<SectionSpec, { type: "top_queries" }>): Promise<TopRowsData> => {
      const rows = markBranded(await queries(cur), client);
      const kept = s.includeBranded === false ? rows.filter((r) => !r.branded) : rows;
      if (s.intent === "local") {
        const local = kept.filter((r) => isLocalIntent(r.keys[0] ?? "", client.area));
        return local.length ? { rows: local.slice(0, s.limit ?? 20), intent: "local" } : { rows: kept.slice(0, s.limit ?? 20), intent: "local", intentFallback: true };
      }
      return { rows: kept.slice(0, s.limit ?? 20) };
    },
    query_movers: async (s: Extract<SectionSpec, { type: "query_movers" }>): Promise<MoversData> => {
      if (!prim) throw new SectionUnavailableError("the template has no comparison period");
      const m = movers(await queries(cur), await queries(prim.range), s.limit ?? 10, (q) => isBranded(q, client));
      return { comparedWith: prim.which, ...m };
    },
    page_movers: async (s: Extract<SectionSpec, { type: "page_movers" }>): Promise<MoversData> => {
      if (!prim) throw new SectionUnavailableError("the template has no comparison period");
      return { comparedWith: prim.which, ...movers(await pages(cur), await pages(prim.range), s.limit ?? 10) };
    },
    top_pages: async (s: Extract<SectionSpec, { type: "top_pages" }>): Promise<TopRowsData> => ({ rows: (await pages(cur)).slice(0, s.limit ?? 15) }),
    landing_pages: async (s: Extract<SectionSpec, { type: "landing_pages" }>): Promise<LandingPagesData> => ({ rows: await deps.ga4TopLandingPages(client, cur, s.limit ?? 15) }),
    tracked_keywords: async (s: Extract<SectionSpec, { type: "tracked_keywords" }>): Promise<TrackedKeywordsData> => {
      const qc = await queries(cur);
      const qp = prim ? await queries(prim.range) : undefined;
      const live = s.liveRanks ? liveRanksAvailability(client) : undefined;
      const rows = await trackedKeywordRows(client, qc, live?.available ? deps.serp : undefined);
      const keywords = rows.map((r) => {
        const prev = qp?.find((q) => q.keys[0]?.toLowerCase() === r.keyword.toLowerCase())?.position ?? null;
        return { ...r, gscPositionPrevious: prev, positionChange: prev !== null && r.gscPosition !== null ? Number((r.gscPosition - prev).toFixed(1)) : null };
      });
      return { comparedWith: prim?.which ?? null, keywords, ...(live ? { liveRanks: live } : {}) };
    },
    opportunities: async (s: Extract<SectionSpec, { type: "opportunities" }>): Promise<OpportunityLists> => {
      const o = await deps.opportunitiesForMonth(client, cur, s.limit ?? 5);
      if (o.warning) note(`Opportunities: ${o.warning}`);
      return o;
    },
    audit_changes: async (s: Extract<SectionSpec, { type: "audit_changes" }>): Promise<AuditChangesData> => {
      const comparison = deps.monthlyAuditSection(deps.latestAudit(client.slug), deps.latestAuditBefore(client.slug, Date.parse(`${cur.startDate}T00:00:00Z`)));
      return { limit: s.limit ?? 10, comparison };
    },
    core_web_vitals_history: async (s: Extract<SectionSpec, { type: "core_web_vitals_history" }>): Promise<CruxHistoryResult> => {
      const r = await deps.cruxHistory(client, { formFactor: s.formFactor ?? "PHONE", weeks: s.weeks ?? 25, ...(s.scope === "url" ? { url: s.url } : {}) });
      if (!r.available) throw new SectionUnavailableError(r.reason);
      return r;
    },
    tag_manager: async (s: Extract<SectionSpec, { type: "tag_manager" }>): Promise<TagManagerData> => {
      let g: Omit<TagManagerData, "limit">;
      try {
        g = await deps.runGtmAudit(client);
      } catch (err) {
        if (/^No Tag Manager container found/.test((err as Error).message)) throw new SectionUnavailableError(`no Tag Manager container for ${client.domain}`);
        throw err;
      }
      const limit = s.limit ?? 20;
      return { limit, container: { publicId: g.container.publicId, name: g.container.name }, liveVersion: g.liveVersion, summary: g.summary, findings: g.findings.slice(0, limit), notes: g.notes };
    },
    data_spend: async (): Promise<DataSpendData> => ({
      month: new Date().toISOString().slice(0, 7),
      usd: Number(deps.spentThisMonth(keys).toFixed(4)),
      units: { ahrefs: deps.unitsThisMonth(keys, "ahrefs"), semrush: deps.unitsThisMonth(keys, "semrush") },
    }),
    text: async (s: Extract<SectionSpec, { type: "text" }>) => ({ text: s.text }),
    // Phase 13 B: provider sections, from the plan the pre-flight priced (stored snapshots first; D1-D7).
    backlinks: (s: Extract<SectionSpec, { type: "backlinks" }>) => providerSection(s),
    organic_visibility: (s: Extract<SectionSpec, { type: "organic_visibility" }>) => providerSection(s),
    competitor_overview: (s: Extract<SectionSpec, { type: "competitor_overview" }>) => providerSection(s),
    // Phase 13 A: fetchers land in A-4 (technical_issues) and A-5 (indexing_issues).
    // Phase 13 A: stored sources only (never starts a crawl).
    technical_issues: async (s: Extract<SectionSpec, { type: "technical_issues" }>): Promise<TechnicalIssuesData> => {
      // A source removed since 0.1.0 is dropped, with a note in the section.
      const removed = (s.sources as readonly string[] | undefined)?.includes(REMOVED_ISSUE_SOURCE) === true;
      const kept = (s.sources as readonly string[] | undefined)?.filter((x) => x !== REMOVED_ISSUE_SOURCE) as IssueSource[] | undefined;
      const r = await deps.technicalIssues(client, {
        sources: kept?.length ? kept : undefined,
        minSeverity: s.minSeverity,
        limit: s.limit ?? 25,
        maxAgeDays: s.maxAgeDays,
        // No paid source left after dropping the removed one: nothing to fetch example URLs from.
        issueUrls: kept?.some((x) => PAID_ISSUE_SOURCES.has(x)) ? s.issueUrls : removed ? 0 : s.issueUrls,
        allowPaid,
        // The base is the newest snapshot from before the period ended (for a September report run on 2 October, the
        // one the August report took about 2 September), never one this run made.
        baseBeforeMs: Date.parse(`${cur.endDate}T00:00:00Z`) + 86_400_000,
        excludeSnapshotIds: [...issueSnapshotIds],
      });
      if (r.snapshotId) issueSnapshotIds.add(r.snapshotId);
      if (!r.sources.length) throw new SectionUnavailableError(`no saved audit, crawl or URL Inspection results for ${client.domain} yet (run run_audit or crawlmark-cli crawl, free)`);
      const { snapshotId: _id, ...data } = r;
      return removed ? { ...data, notes: [REMOVED_ISSUE_SOURCE_NOTE] } : data;
    },
    // Phase 13 A: a sample, labelled as one in the file; never Search Console's full Page indexing report.
    indexing_issues: async (s: Extract<SectionSpec, { type: "indexing_issues" }>): Promise<IndexingIssuesData> => {
      const r = await deps.indexingSection(client, { maxInspections: s.maxInspections ?? 25, staleDays: s.staleDays ?? 7, limit: s.limit ?? 10, trendMonths: s.trendMonths ?? 6 });
      if (r.sample.inspected === 0 && !r.pagesReport) throw new SectionUnavailableError(`no URL Inspection results for ${client.domain} yet (run crawlmark-cli index-coverage, free)`);
      return r;
    },
    rank_trend: async (s: Extract<SectionSpec, { type: "rank_trend" }>): Promise<RankTrendData> => {
      // Local only: the stored rows up to the end of the report period.
      const days = { "90d": 90, "180d": 180, "365d": 365 }[s.since ?? "180d"];
      const until = cur.endDate;
      const since = new Date(Date.parse(`${until}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
      const h = deps.rankHistory(client, { since, until, source: s.source ?? "both" });
      const keywords = h.keywords
        .filter((k) => k.tracked || (k.summary.gsc?.checks ?? 0) + (k.summary.serp?.checks ?? 0) > 0)
        .map((k) => {
          const pts = (list: { day: string; rank: number | null }[] | undefined) => (list?.length ? thin(list.map((p) => ({ day: p.day, rank: p.rank })), RANK_SERIES_MAX) : undefined);
          const gscPts = pts(k.series?.gsc);
          const serpPts = pts(k.series?.serp);
          const series = { ...(gscPts ? { gsc: gscPts } : {}), ...(serpPts ? { serp: serpPts } : {}) };
          return { keyword: k.keyword, ...(k.summary.gsc ? { gsc: k.summary.gsc } : {}), ...(k.summary.serp ? { serp: k.summary.serp } : {}), ...(gscPts || serpPts ? { series } : {}) };
        });
      if (!keywords.some((k) => (k.gsc?.checks ?? 0) + (k.serp?.checks ?? 0) > 0)) {
        throw new SectionUnavailableError(client.trackedKeywords.length ? "no stored rank history for this period yet (run crawlmark-cli check-ranks, free, to start it)" : `no tracked keywords for ${client.domain}`);
      }
      return { since, until, source: s.source ?? "both", keywords };
    },
    site_crawl: async (s: Extract<SectionSpec, { type: "site_crawl" }>): Promise<SiteCrawlData> => {
      const crawl = deps.latestLocalCrawl(client.slug);
      if (!crawl) throw new SectionUnavailableError(`no local crawl saved for ${client.domain} yet (run crawlmark-cli crawl, free)`);
      const a = analyzeCrawl(crawl.pages, { exhaustive: crawl.exhaustive });
      const limit = s.limit ?? 10;
      const stored = (crawl.summary ?? {}) as { orphans?: { available: boolean; count?: number; reason?: string } };
      const orphans: SiteCrawlData["summary"]["orphans"] =
        stored.orphans?.available && typeof stored.orphans.count === "number"
          ? { available: true, count: stored.orphans.count }
          : {
              available: false,
              // The crawl's own reason, without any error detail in parentheses at the end (client-facing files).
              reason: stored.orphans?.reason
                ? stored.orphans.reason.replace(/^not available: /, "").replace(/ \([^()]*\)$/, "")
                : crawl.exhaustive
                  ? "the sitemaps couldn't be compared"
                  : "the crawl stopped at a cap, so unreached URLs can't be called orphans",
            };
      const { brokenLinks, redirects, missingTitles, duplicateTitles, missingDescriptions, duplicateDescriptions, canonicalIssues, noindex } = a.summary;
      return {
        crawlId: crawl.id,
        ranAt: new Date(crawl.ranAt).toISOString(),
        exhaustive: crawl.exhaustive,
        pages: crawl.pages.filter((p) => p.status !== null).length,
        summary: { brokenLinks, redirects, missingTitles, duplicateTitles, missingDescriptions, duplicateDescriptions, canonicalIssues, noindex, orphans },
        limit,
        findingCount: a.findings.length,
        issues: topFindings(a.findings, limit).map((f) => ({ severity: f.severity, rule: f.rule, title: f.title, url: f.url })),
      };
    },
    bing_overview: async (s: Extract<SectionSpec, { type: "bing_overview" }>): Promise<BingOverviewData> => {
      try {
        return await deps.bingOverview(client, { window: cur, compare: prim, limit: s.limit ?? 10 });
      } catch (err) {
        // The error lists the key's other verified sites: fine for the operator, not for a client's report.
        if ((err as Error).name === "BingSiteError") throw new SectionUnavailableError(`no verified Bing Webmaster Tools site for ${client.domain} (set it with crawlmark-cli clients set ${client.domain} --bing-site <url>)`);
        throw err;
      }
    },
    local_profile: async (s: Extract<SectionSpec, { type: "local_profile" }>): Promise<LocalProfileData> => {
      try {
        return await deps.localProfile(client, { packKeywords: s.packKeywords ?? 3 });
      } catch (err) {
        if ((err as Error).name === "LocalNotConfirmedError") throw new SectionUnavailableError((err as Error).message);
        throw err;
      }
    },
    ai_visibility: async (s: Extract<SectionSpec, { type: "ai_visibility" }>): Promise<AiVisibilityData> => {
      if (!deps.aiVisibilityEnabled()) throw new SectionUnavailableError("AI-search visibility is off (set AI_VISIBILITY_ENABLED=true to include it; it is paid)");
      return deps.aiVisibility(client, aiReq(s));
    },
    ai_readiness: async (): Promise<AiReadinessData> => {
      const audit = deps.latestAudit(client.slug);
      if (!audit) throw new SectionUnavailableError(`no saved audit for ${client.domain} yet (run run_audit or crawlmark-cli audit)`);
      const hygiene = (audit.result as { site?: { hygiene?: { ok: boolean; data?: SiteHygiene } } } | null)?.site?.hygiene;
      if (!hygiene?.ok || !hygiene.data) throw new SectionUnavailableError("the newest saved audit has no site hygiene result");
      const data = aiReadinessFrom(audit, hygiene.data);
      if (!data) throw new SectionUnavailableError("the newest saved audit predates the llms.txt and AI crawler checks; run run_audit again");
      return data;
    },
    keyword_gap: async (s: Extract<SectionSpec, { type: "keyword_gap" }>): Promise<KeywordGapData> => {
      let competitors: string[];
      try {
        competitors = deps.gapCompetitors(client, s.competitors);
      } catch (err) {
        throw new SectionUnavailableError(/no saved competitors/.test((err as Error).message) ? `no saved competitors for ${client.domain}` : errorText(err));
      }
      const limit = s.limit ?? 50;
      const r = await deps.keywordGap(client, { competitors, limit, minVolume: 0 }, {});
      if ("estimateOnly" in r) throw new Error("keyword gap returned an estimate");
      return { provider: r.provider, competitors, limit, gaps: r.gaps, perCompetitor: r.perCompetitor, ...(r.notes?.length ? { notes: r.notes } : {}) };
    },
  };

  const runOne = async (s: SectionSpec): Promise<SectionResult> => {
    const base = { id: s.id, type: s.type, title: s.title ?? SECTION_TITLES[s.type] };
    // technical_issues still runs its free sources without allowPaid; its paid sources are listed as unavailable.
    if ((isPaidSection(s) || s.paid === true) && !allowPaid && s.type !== "technical_issues") {
      return { ...base, status: "skipped", reason: "paid section; run with allowPaid: true (tool) or --paid (CLI) to include it" };
    }
    if (GSC_TYPES.has(s.type) || GA4_TYPES.has(s.type)) {
      if (!deps.googleConfigured()) return { ...base, status: "unavailable", reason: "Google isn't set up (run setup --step google)" };
      if (GSC_TYPES.has(s.type) && !client.gscProperty) return { ...base, status: "unavailable", reason: `no Search Console property for ${client.domain}` };
      if (GA4_TYPES.has(s.type) && !client.ga4PropertyId) return { ...base, status: "unavailable", reason: `no GA4 property for ${client.domain}` };
    }
    try {
      return { ...base, status: "ok", data: await fetchers[s.type](s as never) };
    } catch (err) {
      if (err instanceof SectionUnavailableError || err instanceof ProviderUnavailableError || err instanceof GoogleNotConfiguredError) {
        return { ...base, status: "unavailable", reason: errorText(err) };
      }
      return { ...base, status: "error", error: errorText(err) };
    }
  };

  // The paid sections' whole USD estimate is checked once and reserved while they run (SEC-1), and each unit
  // provider's whole estimate likewise (D16), so a concurrent cron run and Claude session can't both pass.
  // Competitor overviews run after the other sections, so this run's own visibility figures are stored first (their client row).
  const runWaves = async () => {
    const results = new Map<string, SectionResult>();
    const first = plan.sections.filter((s) => s.type !== "competitor_overview");
    for (const [i, r] of (await Promise.all(first.map(runOne))).entries()) results.set(first[i]!.id, r);
    const second = plan.sections.filter((s) => s.type === "competitor_overview");
    for (const [i, r] of (await Promise.all(second.map(runOne))).entries()) results.set(second[i]!.id, r);
    return plan.sections.map((s) => results.get(s.id)!);
  };
  let runAll = runWaves;
  for (const p of ["ahrefs", "semrush"] as const) {
    if (runUnits[p] <= 0) continue;
    const inner = runAll;
    runAll = () => deps.withUnitsReservation(client, p, runUnits[p], inner);
  }
  // The AI share is reserved against the AI sub-cap too, so a concurrent ai_visibility call sees it.
  const aiReserved = Number(aiUsd.toFixed(4));
  const sections =
    reservedUsd <= 0 ? await runAll() : aiReserved > 0 ? await deps.withUsdReservation(client, reservedUsd, runAll, { aiUsd: aiReserved }) : await deps.withUsdReservation(client, reservedUsd, runAll);
  if (sections.some((s) => s.status === "ok" && ["top_queries", "query_movers", "branded_split"].includes(s.type))) {
    const qc = await queries(cur).catch(() => []);
    if (qc.length >= QUERY_ROW_LIMIT) note(`Search Console returned its ${QUERY_ROW_LIMIT}-row limit of queries, so the long tail is missing from the query tables.`);
  }
  const spentAfter = { usd: deps.spentThisMonth(keys), ahrefs: deps.unitsThisMonth(keys, "ahrefs"), semrush: deps.unitsThisMonth(keys, "semrush") };

  const report: TemplateReport = {
    reportId: `rpt_${ulid()}`,
    client: { slug: client.slug, name: client.name, domain: client.domain },
    template: { id: template.id, title: template.spec.title, source: template.source, ...(template.spec.layout === "onepage" ? { layout: "onepage" as const } : {}) },
    period: { current: period.current, label: period.label, folderMonth: period.folderMonth, comparisons: period.comparisons },
    generatedAt: new Date().toISOString(),
    sections,
    highlights: [],
    notes,
    spend: {
      usd: Number(Math.max(0, spentAfter.usd - spentBefore.usd).toFixed(4)),
      units: { ahrefs: Math.max(0, spentAfter.ahrefs - spentBefore.ahrefs), semrush: Math.max(0, spentAfter.semrush - spentBefore.semrush) },
    },
  };
  // An invalid template file is ignored on this path (the CLI refuses to run instead): tell the operator,
  // not the client, so it goes in `warnings`, which no renderer reads.
  const templateWarnings = templateFileWarnings(plan.loaded);
  if (templateWarnings.length) report.warnings = templateWarnings;
  report.highlights = computeHighlights(report);
  if (opts.store !== false) storeReport(report);
  return report;
}
