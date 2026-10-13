/**
 * Section-to-block mapping (D1): one mapper per section type, shared by every
 * format so Markdown, HTML, DOCX and PDF can't drift. Stage B and C add section
 * types by adding a mapper here. Pure.
 */
import type {
  AuditChangesData,
  BrandedSplitData,
  ComparedTotals,
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
};

/** The blocks for one section, or a note saying why it has no data. */
export function sectionBlocks(s: SectionResult, report: TemplateReport): Block[] {
  if (s.status !== "ok") return [{ kind: "note", text: [t(statusLine(s))] }];
  const mapper = SECTION_MAPPERS[s.type];
  if (!mapper) return [{ kind: "note", text: [t(`${s.title}: this version can't render "${s.type}" sections.`)] }];
  return mapper(s.data as never, report);
}
