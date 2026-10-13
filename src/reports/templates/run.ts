/**
 * runTemplate (12.A.2 tool 4): resolve a template and its period, fetch each
 * section's data on its own (one failing source never sinks the report), and
 * store the result for 24 hours under a reportId so export_report renders the
 * exact numbers the commentary was written from (D9). Sources are injected
 * (RunDeps) so tests never touch Google; the defaults load the real providers.
 */
import { randomBytes } from "node:crypto";
import type { Client } from "../../config.js";
import { markBranded } from "../../analysis/branded.js";
import { isBranded } from "../../lib/brand.js";
import { cacheKey, peekCache, putCache, TTL } from "../../lib/cache.js";
import type { DateRange } from "../../lib/dates.js";
import { GoogleNotConfiguredError } from "../../lib/google-auth.js";
import { ProviderUnavailableError } from "../../lib/provider-ids.js";
import { spendKeys } from "../../lib/spend.js";
import { stripControl } from "../../lib/terminal-text.js";
import type { StoredAudit } from "../../analysis/diff.js";
import type { GscQueryOptions, GscRow } from "../../providers/gsc.js";
import { computeHighlights } from "../highlights.js";
import { brandedSplitFor, compare, liveRanksAvailability, movers, organicTrafficCompare, QUERY_ROW_LIMIT, trackedKeywordRows, type Ga4Summary, type PeriodTotals } from "../monthly.js";
import type {
  AuditChangesData,
  BrandedSplitData,
  Comparison,
  CruxHistoryResult,
  DataSpendData,
  LandingPagesData,
  MoversData,
  OpportunityLists,
  OrganicTrafficData,
  SearchOverviewData,
  SectionResult,
  TagManagerData,
  TemplateReport,
  TopRowsData,
  TrackedKeywordsData,
} from "../report-types.js";
import { loadTemplates, resolveTemplate, templateFileWarnings, type LoadedTemplates, type ResolvedTemplate } from "./load.js";
import { resolvePeriod, type ResolvedPeriod, type RunPeriodOverride } from "./period.js";
import { isPaidSection, SECTION_TITLES, type SectionSpec } from "./schema.js";

/** Rough ceiling per live SERP check (DataForSEO's own estimate for a SERP task). */
export const LIVE_RANK_ESTIMATE_USD = 0.002;

export interface RunDeps {
  googleConfigured(): boolean;
  gscQuery(client: Client, opts: GscQueryOptions): Promise<GscRow[]>;
  gscTotals(client: Client, range: DateRange): Promise<PeriodTotals>;
  ga4OrganicSummary(client: Client, range: DateRange): Promise<Ga4Summary>;
  ga4TopLandingPages(client: Client, range: DateRange, limit: number): Promise<Record<string, string | number>[]>;
  opportunitiesForMonth(client: Client, range: DateRange, n: number): Promise<OpportunityLists>;
  latestAudit(client: string): StoredAudit | undefined;
  latestAuditBefore(client: string, beforeMs: number): StoredAudit | undefined;
  monthlyAuditSection(latest: StoredAudit | undefined, before: StoredAudit | undefined): AuditChangesData["comparison"];
  spentThisMonth(keys: string[]): number;
  unitsThisMonth(keys: string[], provider: "ahrefs" | "semrush"): number;
  assertBudget(client: Client, estimateUsd: number): void;
  serp(client: Client, keyword: string): Promise<{ clientRank: number | null; clientUrl: string | null }>;
  runGtmAudit(client: Client): Promise<Omit<TagManagerData, "limit">>;
  cruxHistory(client: Client, opts: { formFactor: "PHONE" | "DESKTOP" | "TABLET" | "ALL"; weeks: number; url?: string | undefined }): Promise<CruxHistoryResult>;
}

/** The real sources. Modules load on first use, so planning a run (or a dry run) never loads Google clients. */
export async function loadDefaultRunDeps(): Promise<RunDeps> {
  const [google, gsc, ga4, opp, audits, diff, budget, seoData, gtm, crux] = await Promise.all([
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
  ]);
  return {
    googleConfigured: google.googleConfigured,
    gscQuery: gsc.gscQuery,
    gscTotals: gsc.gscTotals,
    ga4OrganicSummary: ga4.ga4OrganicSummary,
    ga4TopLandingPages: ga4.ga4TopLandingPages,
    opportunitiesForMonth: opp.opportunitiesForMonth,
    latestAudit: audits.latestAudit,
    latestAuditBefore: audits.latestAuditBefore,
    monthlyAuditSection: diff.monthlyAuditSection as RunDeps["monthlyAuditSection"],
    spentThisMonth: (keys) => budget.spentThisMonth(keys),
    unitsThisMonth: (keys, p) => budget.unitsThisMonth(keys, p),
    assertBudget: budget.assertBudget,
    serp: seoData.serp,
    runGtmAudit: gtm.runGtmAudit,
    cruxHistory: async (c, o) => crux.cruxHistory({ ...(o.url ? { url: o.url } : { origin: crux.clientOrigin(c) }), formFactor: o.formFactor, weeks: o.weeks }),
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

const GSC_TYPES = new Set(["search_overview", "branded_split", "top_queries", "query_movers", "top_pages", "page_movers", "tracked_keywords", "opportunities"]);
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

/** Crockford base32 ULID: 48-bit time + 80 random bits, sortable. */
export function ulid(now = Date.now()): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  let time = "";
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = alphabet[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const bytes = randomBytes(16);
  let rand = "";
  for (let i = 0; i < 16; i++) rand += alphabet[bytes[i]! % 32];
  return time + rand;
}

const storeKey = (reportId: string) => cacheKey("report-run", reportId);

export function storeReport(report: TemplateReport): void {
  putCache(storeKey(report.reportId), TTL.day, report);
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

const errorText = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err)).slice(0, 1000);

/** Run a template for one client. */
export async function runTemplate(client: Client, opts: RunOptions, deps: RunDeps): Promise<TemplateReport> {
  const plan = planRun(client, opts);
  const { template, period } = plan;
  const allowPaid = opts.allowPaid === true;
  const keys = spendKeys(client);

  // Pre-flight for the whole paid part, before any paid request.
  const liveRankSections = plan.sections.filter((s) => s.type === "tracked_keywords" && s.liveRanks === true);
  if (allowPaid && liveRankSections.length && client.trackedKeywords.length) {
    deps.assertBudget(client, client.trackedKeywords.length * LIVE_RANK_ESTIMATE_USD);
  }
  const spentBefore = { usd: deps.spentThisMonth(keys), ahrefs: deps.unitsThisMonth(keys, "ahrefs"), semrush: deps.unitsThisMonth(keys, "semrush") };

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
      return {
        metrics: s.metrics ?? ["clicks", "impressions", "ctr", "position"],
        current: c,
        vsPreviousPeriod,
        vsPreviousYear,
        ...(Object.keys(comparisonErrors).length ? { comparisonErrors } : {}),
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
      if (!p) {
        return { metrics, comparedWith: null, previous: null, sessions: { value: c.sessions, change: null }, users: { value: c.users, change: null }, engagementRate: { value: c.engagementRate, change: null }, keyEvents: { value: c.keyEvents, change: null } };
      }
      return { metrics, comparedWith: prim!.which, ...organicTrafficCompare(c, p), previous: { sessions: p.sessions, users: p.users, engagementRate: p.engagementRate, keyEvents: p.keyEvents } };
    },
    top_queries: async (s: Extract<SectionSpec, { type: "top_queries" }>): Promise<TopRowsData> => {
      const rows = markBranded(await queries(cur), client);
      const kept = s.includeBranded === false ? rows.filter((r) => !r.branded) : rows;
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
  };

  const runOne = async (s: SectionSpec): Promise<SectionResult> => {
    const base = { id: s.id, type: s.type, title: s.title ?? SECTION_TITLES[s.type] };
    if ((isPaidSection(s) || s.paid === true) && !allowPaid) {
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

  const sections = await Promise.all(plan.sections.map(runOne));
  if (sections.some((s) => s.status === "ok" && ["top_queries", "query_movers", "branded_split"].includes(s.type))) {
    const qc = await queries(cur).catch(() => []);
    if (qc.length >= QUERY_ROW_LIMIT) note(`Search Console returned its ${QUERY_ROW_LIMIT}-row limit of queries, so the long tail is missing from the query tables.`);
  }
  const spentAfter = { usd: deps.spentThisMonth(keys), ahrefs: deps.unitsThisMonth(keys, "ahrefs"), semrush: deps.unitsThisMonth(keys, "semrush") };

  const report: TemplateReport = {
    reportId: `rpt_${ulid()}`,
    client: { slug: client.slug, name: client.name, domain: client.domain },
    template: { id: template.id, title: template.spec.title, source: template.source },
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
