/**
 * Section-to-block mapping (D1): one mapper per section type, shared by every
 * format so Markdown, HTML, DOCX and PDF can't drift. Stage B and C add section
 * types by adding a mapper here. Pure.
 */
import type {
  AiReadinessData,
  AuditChangesData,
  BingOverviewData,
  BrandedSplitData,
  ComparedTotals,
  CruxHistoryResult,
  DataSpendData,
  KeywordGapData,
  LandingPagesData,
  LocalProfileData,
  RankTrendData,
  RankTrendSummary,
  SiteCrawlData,
  MoversData,
  OpportunityLists,
  OrganicTrafficData,
  SearchOverviewData,
  SectionResult,
  TagManagerData,
  TemplateReport,
  TextData,
  TopRowsData,
  TrackedKeywordsData,
} from "../report-types.js";
import { periodName } from "../templates/period.js";
import type { Block, Kpi, Text } from "./doc.js";
import { looksLinky } from "./escape.js";

const t = (s: string) => ({ t: s });
const c = (s: string) => ({ t: s, c: true as const });
/** A data string: URLs and other link-like text become code (D4: no links from data). */
const d = (s: string): Text => [looksLinky(s) ? c(s) : t(s)];
const cell = (s: string): Text => [t(s)];

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"));
export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`);
export const fmtChangeNumber = (n: number | null | undefined, unit = "") => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}${unit}`);
const fmt1 = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n.toFixed(1));
const fmtCtr = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n.toFixed(2)}%`);
const positionChange = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${fmtChangeNumber(n)} (lower is better)`);

const METRIC_LABEL = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Average position" } as const;

function metricValue(m: keyof typeof METRIC_LABEL, v: number | null | undefined) {
  return m === "ctr" ? fmtCtr(v) : m === "position" ? fmt1(v) : fmtInt(v);
}
function metricChange(m: keyof typeof METRIC_LABEL, vs: ComparedTotals | null) {
  if (!vs) return "n/a";
  const ch = vs[m].change;
  if (m === "ctr") return ch === null ? "n/a" : `${fmtChangeNumber(ch)} pts`;
  if (m === "position") return positionChange(ch);
  return fmtPct(ch);
}

/**
 * A section without data, for the client-facing files. A failure's raw error text (provider messages, local
 * paths) stays in the tool result and the CLI's `sectionErrors`; the files only say it couldn't be fetched.
 * Unavailable and skipped reasons are crawlmark's own fixed text.
 */
export function statusLine(s: SectionResult): string {
  if (s.status === "error") return `${s.title}: couldn't be fetched for this report.`;
  if (s.status === "unavailable") return `${s.title}: unavailable: ${s.reason}`;
  if (s.status === "skipped") return `${s.title}: skipped: ${s.reason}`;
  return `${s.title}: ok`;
}

/** The "Key figures" row: Search Console totals against the first comparison. */
export function keyFigures(report: TemplateReport): Kpi[] {
  const s = report.sections.find((x) => x.type === "search_overview" && x.status === "ok");
  if (!s || s.status !== "ok") return [];
  const data = s.data as SearchOverviewData;
  const vs = data.vsPreviousPeriod ?? data.vsPreviousYear;
  const prev = vs?.previous;
  const detail = (m: keyof typeof METRIC_LABEL) => {
    if (!vs || !prev) return undefined;
    if (m === "position") return `from ${fmt1(prev.position)}; lower is better`;
    if (m === "ctr") return `${fmtChangeNumber(vs.ctr.change)} pts vs ${fmtCtr(prev.ctr)}`;
    return `${fmtPct(vs[m].change)} vs ${fmtInt(prev[m])}`;
  };
  return data.metrics.map((m) => {
    const dt = detail(m);
    return { label: METRIC_LABEL[m], value: metricValue(m, data.current[m]), ...(dt ? { detail: dt } : {}) };
  });
}

type Mapper = (data: never, report: TemplateReport) => Block[];

const moversTables = (m: MoversData, label: string, asCode: boolean): Block[] => {
  const rows = (list: MoversData["gainers"]) =>
    list.map((r) => [asCode ? [c(r.key)] : d(r.key), cell(fmtInt(r.clicks)), cell(`${r.clicksDelta > 0 ? "+" : r.clicksDelta < 0 ? "−" : ""}${fmtInt(Math.abs(r.clicksDelta))}`), cell(fmt1(r.position)), cell(fmtChangeNumber(r.positionDelta))]);
  const header = [label, "Clicks", "Clicks change", "Position", "Position change (lower is better)"];
  const numeric = [false, true, true, true, true];
  return [
    { kind: "heading", level: 3, text: "Gained clicks" },
    m.gainers.length ? { kind: "table", header, rows: rows(m.gainers), numeric } : { kind: "paragraph", text: [t("None.")] },
    { kind: "heading", level: 3, text: "Lost clicks" },
    m.losers.length ? { kind: "table", header, rows: rows(m.losers), numeric } : { kind: "paragraph", text: [t("None.")] },
  ];
};

const vsLabel = (report: TemplateReport, which: "previous_period" | "previous_year" | null) => {
  const r = which ? report.period.comparisons[which] : undefined;
  return r ? periodName(r) : "";
};

/** "8.4 → 5.1" (first → latest), or the single value, or "no data". */
const trendText = (sum: RankTrendSummary | undefined) => {
  if (!sum || sum.latest === null) return sum && sum.checks > 0 ? "not found" : "no data";
  return sum.first !== null && sum.firstDay !== sum.latestDay ? `${fmt1(sum.first)} → ${fmt1(sum.latest)}` : fmt1(sum.latest);
};
const PROVIDER_NAME = { dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" } as const;
const KD_LABEL = { dataforseo_kd: "DataForSEO difficulty", ahrefs_kd: "Ahrefs KD", semrush_kd: "Semrush KD" } as const;

export const SECTION_MAPPERS: Record<string, Mapper> = {
  search_overview: (data: SearchOverviewData, report) => {
    const cur = periodName(report.period.current);
    const pp = report.period.comparisons.previous_period;
    const py = report.period.comparisons.previous_year;
    const header = ["Metric", cur, ...(pp ? [periodName(pp), "Change"] : []), ...(py ? [periodName(py), "Change"] : [])];
    const rows = data.metrics.map((m) => [
      cell(METRIC_LABEL[m]),
      cell(metricValue(m, data.current[m])),
      ...(pp ? [cell(data.vsPreviousPeriod?.previous ? metricValue(m, data.vsPreviousPeriod.previous[m]) : "no data"), cell(metricChange(m, data.vsPreviousPeriod))] : []),
      ...(py ? [cell(data.vsPreviousYear?.previous ? metricValue(m, data.vsPreviousYear.previous[m]) : "no data"), cell(metricChange(m, data.vsPreviousYear))] : []),
    ]);
    return [{ kind: "table", header, rows, numeric: header.map((_, i) => i > 0) }];
  },
  branded_split: (data: BrandedSplitData, report) => {
    const prev = vsLabel(report, data.comparedWith);
    const row = (label: string, s: BrandedSplitData["branded"]) => [
      cell(label),
      cell(fmtInt(s.current.clicks)),
      ...(prev ? [cell(fmtInt(s.previous.clicks)), cell(fmtPct(s.change.clicks))] : []),
      cell(fmtInt(s.current.impressions)),
      cell(fmtCtr(s.current.ctr)),
      cell(fmt1(s.current.position)),
    ];
    const header = ["Queries", "Clicks", ...(prev ? [`Clicks (${prev})`, "Change"] : []), "Impressions", "CTR", "Average position"];
    const share = data.brandedShareOfClicks;
    return [
      { kind: "table", header, rows: [row("Branded", data.branded), row("Non-branded", data.nonBranded)], numeric: header.map((_, i) => i > 0) },
      { kind: "paragraph", text: [t(`Branded share of clicks: ${share.current === null ? "n/a" : `${share.current.toFixed(1)}%`}${prev && share.previous !== null ? ` (${share.previous.toFixed(1)}% in ${prev})` : ""}.`)] },
      {
        kind: "note",
        text: [
          t(
            "Built from Search Console query rows, which leave out anonymized queries (rare queries Google withholds), so branded + non-branded is slightly under the site total." +
              (data.queryRows.current >= data.queryRows.limit || data.queryRows.previous >= data.queryRows.limit ? ` Search Console returned its row limit (${fmtInt(data.queryRows.limit)} queries), so the long tail is missing too.` : ""),
          ),
        ],
      },
      ...(data.brandTerms.length ? [{ kind: "paragraph" as const, text: [t(`Brand terms: ${data.brandTerms.join(", ")} (plus the domain and business name).`)] }] : []),
    ];
  },
  organic_traffic: (data: OrganicTrafficData, report) => {
    const prev = vsLabel(report, data.comparedWith);
    const labels = { sessions: "Sessions", users: "Users", engagementRate: "Engagement rate", keyEvents: "Key events" } as const;
    const val = (m: keyof typeof labels, v: number | undefined) => (v === undefined ? "n/a" : m === "engagementRate" ? `${v.toFixed(1)}%` : fmtInt(v));
    const header = ["Metric", periodName(report.period.current), ...(prev ? [prev, "Change"] : [])];
    const rows = data.metrics.map((m) => [
      cell(labels[m]),
      cell(val(m, data[m].value)),
      ...(prev ? [cell(val(m, data.previous?.[m])), cell(m === "engagementRate" ? `${fmtChangeNumber(data[m].change)} pts` : fmtPct(data[m].change))] : []),
    ]);
    return [{ kind: "table", header, rows, numeric: header.map((_, i) => i > 0) }];
  },
  top_queries: (data: TopRowsData) => [
    data.rows.length
      ? {
          kind: "table",
          header: ["#", "Query", "Clicks", "Impressions", "CTR", "Position", "Branded"],
          rows: data.rows.map((r, i) => [cell(String(i + 1)), d(r.keys[0] ?? ""), cell(fmtInt(r.clicks)), cell(fmtInt(r.impressions)), cell(fmtCtr(r.ctr)), cell(fmt1(r.position)), cell(r.branded ? "yes" : "")]),
          numeric: [true, false, true, true, true, true, false],
        }
      : { kind: "paragraph", text: [t("No queries in this period.")] },
  ],
  query_movers: (data: MoversData) => moversTables(data, "Query", false),
  page_movers: (data: MoversData) => moversTables(data, "Page", true),
  top_pages: (data: TopRowsData) => [
    data.rows.length
      ? {
          kind: "table",
          header: ["Page", "Clicks", "Impressions", "CTR", "Position"],
          rows: data.rows.map((r) => [[c(r.keys[0] ?? "")], cell(fmtInt(r.clicks)), cell(fmtInt(r.impressions)), cell(fmtCtr(r.ctr)), cell(fmt1(r.position))]),
          numeric: [false, true, true, true, true],
        }
      : { kind: "paragraph", text: [t("No pages in this period.")] },
  ],
  landing_pages: (data: LandingPagesData) => [
    data.rows.length
      ? {
          kind: "table",
          header: ["Landing page", "Sessions", "Engagement rate", "Key events"],
          rows: data.rows.map((r) => [[c(String(r.landingPagePlusQueryString ?? ""))], cell(fmtInt(Number(r.sessions ?? 0))), cell(`${(Number(r.engagementRate ?? 0) * 100).toFixed(1)}%`), cell(fmtInt(Number(r.keyEvents ?? 0)))]),
          numeric: [false, true, true, true],
        }
      : { kind: "paragraph", text: [t("No organic landing pages in this period.")] },
  ],
  tracked_keywords: (data: TrackedKeywordsData, report) => {
    if (!data.keywords.length) return [{ kind: "paragraph", text: [t("No tracked keywords. Add some with crawlmark-cli keywords add.")] }];
    const live = data.liveRanks?.available === true;
    const prev = vsLabel(report, data.comparedWith);
    const header = ["Keyword", "Average position", ...(prev ? [`Position (${prev})`, "Change (lower is better)"] : []), "Clicks", "Impressions", ...(live ? ["Live rank"] : [])];
    const rows = data.keywords.map((k) => [
      d(k.keyword),
      cell(k.gscPosition === null ? "not in the data" : fmt1(k.gscPosition)),
      ...(prev ? [cell(fmt1(k.gscPositionPrevious)), cell(fmtChangeNumber(k.positionChange))] : []),
      cell(fmtInt(k.gscClicks)),
      cell(fmtInt(k.gscImpressions)),
      ...(live ? [cell(k.liveRank === null ? "not in the top 100" : String(k.liveRank))] : []),
    ]);
    return [
      { kind: "table", header, rows, numeric: header.map((_, i) => i > 0) },
      ...(data.liveRanks && !data.liveRanks.available ? [{ kind: "note" as const, text: [t(`Live ranks unavailable: ${data.liveRanks.reason}`)] }] : []),
    ];
  },
  opportunities: (data: OpportunityLists) => {
    const sd = data.strikingDistance.top;
    const lc = data.lowCtr.top;
    const cn = data.cannibalization.top;
    return [
      { kind: "heading", level: 3, text: `Striking distance (${data.strikingDistance.total} found)` },
      sd.length
        ? { kind: "table", header: ["Query", "Page", "Position", "Impressions", "Est. extra clicks"], rows: sd.map((r) => [d(r.query), [c(r.topPage)], cell(fmt1(r.position)), cell(fmtInt(r.impressions)), cell(fmtInt(r.estimatedExtraClicks))]), numeric: [false, false, true, true, true] }
        : { kind: "paragraph", text: [t("None.")] },
      { kind: "heading", level: 3, text: `Low CTR at the top (${data.lowCtr.total} found)` },
      lc.length
        ? { kind: "table", header: ["Query", "Page", "Position", "CTR", "Expected CTR", "Est. extra clicks"], rows: lc.map((r) => [d(r.query), [c(r.page)], cell(fmt1(r.position)), cell(fmtCtr(r.ctr)), cell(fmtCtr(r.expectedCtr)), cell(fmtInt(r.estimatedExtraClicks))]), numeric: [false, false, true, true, true, true] }
        : { kind: "paragraph", text: [t("None.")] },
      { kind: "heading", level: 3, text: `Pages competing for one query (${data.cannibalization.total} found)` },
      cn.length
        ? { kind: "table", header: ["Query", "Pages", "Impressions"], rows: cn.map((r) => [d(r.query), [t(r.pages.map((p) => `${p.page} (${Math.round(p.impressionShare * 100)}%)`).join(", "))], cell(fmtInt(r.totalImpressions))]), numeric: [false, false, true] }
        : { kind: "paragraph", text: [t("None.")] },
      { kind: "note", text: [t(data.method)] },
    ];
  },
  audit_changes: (data: AuditChangesData) => {
    const cmp = data.comparison;
    if (!cmp) return [{ kind: "paragraph", text: [t("No audit comparison is available for this period (it needs a saved audit from before the period and a newer one).")] }];
    const k = cmp.diff.counts;
    const top = cmp.diff.new.slice(0, data.limit);
    return [
      { kind: "kpiRow", items: [{ label: "Resolved", value: fmtInt(k.resolved) }, { label: "New", value: fmtInt(k.new) }, { label: "Still open", value: fmtInt(k.persistent) }, { label: "Not re-checked", value: fmtInt(k.unverified) }] },
      { kind: "paragraph", text: [t(`Latest audit ${cmp.auditId} (${cmp.ranAt.slice(0, 10)}) compared with ${cmp.diff.base.auditId} (${cmp.diff.base.ranAt.slice(0, 10)}).`)] },
      ...(top.length
        ? [{ kind: "heading" as const, level: 3 as const, text: "New findings" }, { kind: "table" as const, header: ["Severity", "Finding", "URL"], rows: top.map((f) => [cell(f.severity), d(f.title), [c(f.url)]]) }]
        : []),
      ...(cmp.diff.scoreChanges.length
        ? [{ kind: "table" as const, header: ["URL", "Lighthouse category", "From", "To"], rows: cmp.diff.scoreChanges.map((s) => [[c(s.url)], cell(s.category), cell(String(s.from)), cell(String(s.to))]), numeric: [false, false, true, true] }]
        : []),
      { kind: "note", text: [t("Findings that weren't re-checked in the latest audit are listed as not re-checked, never as fixed.")] },
    ];
  },
  core_web_vitals_history: (data: CruxHistoryResult) => {
    if (!data.available) return [{ kind: "paragraph", text: [t(data.reason)] }];
    const names = { lcp: "Largest Contentful Paint", inp: "Interaction to Next Paint", cls: "Cumulative Layout Shift", fcp: "First Contentful Paint", ttfb: "Time to First Byte" } as const;
    const val = (u: "ms" | "score", v: number | null) => (v === null ? "n/a" : u === "score" ? v.toFixed(2) : `${fmtInt(v)} ms`);
    const first = data.periods[0];
    const last = data.periods.at(-1);
    const rows = (Object.keys(names) as (keyof typeof names)[]).flatMap((m) => {
      const s = data.metrics[m];
      if (!s) return [];
      const rating = [...s.rating].reverse().find((r) => r !== null) ?? null;
      return [[cell(names[m]), cell(val(s.unit, s.first)), cell(val(s.unit, s.latest)), cell(s.change === null ? "n/a" : s.unit === "score" ? `${s.change > 0 ? "+" : s.change < 0 ? "−" : ""}${Math.abs(s.change).toFixed(2)}` : `${s.change > 0 ? "+" : s.change < 0 ? "−" : ""}${fmtInt(Math.abs(s.change))} ms`), cell(rating ? rating.replace("-", " ") : "n/a"), cell(s.trend.replace("-", " "))]];
    });
    const key = data.key.url ?? data.key.origin ?? "";
    return [
      { kind: "paragraph", text: [t("Real-user 75th percentile for "), c(key), t(` (${data.key.formFactor.toLowerCase()}), ${data.periods.length} weekly periods${first && last ? ` from ${first.end} to ${last.end}` : ""}.`)] },
      { kind: "table", header: ["Metric", "First period", "Latest period", "Change", "Rating now", "Trend"], rows, numeric: [false, true, true, true, false, false] },
      { kind: "note", text: [t("From the Chrome UX Report: each period is a 28-day window, updated weekly. Lower is better for every metric.")] },
    ];
  },
  tag_manager: (data: TagManagerData) => [
    { kind: "paragraph", text: [t("Container "), c(data.container.publicId), t(` (${data.container.name})${data.liveVersion ? `, live version ${data.liveVersion.versionId}` : ", never published"}: ${data.summary.tags} tags, ${data.summary.triggers} triggers, ${data.summary.variables} variables, ${data.summary.findings} findings.`)] },
    data.findings.length
      ? { kind: "table", header: ["Severity", "Rule", "Finding", "Entity"], rows: data.findings.map((f) => [cell(f.severity), cell(f.rule), d(f.title), d(`${f.entity.kind} ${f.entity.name}`)]) }
      : { kind: "paragraph", text: [t("No findings.")] },
    // Notes can carry Tag Manager API error text; the files only say what kind of note it is.
    ...data.notes.map((n) => ({ kind: "note" as const, text: [t(/^Unpublished changes incomplete/.test(n) ? "Unpublished changes: some workspaces couldn't be read." : n.startsWith("This container has never been published") ? n : "A Tag Manager note couldn't be shown in this report.")] })),
  ],
  data_spend: (data: DataSpendData) => [
    { kind: "paragraph", text: [t(`Paid data used this calendar month (${data.month}, all of crawlmark for this client): DataForSEO $${data.usd.toFixed(2)}, Ahrefs ${fmtInt(data.units.ahrefs)} units, Semrush ${fmtInt(data.units.semrush)} units.`)] },
  ],
  text: (data: TextData) => [{ kind: "paragraph", text: [t(data.text)] }],
  // Phase 12 B: stored rank history, text trend first → latest (no sparklines).
  rank_trend: (data: RankTrendData) => {
    const gsc = data.source !== "serp";
    const serp = data.source !== "gsc";
    const header = ["Keyword", ...(gsc ? ["Search Console average position", "Change"] : []), ...(serp ? ["Live rank", "Change"] : [])];
    const rows = data.keywords.map((k) => [
      d(k.keyword),
      ...(gsc ? [cell(trendText(k.gsc)), cell(fmtChangeNumber(k.gsc?.change))] : []),
      ...(serp ? [cell(trendText(k.serp)), cell(fmtChangeNumber(k.serp?.change))] : []),
    ]);
    return [
      { kind: "paragraph", text: [t(`Stored checks from ${data.since} to ${data.until}, first → latest. Lower is better, so a negative change is an improvement.`)] },
      { kind: "table", header, rows, numeric: header.map((_, i) => i > 0) },
      {
        kind: "note",
        text: [
          t(
            (gsc ? "Search Console average position is a 7-day average and moves with the mix of searches. " : "") +
              (serp ? "Live rank is Google's organic position on the day it was checked (DataForSEO); \"not found\" means outside the depth checked." : ""),
          ),
        ],
      },
    ];
  },
  // Phase 12 C1: the newest saved local crawl.
  site_crawl: (data: SiteCrawlData) => {
    const s = data.summary;
    const rows: [string, string][] = [
      ["Pages fetched", fmtInt(data.pages)],
      ["Broken internal links", fmtInt(s.brokenLinks)],
      ["Redirects", fmtInt(s.redirects)],
      ["Missing titles", fmtInt(s.missingTitles)],
      ["Duplicate titles", fmtInt(s.duplicateTitles)],
      ["Missing meta descriptions", fmtInt(s.missingDescriptions)],
      ["Duplicate meta descriptions", fmtInt(s.duplicateDescriptions)],
      ["Canonical issues", fmtInt(s.canonicalIssues)],
      ["Noindex pages", fmtInt(s.noindex)],
      ["Orphan pages (in a sitemap, not linked)", s.orphans.available ? fmtInt(s.orphans.count) : "not judged"],
    ];
    return [
      {
        kind: "paragraph",
        text: [t(`crawlmark's own crawl of the site on ${data.ranAt.slice(0, 10)}: ${fmtInt(data.pages)} pages, ${data.exhaustive ? "complete (every internal link found was followed)" : "stopped at a cap (not every page was reached)"}. ${fmtInt(data.findingCount)} issues found.`)],
      },
      { kind: "table", header: ["Check", "Pages"], rows: rows.map(([k, v]) => [cell(k), cell(v)]), numeric: [false, true] },
      data.issues.length
        ? { kind: "table", header: ["Severity", "Issue", "URL"], rows: data.issues.map((i) => [cell(i.severity), cell(i.title), d(i.url)]) }
        : { kind: "paragraph", text: [t("No issues found.")] },
      ...(s.orphans.available ? [] : [{ kind: "note" as const, text: [t(`Orphan pages weren't judged: ${s.orphans.reason}.`)] }]),
      { kind: "note", text: [t("Crawled from this machine without JavaScript rendering, obeying robots.txt. Issue counts are pages.")] },
    ];
  },
  // Phase 12 C3: Bing Webmaster Tools for the report period. Queries and URLs are Bing's (stripControl'd); URLs render as code.
  bing_overview: (data: BingOverviewData) => {
    const prev = data.previous;
    const cmp = data.comparedWith?.which === "previous_year" ? "previous year" : "previous period";
    const rows: Text[][] = [
      [cell("Clicks"), cell(fmtInt(data.totals.clicks)), cell(prev ? fmtInt(prev.clicks) : "n/a"), cell(fmtPct(data.totals.change.clicks))],
      [cell("Impressions"), cell(fmtInt(data.totals.impressions)), cell(prev ? fmtInt(prev.impressions) : "n/a"), cell(fmtPct(data.totals.change.impressions))],
      [cell("CTR"), cell(fmtCtr(data.totals.ctr)), cell(prev ? fmtCtr(prev.ctr) : "n/a"), cell(data.totals.change.ctr === null ? "n/a" : `${fmtChangeNumber(data.totals.change.ctr)} pts`)],
    ];
    const latest = data.crawl.latest;
    return [
      { kind: "paragraph", text: [t("Bing Webmaster Tools data for "), c(data.site), t(` from ${data.window.startDate} to ${data.window.endDate}${data.comparedWith ? `, compared with the ${cmp} (${data.comparedWith.range.startDate} to ${data.comparedWith.range.endDate})` : ""}.`)] },
      { kind: "table", header: ["Metric", "This period", data.comparedWith ? `The ${cmp}` : "Previous", "Change"], rows, numeric: [false, true, true, true] },
      data.topQueries.length
        ? { kind: "table", header: ["Query", "Clicks", "Impressions", "Average position"], rows: data.topQueries.map((q) => [d(q.query), cell(fmtInt(q.clicks)), cell(fmtInt(q.impressions)), cell(fmt1(q.avgPosition))]), numeric: [false, true, true, true] }
        : { kind: "paragraph", text: [t("Bing has no query stats for this period yet.")] },
      ...(data.topPages.length
        ? [{ kind: "table" as const, header: ["Page", "Clicks", "Impressions", "Average position"], rows: data.topPages.map((p) => [d(p.page), cell(fmtInt(p.clicks)), cell(fmtInt(p.impressions)), cell(fmt1(p.avgPosition))]), numeric: [false, true, true, true] }]
        : []),
      ...(latest
        ? [{ kind: "paragraph" as const, text: [t(`Crawling on ${latest.date}: ${fmtInt(latest.inIndex)} pages in Bing's index, ${fmtInt(latest.crawledPages)} crawled, ${fmtInt(latest.crawlErrors)} crawl errors. ${fmtInt(data.crawl.issueCount)} URLs have crawl issues listed in Bing Webmaster Tools.`)] }]
        : []),
      ...data.notes.filter((n) => n !== "Bing updates query stats weekly").map((n) => ({ kind: "note" as const, text: [t(n)] })),
      { kind: "note", text: [t("Bing updates query and page stats weekly, so the tables can lag the daily totals. Position is Bing's average for impressions; lower is better.")] },
    ];
  },
  // llms.txt and AI crawler access from the newest saved audit. llms.txt content is untrusted: only counts and the
  // stripped title are shown (escaped as data), and URLs render as code.
  ai_readiness: (data: AiReadinessData) => {
    const l = data.llmsTxt;
    const blocks: Block[] = [{ kind: "paragraph", text: [t(`From the saved audit of ${data.ranAt.slice(0, 10)}: whether the site has an llms.txt file, and which AI crawlers its robots.txt lets in.`)] }];
    if (!l.checked) blocks.push({ kind: "paragraph", text: [t("llms.txt couldn't be checked in that audit.")] });
    else if (!l.present) {
      blocks.push({ kind: "paragraph", text: [t("No llms.txt at "), c(l.url), t(` (HTTP ${l.status}).`)] });
    } else {
      const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;
      const rows: [string, Text][] = [
        ["llms.txt", [c(l.url)]],
        ["HTTP status", cell(String(l.status))],
        ["Content type", l.contentType ? d(l.contentType) : cell("not sent")],
        ["Size", cell(kb(l.bytes))],
        ["Title (H1)", l.title ? d(l.title) : cell("none")],
        ["Summary (blockquote)", cell(l.hasSummary ? "yes" : "no")],
        ["Link sections (H2)", cell(fmtInt(l.sections))],
        ["Links", cell(fmtInt(l.links))],
        ["\"Optional\" section", cell(l.hasOptionalSection ? "yes" : "no")],
        ["Format", cell(l.issues.length ? `${l.issues.length} issue${l.issues.length === 1 ? "" : "s"}` : "follows the llmstxt.org proposal")],
        ["Links checked", cell(`${fmtInt(l.linksChecked)} (${fmtInt(l.brokenLinks.length)} not returning 200)`)],
        ["llms-full.txt", cell(l.full ? (l.full.present ? `present (${kb(l.full.bytes)})` : `missing (HTTP ${l.full.status})`) : "couldn't be checked")],
      ];
      blocks.push({ kind: "table", header: ["llms.txt", "Value"], rows: rows.map(([k, v]) => [cell(k), v]) });
      if (l.issues.length) blocks.push({ kind: "list", items: l.issues.map((i) => cell(i)) });
      if (l.brokenLinks.length) blocks.push({ kind: "table", header: ["Linked URL", "HTTP status"], rows: l.brokenLinks.map((b) => [[c(b.url)], cell(String(b.status))]), numeric: [false, true] });
    }
    const cr = data.crawlers;
    if (!cr.checked) blocks.push({ kind: "paragraph", text: [t("AI crawler access couldn't be checked in that audit (robots.txt couldn't be read).")] });
    else {
      const PURPOSE = { search: "AI search", user: "Answers a user's question", training: "Training only" } as const;
      const ACCESS = { allowed: "Allowed", partial: "Partly blocked", blocked: "Blocked (whole site)" } as const;
      if (!cr.robotsFound) blocks.push({ kind: "paragraph", text: [t("The site has no robots.txt, so every crawler is allowed.")] });
      blocks.push({
        kind: "table",
        header: ["Crawler", "Purpose", "robots.txt group", "Homepage", "Other key pages blocked", "Overall"],
        rows: cr.rows.map((r) => [cell(`${r.bot} (${r.vendor})`), cell(PURPOSE[r.purpose]), cell(r.group === "named" ? "its own" : r.group === "*" ? "* (all crawlers)" : "none"), cell(r.homepage === "allowed" ? "Allowed" : "Blocked"), cell(`${fmtInt(r.blockedKeyPages)} of ${fmtInt(cr.keyPages)}`), cell(ACCESS[r.access])]),
      });
      blocks.push({ kind: "note", text: [t("Blocking an AI search crawler keeps the site out of that product's answers; blocking a training-only crawler is a legitimate choice and has no effect on search. ChatGPT-User and Perplexity-User may not follow robots.txt.")] });
    }
    blocks.push({ kind: "note", text: [t("llms.txt is a proposed standard (llmstxt.org). Google says Google Search doesn't use it, so it's reported for information, not scored.")] });
    return blocks;
  },
  // Phase 12 C4: the confirmed Google Business Profile and map-pack positions. Listing text is Google's (stripControl'd); the URL renders as code.
  local_profile: (data: LocalProfileData) => {
    const b = data.business;
    const facts: Text[][] = [
      [cell("Business"), b.title ? d(b.title) : cell("n/a")],
      [cell("Category"), b.category ? d(b.category) : cell("n/a")],
      [cell("Rating"), cell(b.rating === null ? "n/a" : `${b.rating.toFixed(1)} from ${fmtInt(b.votes)} reviews`)],
      [cell("Profile claimed"), cell(b.isClaimed === null ? "n/a" : b.isClaimed ? "yes" : "no")],
      [cell("Photos"), cell(fmtInt(b.totalPhotos))],
      ...(b.url ? [[cell("Website"), [c(b.url)]]] : []),
    ];
    const dist = b.ratingDistribution;
    const blocks: Block[] = [
      { kind: "paragraph", text: [t("Google Business Profile, and Google Maps positions searched in "), ...d(data.location), t(".")] },
      { kind: "table", header: ["", "Value"], rows: facts, numeric: [false, false] },
    ];
    if (dist) {
      blocks.push({ kind: "table", header: ["Stars", "Reviews"], rows: (["5", "4", "3", "2", "1"] as const).map((k) => [cell(`${k} stars`), cell(fmtInt(dist[k]))]), numeric: [false, true] });
    }
    if (data.pack.length) {
      blocks.push({
        kind: "table",
        header: ["Keyword", "Map position", "First place"],
        rows: data.pack.map((p) => [d(p.keyword), cell(p.failed ? "couldn't be checked" : p.clientRank === null ? "not in the results" : String(p.clientRank)), p.leader?.title ? d(p.leader.title) : cell("n/a")]),
        numeric: [false, true, false],
      });
    }
    for (const n of data.notes) blocks.push({ kind: "note", text: [t(n)] });
    blocks.push({ kind: "note", text: [t("From Google Maps and the Google Business Profile, via DataForSEO, when this report was generated. Map position 1 is the top of the map pack; lower is better.")] });
    return blocks;
  },
  keyword_gap: (data: KeywordGapData) => {
    const metric = data.gaps.find((g) => g.difficulty.value !== null)?.difficulty.metric ?? data.gaps[0]?.difficulty.metric;
    const header = ["Keyword", "Monthly volume", metric ? KD_LABEL[metric] : "Difficulty", "Competitors ranking (position)"];
    return [
      {
        kind: "paragraph",
        text: [t(`Keywords ${data.competitors.join(", ")} rank for and this site doesn't (${PROVIDER_NAME[data.provider]} data, up to ${fmtInt(data.limit)} per competitor), sorted by volume.`)],
      },
      data.gaps.length
        ? {
            kind: "table",
            header,
            rows: data.gaps.map((g) => [d(g.keyword), cell(fmtInt(g.volume)), cell(g.difficulty.value === null ? "n/a" : String(g.difficulty.value)), d(g.competitors.map((x) => `${x.domain}${x.position === null ? "" : ` (${x.position})`}`).join(", "))]),
            numeric: [false, true, true, false],
          }
        : { kind: "paragraph", text: [t("No gap keywords found.")] },
      ...(data.gaps.some((g) => g.clientCheck === "gsc") ? [{ kind: "note" as const, text: [t("Keywords this site already gets Search Console impressions for were left out.")] }] : []),
      { kind: "note", text: [t("Difficulty is the provider's own 0-100 scale; don't compare it with another provider's.")] },
    ];
  },
};

/** The blocks for one section, or a note saying why it has no data. */
export function sectionBlocks(s: SectionResult, report: TemplateReport): Block[] {
  if (s.status !== "ok") return [{ kind: "note", text: [t(statusLine(s))] }];
  const mapper = SECTION_MAPPERS[s.type];
  if (!mapper) return [{ kind: "note", text: [t(`${s.title}: this version can't render "${s.type}" sections.`)] }];
  return mapper(s.data as never, report);
}
