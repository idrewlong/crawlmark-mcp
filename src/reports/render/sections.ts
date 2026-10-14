/**
 * Section-to-block mapping (D1): one mapper per section type, shared by every
 * format so Markdown, HTML, DOCX and PDF can't drift. Stage B and C add section
 * types by adding a mapper here. Pure.
 *
 * Mappers return no blocks when a section has nothing to show (the section is
 * then left out and named once in "About this report"), drop comparison
 * columns that have no data (with one note), show page paths instead of full
 * URLs where the section is about traffic, and keep full URLs (as code) where
 * the section is about URLs (crawl issues, llms.txt, Bing).
 */
import type {
  BacklinksData,
  BacklinksNow,
  CompetitorOverviewData,
  CompetitorRow,
  VisibilityData,
  VisibilityNow,
  AiReadinessData,
  AiVisibilityData,
  AuditChangesData,
  BingOverviewData,
  BrandedSplitData,
  ComparedTotals,
  CruxHistoryResult,
  CwvMetric,
  DataSpendData,
  KeywordGapData,
  LandingPagesData,
  LocalProfileData,
  RankTrendData,
  RankTrendSummary,
  SiteCrawlData,
  IndexingIssuesData,
  IssueSource,
  TechIssue,
  TechnicalIssuesData,
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
import type { Block, Delta, Kpi, LineChart, TableBlock, Text } from "./doc.js";
import { looksLinky } from "./escape.js";
import type { Run } from "./narrative.js";

const t = (s: string): Run => ({ t: s });
const c = (s: string): Run => ({ t: s, c: true as const });
/** A data string: URLs and other link-like text become code (D4: no links from data). */
const d = (s: string): Text => [looksLinky(s) ? c(s) : t(s)];
const cell = (s: string): Text => [t(s)];
const toned = (s: string, tone: "good" | "bad" | undefined): Text => [tone ? { t: s, tone } : t(s)];

export const fmtInt = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : Math.round(n).toLocaleString("en-US"));
export const fmtPct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(digits)}%`);
export const fmtChangeNumber = (n: number | null | undefined, unit = "") => (n === null || n === undefined ? "n/a" : `${n > 0 ? "+" : n < 0 ? "−" : ""}${Math.abs(n).toFixed(1)}${unit}`);
const fmt1 = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : n.toFixed(1));
const fmtCtr = (n: number | null | undefined) => (n === null || n === undefined ? "n/a" : `${n.toFixed(2)}%`);
const signed = (n: number) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${fmtInt(Math.abs(n))}`;

/** A change cell: green when it's good, red when it's bad (`lowerIsBetter` for positions and timings). */
/**
 * A change where lower is better (positions, Core Web Vitals timings): "0.7 better" in green or "0.7 worse" in red,
 * the same wording as the key-figure card, so a minus sign never has to be read as good news.
 */
export function betterCell(n: number | null | undefined, format: (abs: number) => string = (a) => a.toFixed(1), epsilon = 0.05): Text {
  if (n === null || n === undefined) return cell("n/a");
  if (Math.abs(n) < epsilon) return cell("no change");
  return n < 0 ? toned(`${format(Math.abs(n))} better`, "good") : toned(`${format(Math.abs(n))} worse`, "bad");
}

function changeCell(n: number | null | undefined, text: string, lowerIsBetter = false): Text {
  if (n === null || n === undefined || Math.abs(n) < 0.05) return cell(text);
  return toned(text, (n > 0) !== lowerIsBetter ? "good" : "bad");
}

const METRIC_LABEL = { clicks: "Clicks", impressions: "Impressions", ctr: "CTR", position: "Average position" } as const;
type SearchMetric = keyof typeof METRIC_LABEL;

function metricValue(m: SearchMetric, v: number | null | undefined) {
  return m === "ctr" ? fmtCtr(v) : m === "position" ? fmt1(v) : fmtInt(v);
}
function metricChange(m: SearchMetric, vs: ComparedTotals): Text {
  const ch = vs[m].change;
  if (m === "ctr") return changeCell(ch, ch === null ? "n/a" : `${fmtChangeNumber(ch)} pts`);
  if (m === "position") return betterCell(ch);
  return changeCell(ch, fmtPct(ch));
}

/** Shared by the mappers: the client's domain (for page paths), the layout, and notes for "About this report". */
export interface MapContext {
  /** branding.hideCrawlmark: neutral wording instead of crawlmark's name. */
  whiteLabel: boolean;
  domain: string;
  onepage: boolean;
  notes: string[];
  note(text: string): void;
}

/** "/services/emergency" for a URL on the client's own site; anything else stays a full URL (as code). */
export function pagePath(url: string, domain: string): Text {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    if (host === domain.toLowerCase().replace(/^www\./, "")) return d(`${u.pathname}${u.search}`);
  } catch {
    // not a URL: shown as data below
  }
  return [c(url)];
}

/**
 * A section without data, for the client-facing files. A failure's raw error text (provider messages, local
 * paths) stays in the tool result and the CLI's `sectionErrors`; the files only say it couldn't be fetched.
 */
export function statusLine(s: SectionResult): string {
  if (s.status === "error") return `${s.title}: couldn't be fetched for this report.`;
  if (s.status === "unavailable") return `${s.title}: unavailable: ${s.reason}`;
  if (s.status === "skipped") return `${s.title}: skipped: ${s.reason}`;
  return `${s.title}: ok`;
}

/** A coloured change chip for the key figures. */
function kpiDelta(change: number | null | undefined, kind: "pct" | "pts" | "pos"): Delta | undefined {
  if (change === null || change === undefined) return undefined;
  const flat = Math.abs(change) < 0.05;
  const dir = flat ? "flat" : change > 0 ? "up" : "down";
  const good = kind === "pos" ? change < 0 : change > 0;
  const tone = flat ? "neutral" : good ? "good" : "bad";
  const text = kind === "pct" ? `${Math.abs(change).toFixed(1)}%` : kind === "pts" ? `${Math.abs(change).toFixed(1)} pts` : flat ? "0.0" : `${Math.abs(change).toFixed(1)} ${good ? "better" : "worse"}`;
  return { text, dir, tone };
}

/** The key figures: always clicks, impressions, CTR and average position, against the first comparison with data. */
export function keyFigures(report: TemplateReport): Kpi[] {
  const s = report.sections.find((x) => x.type === "search_overview" && x.status === "ok");
  if (!s || s.status !== "ok") return [];
  const data = s.data as SearchOverviewData;
  const vs = data.vsPreviousPeriod?.previous ? data.vsPreviousPeriod : data.vsPreviousYear?.previous ? data.vsPreviousYear : null;
  const prev = vs?.previous;
  return (["clicks", "impressions", "ctr", "position"] as const).map((m) => {
    const delta = vs ? kpiDelta(vs[m].change, m === "ctr" ? "pts" : m === "position" ? "pos" : "pct") : undefined;
    const detail = prev ? (m === "position" ? `from ${fmt1(prev.position)} · lower is better` : `vs ${metricValue(m, prev[m])}`) : m === "position" ? "lower is better" : undefined;
    return { label: METRIC_LABEL[m], value: metricValue(m, data.current[m]), ...(delta ? { delta } : {}), ...(detail ? { detail } : {}) };
  });
}

// ---- Charts ----

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "1 Sep" from an ISO date. */
export const shortDay = (iso: string) => `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}`;

/** Weekly totals for a daily chart's table fallback: the current days in 7-day blocks against the same blocks of the comparison. */
function weeklyTable(label: string, cur: { date: string; v: number }[], prev: { v: number }[] | null, curName: string, prevName: string): TableBlock {
  const rows: Text[][] = [];
  for (let i = 0; i < cur.length; i += 7) {
    const block = cur.slice(i, i + 7);
    const a = block.reduce((s, x) => s + x.v, 0);
    const pb = prev?.slice(i, i + block.length);
    const b = pb && pb.length === block.length ? pb.reduce((s, x) => s + x.v, 0) : null;
    const first = block[0]!.date;
    const last = block.at(-1)!.date;
    const range = first === last ? shortDay(first) : first.slice(5, 7) === last.slice(5, 7) ? `${Number(first.slice(8, 10))}–${shortDay(last)}` : `${shortDay(first)} – ${shortDay(last)}`;
    const ch = b ? ((a - b) / b) * 100 : null;
    rows.push([cell(range), cell(fmtInt(a)), ...(prev ? [cell(b === null ? "n/a" : fmtInt(b)), changeCell(ch, fmtPct(ch))] : [])]);
  }
  return { kind: "table", title: `${label} by week`, header: ["Days", curName, ...(prev ? [prevName, "Change"] : [])], rows, numeric: [false, true, true, true] };
}

function dailyChart(title: string, label: string, cur: { date: string; v: number }[], prev: { v: number }[] | null, curName: string, prevName: string): LineChart {
  const sum = (l: { v: number }[]) => l.reduce((s, x) => s + x.v, 0);
  const prevAligned = prev ? cur.map((_, i) => prev[i]?.v ?? null) : null;
  return {
    type: "line",
    title,
    x: cur.map((p) => p.date),
    format: "count",
    series: [{ name: curName, values: cur.map((p) => p.v), role: "current" }, ...(prevAligned ? [{ name: prevName, values: prevAligned, role: "previous" as const }] : [])],
    summary: `${title}: ${fmtInt(sum(cur))} ${label.toLowerCase()} in ${curName}${prev ? ` against ${fmtInt(sum(prev))} in ${prevName}` : ""}, from ${shortDay(cur[0]!.date)} to ${shortDay(cur.at(-1)!.date)}.`,
    fallback: weeklyTable(label, cur, prev, curName, prevName),
  };
}

// ---- Mappers ----

type Mapper = (data: never, report: TemplateReport, ctx: MapContext) => Block[];

const vsLabel = (report: TemplateReport, which: "previous_period" | "previous_year" | null) => {
  const r = which ? report.period.comparisons[which] : undefined;
  return r ? periodName(r) : "";
};

const moverTable = (title: string, list: MoversData["gainers"], label: string, key: (k: string) => Text, compact: boolean): TableBlock => ({
  kind: "table",
  ...(title ? { title } : {}),
  header: compact ? [label, "Clicks", "Change"] : [label, "Clicks", "Change", "Position"],
  rows: list.map((r) => [key(r.key), cell(fmtInt(r.clicks)), changeCell(r.clicksDelta, signed(r.clicksDelta)), ...(compact ? [] : [cell(fmt1(r.position))])]),
  numeric: [false, true, true, true],
});

function moversBlocks(m: MoversData, label: string, key: (k: string) => Text, ctx: MapContext): Block[] {
  if (ctx.onepage) {
    if (m.gainers.length) return [moverTable("", m.gainers, label, key, true)];
    // The section has data (losers, or no movement at all): say so rather than leaving it out as "no data".
    return [{ kind: "note", text: [t(`No ${label.toLowerCase()} gained clicks this period.`)] }];
  }
  const tables = [m.gainers.length ? moverTable("Gained clicks", m.gainers, label, key, false) : null, m.losers.length ? moverTable("Lost clicks", m.losers, label, key, false) : null].filter((x): x is TableBlock => x !== null);
  if (tables.length === 2) return [{ kind: "columns", columns: tables.map((x) => [x]) }];
  return tables;
}

/** "8.4 → 5.1" (first → latest), or the single value, or "no data". */
const trendText = (sum: RankTrendSummary | undefined) => {
  if (!sum || sum.latest === null) return sum && sum.checks > 0 ? "not found" : "no data";
  return sum.first !== null && sum.firstDay !== sum.latestDay ? `${fmt1(sum.first)} → ${fmt1(sum.latest)}` : fmt1(sum.latest);
};
const PROVIDER_NAME = { dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" } as const;
const KD_LABEL = { dataforseo_kd: "DataForSEO difficulty", ahrefs_kd: "Ahrefs KD", semrush_kd: "Semrush KD" } as const;
const SEVERITY_TAG = { critical: "bad", high: "bad", medium: "warn", low: "neutral" } as const;
const severity = (s: keyof typeof SEVERITY_TAG): Text => [{ t: s, tag: SEVERITY_TAG[s] }];
const CWV_NAMES: Record<CwvMetric, string> = { lcp: "Largest Contentful Paint", inp: "Interaction to Next Paint", cls: "Cumulative Layout Shift", fcp: "First Contentful Paint", ttfb: "Time to First Byte" };
const CWV_SHORT: Record<CwvMetric, string> = { lcp: "LCP", inp: "INP", cls: "CLS", fcp: "FCP", ttfb: "TTFB" };
/** Google's published good / poor thresholds (75th percentile). */
const CWV_BANDS: Record<CwvMetric, { good: number; poor: number }> = { lcp: { good: 2500, poor: 4000 }, inp: { good: 200, poor: 500 }, cls: { good: 0.1, poor: 0.25 }, fcp: { good: 1800, poor: 3000 }, ttfb: { good: 800, poor: 1800 } };
const RATING_TAG = { good: "good", "needs-improvement": "warn", poor: "bad" } as const;

/** "9 Oct 2026" from an ISO date or time. */
const fullDay = (iso: string) => {
  const dt = new Date(iso);
  return Number.isNaN(dt.getTime()) ? iso.slice(0, 10) : `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
};

/** Phase 13: technical-issue source names in report files (no tool names, no product name). */
export const ISSUE_SOURCE_NAMES: Record<IssueSource, string> = {
  audit: "Audit",
  local_crawl: "Site crawl",
  site_hygiene: "Site checks",
  dataforseo_crawl: "DataForSEO crawl",
  gsc_inspection: "Google URL Inspection",
  ahrefs_site_audit: "Ahrefs Site Audit",
  semrush_site_audit: "Semrush Site Audit",
};
const SEVERITY_TITLE = { critical: "Critical", high: "High", medium: "Medium", low: "Low" } as const;
const CHANGE_TAG: Record<TechIssue["change"], Text> = {
  new: [{ t: "new", tag: "bad" }],
  persistent: [{ t: "still open", tag: "neutral" }],
  unverified: [{ t: "not re-checked", tag: "warn" }],
  resolved: [{ t: "resolved", tag: "good" }],
  first_run: [t("")],
};
const foundBy = (i: TechIssue): Text => cell([...new Set(i.sources.map((x) => ISSUE_SOURCE_NAMES[x.source]))].join(", "));
const issueExample = (i: TechIssue, domain: string): Text => {
  const u = i.url ?? i.sources.flatMap((x) => x.examples)[0];
  return u ? pagePath(u, domain) : cell("several pages");
};
// ---- Phase 13 B: provider sections ----

/** A change chip for a count (or a provider's authority score): more is better. */
function countDelta(change: number | null | undefined, pctOf: number | null | undefined): Delta | undefined {
  if (change === null || change === undefined) return undefined;
  if (pctOf !== null && pctOf !== undefined && pctOf > 0) return kpiDelta((change / pctOf) * 100, "pct");
  const flat = Math.abs(change) < 0.05;
  return { text: fmtInt(Math.abs(change)), dir: flat ? "flat" : change > 0 ? "up" : "down", tone: flat ? "neutral" : change > 0 ? "good" : "bad" };
}
/** The first comparison with figures, and its period's name ("August 2026"), or its date when the period isn't known. */
function firstComparison<T>(report: TemplateReport, c: { previous_period?: { asOf: string; previous: T; change: T } | null; previous_year?: { asOf: string; previous: T; change: T } | null }) {
  for (const which of ["previous_period", "previous_year"] as const) {
    const x = c[which];
    if (x) return { which, name: vsLabel(report, which) || fullDay(x.asOf), ...x };
  }
  return null;
}
/** One note when a comparison the report asks for has no stored figures from this provider. */
function missingComparisons(report: TemplateReport, c: Partial<Record<"previous_period" | "previous_year", unknown>>, provider: string, title: string, ctx: MapContext) {
  for (const which of ["previous_period", "previous_year"] as const) {
    if (which in c && c[which] === null && report.period.comparisons[which]) ctx.note(`${title}: no ${provider} figures are stored for ${periodName(report.period.comparisons[which]!)}, so that comparison is left out.`);
  }
}
/** Kept in every file, white label included (the providers' terms ask for attribution). */
const sourceLine = (provider: keyof typeof PROVIDER_NAME, asOf: string, extra = ""): Block => ({ kind: "note", text: [t(`Source: ${PROVIDER_NAME[provider]}. Figures as of ${fullDay(asOf)}${extra}.`)] });
const monthOf = (day: string) => `${MONTHS[Number(day.slice(5, 7)) - 1]} ${day.slice(0, 4)}`;
const signedInt = (n: number | null) => (n === null ? "n/a" : n === 0 ? "no change" : signed(n));
const anyFigure = (o: object) => Object.values(o).some((v) => typeof v === "number");

function backlinksBlocks(data: BacklinksData, report: TemplateReport, ctx: MapContext): Block[] {
  const cur = data.current;
  if (!anyFigure({ r: cur.referringDomains, b: cur.backlinks, a: cur.authority })) return [];
  const cmp = firstComparison<BacklinksNow>(report, data.comparisons);
  const prev = cmp?.previous;
  const tile = (label: string, v: number | null, p: number | null | undefined, ch: number | null | undefined, pct = true): Kpi => {
    const delta = p !== null && p !== undefined && v !== null ? countDelta(ch, pct ? p : null) : undefined;
    return { label, value: fmtInt(v), ...(delta ? { delta } : {}), ...(delta && cmp ? { detail: `vs ${fmtInt(p)} in ${cmp.name}` } : {}) };
  };
  const tiles: Kpi[] = [tile("Referring domains", cur.referringDomains, prev?.referringDomains, cmp?.change.referringDomains)];
  if (cur.backlinks !== null) tiles.push(tile("Backlinks", cur.backlinks, prev?.backlinks, cmp?.change.backlinks));
  // The provider's own scale: the chip shows points, never a percentage, and never against another provider's metric.
  tiles.push({ ...tile(data.authority.label, cur.authority, prev?.authority, cmp?.change.authority, false) });
  const newLost = data.newLostLabel ?? "";
  if (cur.newReferringDomains !== null) tiles.push({ label: "New referring domains", value: fmtInt(cur.newReferringDomains), detail: newLost, ...(cur.newReferringDomains > 0 ? { tone: "good" as const } : {}) });
  if (cur.lostReferringDomains !== null) tiles.push({ label: "Lost referring domains", value: fmtInt(cur.lostReferringDomains), detail: newLost, ...(cur.lostReferringDomains > 0 ? { tone: "bad" as const } : {}) });
  if (cur.newReferringDomains === null && cur.newBacklinks !== null) tiles.push({ label: "New backlinks", value: fmtInt(cur.newBacklinks), detail: newLost });
  if (cur.lostReferringDomains === null && cur.lostBacklinks !== null) tiles.push({ label: "Lost backlinks", value: fmtInt(cur.lostBacklinks), detail: newLost });
  const blocks: Block[] = [{ kind: "kpiRow", items: tiles }];
  const trend = data.trend.filter((p) => p.referringDomains !== null);
  if (trend.length >= 2 && !ctx.onepage) {
    blocks.push({
      kind: "chart",
      chart: {
        type: "line",
        title: "Referring domains by month",
        x: trend.map((p) => p.day),
        series: [{ name: "Referring domains", values: trend.map((p) => p.referringDomains), role: "current" }],
        format: "count",
        connectGaps: true,
        summary: `Referring domains went from ${fmtInt(trend[0]!.referringDomains)} in ${monthOf(trend[0]!.day)} to ${fmtInt(trend.at(-1)!.referringDomains)} in ${monthOf(trend.at(-1)!.day)} (${PROVIDER_NAME[data.provider]}).`,
        fallback: {
          kind: "table",
          title: "Referring domains by month",
          header: ["Month", "Referring domains", ...(trend.some((p) => p.backlinks !== null) ? ["Backlinks"] : []), data.authority.label],
          rows: trend.map((p) => [cell(monthOf(p.day)), cell(fmtInt(p.referringDomains)), ...(trend.some((x) => x.backlinks !== null) ? [cell(fmtInt(p.backlinks))] : []), cell(fmtInt(p.authority))]),
          numeric: [false, true, true, true],
        },
      },
    });
  }
  if (cmp && !ctx.onepage) {
    const row = (label: string, a: number | null, b: number | null, ch: number | null) => [cell(label), cell(fmtInt(a)), cell(fmtInt(b)), changeCell(ch, signedInt(ch))];
    const rows = [row("Referring domains", cur.referringDomains, cmp.previous.referringDomains, cmp.change.referringDomains)];
    if (cur.backlinks !== null || cmp.previous.backlinks !== null) rows.push(row("Backlinks", cur.backlinks, cmp.previous.backlinks, cmp.change.backlinks));
    rows.push(row(data.authority.label, cur.authority, cmp.previous.authority, cmp.change.authority));
    blocks.push({ kind: "table", header: ["Metric", fullDay(data.asOf), cmp.name, "Change"], rows, numeric: [false, true, true, true] });
  }
  missingComparisons(report, data.comparisons, PROVIDER_NAME[data.provider], "Backlinks", ctx);
  for (const n of data.notes) blocks.push({ kind: "note", text: [t(n)] });
  if (cur.newReferringDomains === null && cur.newBacklinks === null && data.provider === "ahrefs") blocks.push({ kind: "note", text: [t("Ahrefs doesn't report new and lost referring domains in these figures, so only the change is shown.")] });
  blocks.push(sourceLine(data.provider, data.asOf, `. ${data.authority.label.replace(/ \(.*\)$/, "")} is ${PROVIDER_NAME[data.provider]}'s own measure; don't compare it with another provider's`));
  return blocks;
}

const BANDS = [
  ["top3", "Top 3"],
  ["pos4_10", "4\u201310"],
  ["pos11_20", "11\u201320"],
  ["pos21_100", "21\u2013100"],
] as const;

function visibilityBlocks(data: VisibilityData, report: TemplateReport, ctx: MapContext): Block[] {
  const cur = data.current;
  if (cur.keywords === null && cur.traffic === null) return [];
  const cmp = firstComparison<VisibilityNow>(report, data.comparisons);
  const tile = (label: string, v: number | null, p: number | null | undefined, ch: number | null | undefined, detail?: string): Kpi => {
    const delta = p !== null && p !== undefined && v !== null ? countDelta(ch, p) : undefined;
    const vs = delta && cmp ? `vs ${fmtInt(p)} in ${cmp.name}` : "";
    const d = [vs, detail].filter(Boolean).join(" · ");
    return { label, value: fmtInt(v), ...(delta ? { delta } : {}), ...(d ? { detail: d } : {}) };
  };
  const tiles: Kpi[] = [tile("Ranking keywords (top 100)", cur.keywords, cmp?.previous.keywords, cmp?.change.keywords)];
  if (data.distributionAvailable && cur.top3 !== null) tiles.push(tile("In the top 3", cur.top3, cmp?.previous.top3, cmp?.change.top3));
  tiles.push(tile("Estimated traffic", cur.traffic, cmp?.previous.traffic, cmp?.change.traffic, data.trafficLabel));
  const blocks: Block[] = [{ kind: "kpiRow", items: tiles }];
  const charts: Block[][] = [];
  const bandsOf = (v: VisibilityNow) => BANDS.map(([k]) => v[k]);
  if (data.distributionAvailable && bandsOf(cur).every((x) => x !== null)) {
    const rows = [{ label: fullDay(data.asOf), values: bandsOf(cur) as number[] }, ...(cmp && bandsOf(cmp.previous).every((x) => x !== null) ? [{ label: cmp.name, values: bandsOf(cmp.previous) as number[] }] : [])];
    charts.push([
      {
        kind: "chart",
        chart: {
          type: "share",
          title: "Keywords by position",
          parts: BANDS.map(([, l]) => l),
          rows,
          summary: `Of ${fmtInt(cur.keywords)} ranking keywords, ${fmtInt(cur.top3)} are in the top 3, ${fmtInt(cur.pos4_10)} in positions 4\u201310, ${fmtInt(cur.pos11_20)} in 11\u201320 and ${fmtInt(cur.pos21_100)} in 21\u2013100.`,
          fallback: { kind: "table", title: "Keywords by position", header: ["Position", ...rows.map((r) => r.label)], rows: BANDS.map(([, l], i) => [cell(l), ...rows.map((r) => cell(fmtInt(r.values[i])))]), numeric: [false, true, true] },
        },
      },
    ]);
  }
  const trend = data.trend.filter((p) => p.keywords !== null);
  if (trend.length >= 2 && !ctx.onepage) {
    charts.push([
      {
        kind: "chart",
        chart: {
          type: "line",
          title: "Ranking keywords by month",
          x: trend.map((p) => p.day),
          series: [{ name: "Ranking keywords", values: trend.map((p) => p.keywords), role: "current" }],
          format: "count",
          connectGaps: true,
          summary: `Ranking keywords went from ${fmtInt(trend[0]!.keywords)} in ${monthOf(trend[0]!.day)} to ${fmtInt(trend.at(-1)!.keywords)} in ${monthOf(trend.at(-1)!.day)} (${PROVIDER_NAME[data.provider]}).`,
          fallback: { kind: "table", title: "Ranking keywords by month", header: ["Month", "Ranking keywords", "Estimated traffic"], rows: trend.map((p) => [cell(monthOf(p.day)), cell(fmtInt(p.keywords)), cell(fmtInt(p.traffic))]), numeric: [false, true, true] },
        },
      },
    ]);
  }
  if (charts.length === 2) blocks.push({ kind: "columns", columns: charts });
  else for (const c of charts) blocks.push(...c);
  if (cmp && !ctx.onepage) {
    const rows: Text[][] = [];
    const add = (label: string, a: number | null, b: number | null, ch: number | null) => rows.push([cell(label), cell(fmtInt(a)), cell(fmtInt(b)), changeCell(ch, signedInt(ch))]);
    add("Ranking keywords (top 100)", cur.keywords, cmp.previous.keywords, cmp.change.keywords);
    if (data.distributionAvailable) for (const [k, l] of BANDS) add(`Positions ${l === "Top 3" ? "1\u20133" : l}`, cur[k], cmp.previous[k], cmp.change[k]);
    add("Estimated traffic", cur.traffic, cmp.previous.traffic, cmp.change.traffic);
    blocks.push({ kind: "table", header: ["Keywords", fullDay(data.asOf), cmp.name, "Change"], rows, numeric: [false, true, true, true] });
  }
  missingComparisons(report, data.comparisons, PROVIDER_NAME[data.provider], "Organic search visibility", ctx);
  for (const n of data.notes) blocks.push({ kind: "note", text: [t(n)] });
  blocks.push(sourceLine(data.provider, data.asOf, `. Estimated traffic is ${data.trafficLabel}, a modelled figure; it isn't comparable with Google Analytics or another provider`));
  return blocks;
}

/** A location code means "the client's market"; a country or database is shown uppercase. */
const marketName = (m: string) => (/^\d+$/.test(m) ? "the client's market" : m.toUpperCase());

function competitorBlocks(data: CompetitorOverviewData, _report: TemplateReport, ctx: MapContext): Block[] {
  if (!data.competitors.length) return [];
  const origin: Record<CompetitorRow["origin"], string> = { client: "This site", saved: "Saved", suggested: "Suggested" };
  const rows = [data.client, ...data.competitors];
  const missing = data.competitors.some((r) => !r.inProviderList);
  const ch = (r: CompetitorRow) => (r.keywordsChange === null ? [] : [t(" "), ...changeCell(r.keywordsChange, `(${signed(r.keywordsChange)})`)]);
  const blocks: Block[] = [
    { kind: "paragraph", text: [t(`Organic competitors in ${marketName(data.market)} (${PROVIDER_NAME[data.provider]} data, as of ${fullDay(data.asOf)}); saved competitors first.`)] },
    {
      kind: "table",
      header: ["Domain", "", "Shared keywords", "Their ranking keywords", "Est. traffic"],
      rows: rows.map((r) => [
        r.origin === "client" ? [{ t: r.domain, c: true as const, b: true as const }] : [c(r.domain)],
        r.origin === "client" ? [{ t: origin.client, tag: "neutral" as const }] : cell(origin[r.origin]),
        cell(r.origin === "client" ? "\u2014" : r.inProviderList ? fmtInt(r.commonKeywords) : "n/a"),
        [t(fmtInt(r.keywords)), ...ch(r)],
        cell(fmtInt(r.traffic)),
      ]),
      numeric: [false, false, true, true, true],
      bar: { col: 2, values: rows.map((r) => (r.origin === "client" ? 0 : (r.commonKeywords ?? 0))) },
    },
  ];
  if (missing) blocks.push({ kind: "note", text: [t(`"n/a": not among ${PROVIDER_NAME[data.provider]}'s top ${fmtInt(data.providerListSize)} competitors for this site, so shared keywords aren't known; its own figures were looked up separately.`)] });
  for (const n of data.notes) blocks.push({ kind: "note", text: [t(n)] });
  if (data.competitors.some((r) => r.keywordsChange !== null)) blocks.push({ kind: "note", text: [t("The change in brackets is ranking keywords against the previous period's stored figures.")] });
  void ctx;
  blocks.push(sourceLine(data.provider, data.asOf, `. Estimated traffic is ${data.trafficLabel}`));
  return blocks;
}

/** The most Search Console reasons listed per table in the indexing section. */
export const REASON_ROWS_MAX = 50;
/** The most coverage states shown in the indexing share chart before the rest are grouped as "Other". */
export const COVERAGE_PARTS = 6;

export const SECTION_MAPPERS: Record<string, Mapper> = {
  // Phase 13 B: provider figures (DataForSEO, Ahrefs or Semrush), one provider per section, never mixed.
  backlinks: (data: BacklinksData, report, ctx) => backlinksBlocks(data, report, ctx),
  organic_visibility: (data: VisibilityData, report, ctx) => visibilityBlocks(data, report, ctx),
  competitor_overview: (data: CompetitorOverviewData, report, ctx) => competitorBlocks(data, report, ctx),
  search_overview: (data: SearchOverviewData, report, ctx) => {
    const blocks: Block[] = [];
    const cur = periodName(report.period.current);
    const daily = data.daily;
    if (daily && daily.current.length >= 2) {
      const prevName = daily.comparedWith ? vsLabel(report, daily.comparedWith) : "";
      const clicks = dailyChart("Clicks per day", "Clicks", daily.current.map((p) => ({ date: p.date, v: p.clicks })), daily.previous?.map((p) => ({ v: p.clicks })) ?? null, cur, prevName);
      if (ctx.onepage) return [{ kind: "chart", chart: clicks }];
      const impressions = dailyChart("Impressions per day", "Impressions", daily.current.map((p) => ({ date: p.date, v: p.impressions })), daily.previous?.map((p) => ({ v: p.impressions })) ?? null, cur, prevName);
      blocks.push({ kind: "columns", columns: [[{ kind: "chart", chart: clicks }], [{ kind: "chart", chart: impressions }]] });
    }
    // One page shows only the clicks chart; without the daily rows (a failed or short daily fetch) it says so in one line.
    if (ctx.onepage) return blocks.length ? blocks : [{ kind: "note", text: [t("Clicks per day weren't available for this report.")] }];
    // A comparison column only when that period has data; otherwise one note (unless the fetch failure already has one).
    const usable = (which: "previous_period" | "previous_year", vs: ComparedTotals | null) => {
      const r = report.period.comparisons[which];
      if (!r) return null;
      if (vs?.previous && vs.previous.impressions > 0) return { name: periodName(r), vs };
      if (!report.notes.some((n) => n.includes(`the ${which === "previous_period" ? "previous period" : "previous year"} comparison couldn't be fetched`))) {
        ctx.note(`Search Console has no data for ${periodName(r)}, so that comparison is left out.`);
      }
      return null;
    };
    const cols = [usable("previous_period", data.vsPreviousPeriod), usable("previous_year", data.vsPreviousYear)].filter((x): x is NonNullable<typeof x> => x !== null);
    const header = ["Metric", cur, ...cols.flatMap((x) => [x.name, "Change"])];
    const rows = data.metrics.map((m) => [cell(METRIC_LABEL[m]), cell(metricValue(m, data.current[m])), ...cols.flatMap((x) => [cell(metricValue(m, x.vs.previous![m])), metricChange(m, x.vs)])]);
    blocks.push({ kind: "table", header, rows, numeric: header.map((_, i) => i > 0) });
    if (data.metrics.includes("position")) blocks.push({ kind: "note", text: [t("Average position: lower is better.")] });
    return blocks;
  },
  branded_split: (data: BrandedSplitData, report, ctx) => {
    const prev = vsLabel(report, data.comparedWith);
    const hasPrev = Boolean(prev) && data.branded.previous.clicks + data.nonBranded.previous.clicks > 0;
    const cur = periodName(report.period.current);
    const share = data.brandedShareOfClicks;
    const blocks: Block[] = [];
    if (share.current !== null) {
      const rows = [{ label: cur, values: [data.branded.current.clicks, data.nonBranded.current.clicks] }, ...(hasPrev && share.previous !== null ? [{ label: prev, values: [data.branded.previous.clicks, data.nonBranded.previous.clicks] }] : [])];
      blocks.push({
        kind: "chart",
        chart: {
          type: "share",
          title: "Share of clicks",
          parts: ["Branded", "Non-branded"],
          rows,
          summary: `Branded queries brought ${share.current.toFixed(1)}% of clicks in ${cur}${hasPrev && share.previous !== null ? ` (${share.previous.toFixed(1)}% in ${prev})` : ""}.`,
        },
      });
    }
    const row = (label: string, s: BrandedSplitData["branded"]) => [cell(label), cell(fmtInt(s.current.clicks)), ...(hasPrev ? [changeCell(s.change.clicks, fmtPct(s.change.clicks))] : []), cell(fmtInt(s.current.impressions)), cell(fmtCtr(s.current.ctr)), cell(fmt1(s.current.position))];
    const header = ["Queries", "Clicks", ...(hasPrev ? [`Change vs ${prev}`] : []), "Impressions", "CTR", "Average position"];
    blocks.push({ kind: "table", header, rows: [row("Branded", data.branded), row("Non-branded", data.nonBranded)], numeric: header.map((_, i) => i > 0) });
    blocks.push({ kind: "paragraph", text: [t(`Branded share of clicks: ${share.current === null ? "n/a" : `${share.current.toFixed(1)}%`}${hasPrev && share.previous !== null ? ` (${share.previous.toFixed(1)}% in ${prev})` : ""}.`)] });
    if (data.brandTerms.length) blocks.push({ kind: "note", text: [t(`Branded means the query contains ${data.brandTerms.join(", ")}, the domain or the business name.`)] });
    if (data.queryRows.current >= data.queryRows.limit || data.queryRows.previous >= data.queryRows.limit) ctx.note(`Search Console returned its row limit (${fmtInt(data.queryRows.limit)} queries), so the long tail is missing from the branded split.`);
    return blocks;
  },
  organic_traffic: (data: OrganicTrafficData, report, ctx) => {
    const prev = vsLabel(report, data.comparedWith);
    const labels = { sessions: "Sessions", users: "Users", engagementRate: "Engagement rate", keyEvents: "Key events" } as const;
    const val = (m: keyof typeof labels, v: number | undefined) => (v === undefined ? "n/a" : m === "engagementRate" ? `${v.toFixed(1)}%` : fmtInt(v));
    const items: Kpi[] = data.metrics.map((m) => {
      const delta = data.previous ? kpiDelta(data[m].change, m === "engagementRate" ? "pts" : "pct") : undefined;
      return { label: labels[m], value: val(m, data[m].value), ...(delta ? { delta } : {}), ...(data.previous ? { detail: `vs ${val(m, data.previous[m])}` } : {}) };
    });
    const blocks: Block[] = [{ kind: "kpiRow", items }];
    if (data.daily && data.daily.current.length >= 2 && !ctx.onepage) {
      const prevName = data.daily.comparedWith ? vsLabel(report, data.daily.comparedWith) : "";
      blocks.push({ kind: "chart", chart: dailyChart("Organic sessions per day", "Sessions", data.daily.current.map((p) => ({ date: p.date, v: p.sessions })), data.daily.previous?.map((p) => ({ v: p.sessions })) ?? null, periodName(report.period.current), prevName) });
    }
    if (prev && data.previous) blocks.push({ kind: "note", text: [t(`Organic search visits from Google Analytics, compared with ${prev}.`)] });
    return blocks;
  },
  top_queries: (data: TopRowsData) => {
    if (!data.rows.length) return [];
    return [
      {
        kind: "table",
        header: ["Query", "Clicks", "Impressions", "CTR", "Position"],
        rows: data.rows.map((r) => [[...d(r.keys[0] ?? ""), ...(r.branded ? [{ t: "brand", tag: "neutral" as const }] : [])], cell(fmtInt(r.clicks)), cell(fmtInt(r.impressions)), cell(fmtCtr(r.ctr)), cell(fmt1(r.position))]),
        numeric: [false, true, true, true, true],
        bar: { col: 1, values: data.rows.map((r) => r.clicks) },
      },
      ...(data.intent === "local"
        ? [{ kind: "note" as const, text: [t(data.intentFallback ? "No local-intent searches (such as \"near me\" or the town's name) this period, so these are the top searches overall." : "Local-intent searches: \"near me\", \"open now\" and the like, or the town's name.")] }]
        : []),
    ];
  },
  query_movers: (data: MoversData, _r, ctx) => moversBlocks(data, "Query", d, ctx),
  page_movers: (data: MoversData, _r, ctx) => moversBlocks(data, "Page", (k) => pagePath(k, ctx.domain), ctx),
  top_pages: (data: TopRowsData, _r, ctx) => {
    if (!data.rows.length) return [];
    return [
      {
        kind: "table",
        header: ["Page", "Clicks", "Impressions", "CTR", "Position"],
        rows: data.rows.map((r) => [pagePath(r.keys[0] ?? "", ctx.domain), cell(fmtInt(r.clicks)), cell(fmtInt(r.impressions)), cell(fmtCtr(r.ctr)), cell(fmt1(r.position))]),
        numeric: [false, true, true, true, true],
        bar: { col: 1, values: data.rows.map((r) => r.clicks) },
      },
    ];
  },
  landing_pages: (data: LandingPagesData, _r, ctx) => {
    if (!data.rows.length) return [];
    const path = (s: string) => (/^https?:\/\//i.test(s) ? pagePath(s, ctx.domain) : d(s));
    return [
      {
        kind: "table",
        header: ["Landing page", "Sessions", "Engagement rate", "Key events"],
        rows: data.rows.map((r) => [path(String(r.landingPagePlusQueryString ?? "")), cell(fmtInt(Number(r.sessions ?? 0))), cell(`${(Number(r.engagementRate ?? 0) * 100).toFixed(1)}%`), cell(fmtInt(Number(r.keyEvents ?? 0)))]),
        numeric: [false, true, true, true],
        bar: { col: 1, values: data.rows.map((r) => Number(r.sessions ?? 0)) },
      },
    ];
  },
  tracked_keywords: (data: TrackedKeywordsData, report) => {
    if (!data.keywords.length) return [];
    const live = data.liveRanks?.available === true;
    const prev = vsLabel(report, data.comparedWith) && data.keywords.some((k) => k.gscPositionPrevious !== null) ? vsLabel(report, data.comparedWith) : "";
    const header = ["Keyword", "Average position", ...(prev ? [prev, "Change"] : []), "Clicks", "Impressions", ...(live ? ["Live rank"] : [])];
    const rows = data.keywords.map((k) => [
      d(k.keyword),
      cell(k.gscPosition === null ? "no impressions" : fmt1(k.gscPosition)),
      ...(prev ? [cell(fmt1(k.gscPositionPrevious)), betterCell(k.positionChange)] : []),
      cell(fmtInt(k.gscClicks)),
      cell(fmtInt(k.gscImpressions)),
      ...(live ? [cell(k.liveRank === null ? "not in the top 100" : String(k.liveRank))] : []),
    ]);
    return [
      { kind: "table", header, rows, numeric: header.map((_, i) => i > 0) },
      { kind: "note", text: [t("Search Console average position; lower is better.")] },
      ...(data.liveRanks && !data.liveRanks.available ? [{ kind: "note" as const, text: [t("Live ranks weren't available for this report.")] }] : []),
    ];
  },
  opportunities: (data: OpportunityLists, _r, ctx) => {
    const sd = data.strikingDistance.top;
    const lc = data.lowCtr.top;
    const cn = data.cannibalization.top;
    const page = (u: string) => pagePath(u, ctx.domain);
    const ESTIMATE = "Estimated extra clicks assume a typical click-through rate for a higher position; treat them as a guide, not a forecast.";
    if (ctx.onepage) {
      const all = [
        ...sd.map((r) => ({ kind: "Near page one", query: r.query, page: r.topPage, extra: r.estimatedExtraClicks })),
        ...lc.map((r) => ({ kind: "Low CTR", query: r.query, page: r.page, extra: r.estimatedExtraClicks })),
      ]
        .sort((a, b) => b.extra - a.extra)
        .slice(0, Math.max(sd.length, lc.length, 3));
      if (!all.length) return [];
      return [
        { kind: "table", header: ["Query", "Opportunity", "Est. clicks"], rows: all.slice(0, 3).map((o) => [d(o.query), cell(o.kind), cell(fmtInt(o.extra))]), numeric: [false, false, true] },
        { kind: "note", text: [t("Estimated clicks are a guide from typical click-through rates, not a forecast.")] },
      ];
    }
    const blocks: Block[] = [];
    const found = (n: number, shown: number) => (n > shown ? ` (top ${shown} of ${n})` : "");
    if (sd.length) blocks.push({ kind: "table", title: `Close to page one${found(data.strikingDistance.total, sd.length)}`, header: ["Query", "Page", "Position", "Impressions", "Est. extra clicks"], rows: sd.map((r) => [d(r.query), page(r.topPage), cell(fmt1(r.position)), cell(fmtInt(r.impressions)), cell(fmtInt(r.estimatedExtraClicks))]), numeric: [false, false, true, true, true] });
    if (lc.length) blocks.push({ kind: "table", title: `Ranking well but few clicks${found(data.lowCtr.total, lc.length)}`, header: ["Query", "Page", "Position", "CTR", "Typical CTR", "Est. extra clicks"], rows: lc.map((r) => [d(r.query), page(r.page), cell(fmt1(r.position)), cell(fmtCtr(r.ctr)), cell(fmtCtr(r.expectedCtr)), cell(fmtInt(r.estimatedExtraClicks))]), numeric: [false, false, true, true, true, true] });
    if (cn.length) {
      blocks.push({
        kind: "table",
        title: `Pages competing for the same query${found(data.cannibalization.total, cn.length)}`,
        header: ["Query", "Pages (share of impressions)", "Impressions"],
        rows: cn.map((r) => [d(r.query), r.pages.flatMap((p, i) => [...(i ? [t(", ")] : []), ...pagePath(p.page, ctx.domain), t(` (${Math.round(p.impressionShare * 100)}%)`)]), cell(fmtInt(r.totalImpressions))]),
        numeric: [false, false, true],
      });
    }
    if (!blocks.length) return [];
    blocks.push({ kind: "note", text: [t(ESTIMATE)] });
    return blocks;
  },
  audit_changes: (data: AuditChangesData, _r, ctx) => {
    const cmp = data.comparison;
    if (!cmp) return [];
    const k = cmp.diff.counts;
    const top = cmp.diff.new.slice(0, data.limit);
    const day = (iso: string) => {
      const dt = new Date(iso);
      return Number.isNaN(dt.getTime()) ? iso.slice(0, 10) : `${dt.getUTCDate()} ${MONTHS[dt.getUTCMonth()]} ${dt.getUTCFullYear()}`;
    };
    return [
      {
        kind: "kpiRow",
        items: [
          { label: "Resolved", value: fmtInt(k.resolved), ...(k.resolved > 0 ? { tone: "good" as const } : {}) },
          { label: "New", value: fmtInt(k.new), ...(k.new > 0 ? { tone: "bad" as const } : {}) },
          { label: "Still open", value: fmtInt(k.persistent) },
          { label: "Not re-checked", value: fmtInt(k.unverified) },
        ],
      },
      { kind: "paragraph", text: [t(`The latest audit (${day(cmp.ranAt)}) compared with the one before it (${day(cmp.diff.base.ranAt)}).`)] },
      ...(top.length ? [{ kind: "table" as const, title: "New findings", header: ["Severity", "Finding", "Page"], rows: top.map((f) => [severity(f.severity), d(f.title), pagePath(f.url, ctx.domain)]) }] : []),
      ...(cmp.diff.scoreChanges.length
        ? [
            {
              kind: "table" as const,
              title: "Lighthouse score changes",
              header: ["Page", "Category", "Before", "After", "Change"],
              rows: cmp.diff.scoreChanges.map((s) => [pagePath(s.url, ctx.domain), cell(s.category), cell(String(s.from)), cell(String(s.to)), changeCell(s.to - s.from, signed(s.to - s.from))]),
              numeric: [false, false, true, true, true],
            },
          ]
        : []),
      ...(k.unverified > 0 ? [{ kind: "note" as const, text: [t("Findings that weren't re-checked in the latest audit are listed as not re-checked, never as fixed.")] }] : []),
    ];
  },
  core_web_vitals_history: (data: CruxHistoryResult) => {
    if (!data.available) return [];
    const val = (u: "ms" | "score", v: number | null) => (v === null ? "n/a" : u === "score" ? v.toFixed(2) : `${fmtInt(v)} ms`);
    const first = data.periods[0];
    const last = data.periods.at(-1);
    const metrics = (Object.keys(CWV_NAMES) as CwvMetric[]).filter((m) => data.metrics[m]);
    const charts: Block[][] = metrics
      .filter((m) => ["lcp", "inp", "cls"].includes(m) && data.metrics[m]!.p75.filter((v) => v !== null).length >= 2)
      .map((m) => {
        const s = data.metrics[m]!;
        const chart: LineChart = {
          type: "line",
          title: `${CWV_SHORT[m]} · ${CWV_NAMES[m]}`,
          x: data.periods.map((p) => p.end),
          series: [{ name: CWV_SHORT[m], values: s.p75, role: "current" }],
          format: s.unit === "score" ? "score" : "ms",
          bands: CWV_BANDS[m],
          connectGaps: true,
          summary: `${CWV_NAMES[m]} for real users went from ${val(s.unit, s.first)} to ${val(s.unit, s.latest)} over ${data.periods.length} weekly periods.`,
        };
        return [{ kind: "chart", chart }];
      });
    const rows = metrics.map((m) => {
      const s = data.metrics[m]!;
      const rating = [...s.rating].reverse().find((r) => r !== null) ?? null;
      return [cell(CWV_NAMES[m]), cell(val(s.unit, s.first)), cell(val(s.unit, s.latest)), betterCell(s.change, (a) => (s.unit === "score" ? a.toFixed(2) : `${fmtInt(a)} ms`), s.unit === "score" ? 0.005 : 0.5), rating ? [{ t: rating.replace("-", " "), tag: RATING_TAG[rating] }] : cell("n/a"), cell(s.trend.replace("-", " "))];
    });
    const key = data.key.url ?? data.key.origin ?? "";
    return [
      { kind: "paragraph", text: [t("Real-user 75th percentile for "), c(key), t(` (${data.key.formFactor.toLowerCase()}), ${data.periods.length} weekly periods${first && last ? ` from ${first.end} to ${last.end}` : ""}.`)] },
      ...(charts.length ? [{ kind: "columns" as const, columns: charts }] : []),
      { kind: "table", header: ["Metric", "First period", "Latest period", "Change", "Rating now", "Trend"], rows, numeric: [false, true, true, true, false, false] },
      { kind: "note", text: [t("From the Chrome UX Report: each period is a 28-day window, updated weekly. Lower is better for every metric. Where charts are shown, the shaded bands are Google's thresholds: green is good, amber needs improvement, red is poor.")] },
    ];
  },
  tag_manager: (data: TagManagerData) => [
    { kind: "paragraph", text: [t("Container "), c(data.container.publicId), t(` (${data.container.name})${data.liveVersion ? `, live version ${data.liveVersion.versionId}` : ", never published"}: ${data.summary.tags} tags, ${data.summary.triggers} triggers, ${data.summary.variables} variables, ${data.summary.findings} findings.`)] },
    ...(data.findings.length ? [{ kind: "table" as const, header: ["Severity", "Finding", "Item"], rows: data.findings.map((f) => [severity(f.severity), d(f.title), d(`${f.entity.kind} ${f.entity.name}`)]) }] : []),
    // Notes can carry Tag Manager API error text; the files only say what kind of note it is.
    ...data.notes.map((n) => ({ kind: "note" as const, text: [t(/^Unpublished changes incomplete/.test(n) ? "Unpublished changes: some workspaces couldn't be read." : n.startsWith("This container has never been published") ? n : "A Tag Manager note couldn't be shown in this report.")] })),
  ],
  data_spend: (data: DataSpendData, _r, ctx) => [
    { kind: "paragraph", text: [t(`Paid data used this calendar month (${data.month}, ${ctx.whiteLabel ? "all paid data" : "all of crawlmark"} for this client): DataForSEO $${data.usd.toFixed(2)}, Ahrefs ${fmtInt(data.units.ahrefs)} units, Semrush ${fmtInt(data.units.semrush)} units.`)] },
  ],
  text: (data: TextData) => [{ kind: "paragraph", text: [t(data.text)] }],
  // Phase 12 B: stored rank history, first → latest, with a chart of the stored points when there are some.
  rank_trend: (data: RankTrendData) => {
    // A source's columns only when some keyword has checks from it.
    const gsc = data.source !== "serp" && data.keywords.some((k) => (k.gsc?.checks ?? 0) > 0);
    const serp = data.source !== "gsc" && data.keywords.some((k) => (k.serp?.checks ?? 0) > 0);
    const blocks: Block[] = [{ kind: "paragraph", text: [t(`Stored checks from ${data.since} to ${data.until}, first → latest. Lower is better.`)] }];
    // Chart: Search Console positions for up to five keywords that have at least two stored points.
    const charted = data.keywords.filter((k) => (k.series?.gsc ?? []).filter((p) => p.rank !== null).length >= 2).slice(0, 5);
    if (gsc && charted.length) {
      const days = [...new Set(charted.flatMap((k) => k.series!.gsc!.map((p) => p.day)))].sort();
      blocks.push({
        kind: "chart",
        chart: {
          type: "line",
          title: "Average position over time",
          x: days,
          series: charted.map((k, i) => {
            const byDay = new Map(k.series!.gsc!.map((p) => [p.day, p.rank]));
            return { name: k.keyword, values: days.map((dd) => byDay.get(dd) ?? null), role: "series" as const, index: i };
          }),
          format: "position",
          invert: true,
          connectGaps: true,
          summary: `Search Console average position for ${charted.length} tracked keyword${charted.length === 1 ? "" : "s"} from ${data.since} to ${data.until}; position 1 is at the top.`,
        },
      });
    }
    const header = ["Keyword", ...(gsc ? ["Search Console average position", "Change"] : []), ...(serp ? ["Live rank", "Change"] : [])];
    const rows = data.keywords.map((k) => [
      d(k.keyword),
      ...(gsc ? [cell(trendText(k.gsc)), betterCell(k.gsc?.change)] : []),
      ...(serp ? [cell(trendText(k.serp)), betterCell(k.serp?.change)] : []),
    ]);
    blocks.push(
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
    );
    return blocks;
  },
  // Phase 12 C1: the newest saved local crawl.
  site_crawl: (data: SiteCrawlData, _r, ctx) => {
    const s = data.summary;
    const issue = (label: string, n: number): Kpi => ({ label, value: fmtInt(n), ...(n > 0 ? { tone: "bad" as const } : {}) });
    const tiles: Kpi[] = [
      { label: "Pages fetched", value: fmtInt(data.pages) },
      issue("Broken internal links", s.brokenLinks),
      { label: "Redirects", value: fmtInt(s.redirects) },
      issue("Missing titles", s.missingTitles),
      issue("Duplicate titles", s.duplicateTitles),
      issue("Missing meta descriptions", s.missingDescriptions),
      issue("Duplicate meta descriptions", s.duplicateDescriptions),
      issue("Canonical issues", s.canonicalIssues),
      { label: "Noindex pages", value: fmtInt(s.noindex) },
      s.orphans.available ? issue("Orphan pages (in a sitemap, not linked)", s.orphans.count) : { label: "Orphan pages (in a sitemap, not linked)", value: "not judged" },
    ];
    return [
      {
        kind: "paragraph",
        text: [t(`${ctx.whiteLabel ? "A crawl of the site" : "crawlmark's own crawl of the site"} on ${data.ranAt.slice(0, 10)}: ${fmtInt(data.pages)} pages, ${data.exhaustive ? "complete (every internal link found was followed)" : "stopped at a cap (not every page was reached)"}. ${fmtInt(data.findingCount)} issues found.`)],
      },
      { kind: "kpiRow", items: tiles },
      ...(data.issues.length ? [{ kind: "table" as const, title: "Top issues", header: ["Severity", "Issue", "URL"], rows: data.issues.map((i) => [severity(i.severity), cell(i.title), [c(i.url)]]) }] : []),
      ...(s.orphans.available ? [] : [{ kind: "note" as const, text: [t(`Orphan pages weren't judged: ${s.orphans.reason}.`)] }]),
      { kind: "note", text: [t("Crawled without JavaScript rendering, obeying robots.txt. Issue counts are pages.")] },
    ];
  },
  // Phase 12 C3: Bing Webmaster Tools for the report period. Queries and URLs are Bing's (stripControl'd); URLs render as code.
  bing_overview: (data: BingOverviewData) => {
    const prev = data.previous;
    const cmp = data.comparedWith?.which === "previous_year" ? "previous year" : "previous period";
    const rows: Text[][] = [
      [cell("Clicks"), cell(fmtInt(data.totals.clicks)), ...(prev ? [cell(fmtInt(prev.clicks)), changeCell(data.totals.change.clicks, fmtPct(data.totals.change.clicks))] : [])],
      [cell("Impressions"), cell(fmtInt(data.totals.impressions)), ...(prev ? [cell(fmtInt(prev.impressions)), changeCell(data.totals.change.impressions, fmtPct(data.totals.change.impressions))] : [])],
      [cell("CTR"), cell(fmtCtr(data.totals.ctr)), ...(prev ? [cell(fmtCtr(prev.ctr)), changeCell(data.totals.change.ctr, data.totals.change.ctr === null ? "n/a" : `${fmtChangeNumber(data.totals.change.ctr)} pts`)] : [])],
    ];
    const latest = data.crawl.latest;
    return [
      { kind: "paragraph", text: [t("Bing Webmaster Tools data for "), c(data.site), t(` from ${data.window.startDate} to ${data.window.endDate}${data.comparedWith ? `, compared with the ${cmp} (${data.comparedWith.range.startDate} to ${data.comparedWith.range.endDate})` : ""}.`)] },
      { kind: "table", header: ["Metric", "This period", ...(prev ? [`The ${cmp}`, "Change"] : [])], rows, numeric: [false, true, true, true] },
      ...(data.topQueries.length
        ? [{ kind: "table" as const, title: "Top queries on Bing", header: ["Query", "Clicks", "Impressions", "Average position"], rows: data.topQueries.map((q) => [d(q.query), cell(fmtInt(q.clicks)), cell(fmtInt(q.impressions)), cell(fmt1(q.avgPosition))]), numeric: [false, true, true, true] }]
        : [{ kind: "note" as const, text: [t("Bing has no query stats for this period yet.")] }]),
      ...(data.topPages.length
        ? [{ kind: "table" as const, title: "Top pages on Bing", header: ["Page", "Clicks", "Impressions", "Average position"], rows: data.topPages.map((p) => [d(p.page), cell(fmtInt(p.clicks)), cell(fmtInt(p.impressions)), cell(fmt1(p.avgPosition))]), numeric: [false, true, true, true] }]
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
      if (l.brokenLinks.length) blocks.push({ kind: "table", title: "Links in llms.txt that don't return 200", header: ["Linked URL", "HTTP status"], rows: l.brokenLinks.map((b) => [[c(b.url)], cell(String(b.status))]), numeric: [false, true] });
    }
    const cr = data.crawlers;
    if (!cr.checked) blocks.push({ kind: "paragraph", text: [t("AI crawler access couldn't be checked in that audit (robots.txt couldn't be read).")] });
    else {
      const PURPOSE = { search: "AI search", user: "Answers a user's question", training: "Training only" } as const;
      const ACCESS = { allowed: "Allowed", partial: "Partly blocked", blocked: "Blocked (whole site)" } as const;
      const ACCESS_TAG = { allowed: "good", partial: "warn", blocked: "bad" } as const;
      if (!cr.robotsFound) blocks.push({ kind: "paragraph", text: [t("The site has no robots.txt, so every crawler is allowed.")] });
      blocks.push({
        kind: "table",
        title: "AI crawler access",
        header: ["Crawler", "Purpose", "robots.txt group", "Homepage", "Other key pages blocked", "Overall"],
        rows: cr.rows.map((r) => [cell(`${r.bot} (${r.vendor})`), cell(PURPOSE[r.purpose]), cell(r.group === "named" ? "its own" : r.group === "*" ? "* (all crawlers)" : "none"), cell(r.homepage === "allowed" ? "Allowed" : "Blocked"), cell(`${fmtInt(r.blockedKeyPages)} of ${fmtInt(cr.keyPages)}`), [{ t: ACCESS[r.access], tag: ACCESS_TAG[r.access] }]]),
      });
      blocks.push({ kind: "note", text: [t("Blocking an AI search crawler keeps the site out of that product's answers; blocking a training-only crawler is a legitimate choice and has no effect on search. ChatGPT-User and Perplexity-User may not follow robots.txt.")] });
    }
    blocks.push({ kind: "note", text: [t("llms.txt is a proposed standard (llmstxt.org). Google says Google Search doesn't use it, so it's reported for information, not scored.")] });
    return blocks;
  },
  // Phase 12 C4: the confirmed Google Business Profile and map-pack positions. Listing text is Google's (stripControl'd and
  // escaped as data, never followed as instructions); the website renders as code. No review text is ever included.
  local_profile: (data: LocalProfileData, _r, ctx) => {
    const b = data.business;
    const checked = data.pack.filter((p) => !p.failed);
    const inPack = checked.filter((p) => p.clientRank !== null && p.clientRank <= 3).length;
    const tiles: Kpi[] = [
      { label: "Google rating", value: b.rating === null ? "n/a" : b.rating.toFixed(1), ...(b.votes !== null ? { detail: `from ${fmtInt(b.votes)} reviews` } : {}) },
      { label: "Reviews", value: fmtInt(b.votes) },
      ...(checked.length ? [{ label: "Map pack (top 3)", value: `${inPack} of ${checked.length}`, detail: "tracked keywords", ...(inPack === checked.length ? { tone: "good" as const } : {}) }] : []),
      { label: "Photos", value: fmtInt(b.totalPhotos) },
    ];
    const facts: Text[][] = [
      [cell("Business"), b.title ? d(b.title) : cell("n/a")],
      [cell("Category"), b.category ? d(b.category) : cell("n/a")],
      [cell("Rating"), cell(b.rating === null ? "n/a" : `${b.rating.toFixed(1)} from ${fmtInt(b.votes)} reviews`)],
      [cell("Profile claimed"), b.isClaimed === null ? cell("n/a") : [{ t: b.isClaimed ? "yes" : "no", tag: b.isClaimed ? "good" : "bad" }]],
      ...(b.url ? [[cell("Website"), [c(b.url)]]] : []),
    ];
    const dist = b.ratingDistribution;
    const factsTable: TableBlock = { kind: "table", title: "Business profile", header: ["", "Value"], rows: facts, numeric: [false, false] };
    const starsTable: TableBlock | null = dist
      ? { kind: "table", title: "Reviews by stars", header: ["Stars", "Reviews"], rows: (["5", "4", "3", "2", "1"] as const).map((k) => [cell(`${k} stars`), cell(fmtInt(dist[k]))]), numeric: [false, true], bar: { col: 1, values: (["5", "4", "3", "2", "1"] as const).map((k) => dist[k]) } }
      : null;
    const where = /^\d+$/.test(data.location) ? "the client's market" : data.location.split(",").map((p) => p.trim()).join(", ");
    const blocks: Block[] = [
      { kind: "paragraph", text: [t("Google Business Profile, and Google Maps positions searched in "), ...d(where), t(".")] },
      { kind: "kpiRow", items: tiles },
      starsTable ? { kind: "columns", columns: [[factsTable], [starsTable]] } : factsTable,
    ];
    if (data.pack.length) {
      blocks.push({
        kind: "table",
        title: "Google Maps positions",
        header: ["Keyword", "Map position", "First place"],
        rows: data.pack.map((p) => [
          d(p.keyword),
          p.failed ? cell("couldn't be checked") : p.clientRank === null ? cell("not in the results") : p.clientRank <= 3 ? [t(String(p.clientRank)), { t: "in the pack", tag: "good" }] : cell(String(p.clientRank)),
          p.leader?.title ? d(p.leader.title) : cell("n/a"),
        ]),
        numeric: [false, true, false],
      });
    }
    // The section's own notes are fixed text; ones that tell the operator what to set stay out of the file.
    for (const n of data.notes) {
      if (/^No area is set/.test(n)) blocks.push({ kind: "note", text: [t("Map positions were checked across the client's market, not a single town.")] });
      else if (!/set_client_profile|crawlmark-cli|setup/.test(n)) blocks.push({ kind: "note", text: [t(n)] });
    }
    blocks.push({ kind: "note", text: [t(`From Google Maps and the Google Business Profile${ctx.whiteLabel ? "" : ", via DataForSEO,"} when this report was generated. Map position 1 is the top of the map pack; lower is better.`)] });
    return blocks;
  },
  // Phase 12 C5: AI-search visibility. Questions are AI-platform text (stripControl'd, escaped as data); cited URLs and
  // domains render as code. No answer text is ever included.
  ai_visibility: (data: AiVisibilityData) => {
    const where = data.platform === "chat_gpt" ? "ChatGPT answers (United States, English)" : "Google AI Overviews";
    const product = data.platform === "chat_gpt" ? "ChatGPT" : "Google AI Overview";
    const blocks: Block[] = [];
    const tiles: Kpi[] = [];
    if (data.metrics) {
      tiles.push({ label: "Mentions as a source", value: fmtInt(data.metrics.total.mentions) }, { label: "AI searches a month", value: fmtInt(data.metrics.total.aiSearchVolume), detail: "for those questions" });
    }
    if (data.mentions && data.mentions.total !== null) tiles.push({ label: "Questions citing the site", value: fmtInt(data.mentions.total) });
    blocks.push({ kind: "paragraph", text: [t(`How often ${where} cite `), c(data.domain), t(" as a source.")] });
    if (tiles.length) blocks.push({ kind: "kpiRow", items: tiles });
    if (data.mentions) {
      blocks.push(
        data.mentions.items.length
          ? {
              kind: "table",
              title: `Questions whose ${product} answer cites this site${data.mentions.total !== null ? ` (the ${fmtInt(data.mentions.items.length)} with the most AI searches)` : ""}`,
              header: ["Question", "AI search volume", "Cited page", "Source position"],
              rows: data.mentions.items.map((i) => [i.question ? d(i.question) : cell("n/a"), cell(fmtInt(i.aiSearchVolume)), i.citedUrl ? [c(i.citedUrl)] : cell("n/a"), cell(i.position === null ? "n/a" : String(i.position))]),
              numeric: [false, true, false, true],
              bar: { col: 1, values: data.mentions.items.map((i) => i.aiSearchVolume ?? 0) },
            }
          : { kind: "paragraph", text: [t(`No ${where} in DataForSEO's dataset cite this site yet.`)] },
      );
    }
    if (data.metrics?.sourcesDomain.length) {
      blocks.push({ kind: "table", title: "Other sites cited in the same answers", header: ["Also cited", "Mentions", "AI search volume"], rows: data.metrics.sourcesDomain.map((r) => [[c(r.key)], cell(fmtInt(r.mentions)), cell(fmtInt(r.aiSearchVolume))]), numeric: [false, true, true] });
    }
    blocks.push({ kind: "note", text: [t("From DataForSEO's LLM Mentions dataset when this report was generated (paid). AI answers change often; AI search volume is DataForSEO's estimate.")] });
    return blocks;
  },
  // Phase 13 A: one deduplicated list from every stored source, grouped by severity. Issue titles and URLs come from
  // crawls and Google (stripControl'd; escaped as data by each renderer). Operator detail (snapshot IDs, why a source
  // was unavailable) stays in the tool result.
  technical_issues: (data: TechnicalIssuesData, _r, ctx) => {
    if (!data.sources.length) return [];
    const k = data.counts;
    const ch = data.changes;
    const tile = (label: string, n: number, bad: boolean): Kpi => ({ label, value: fmtInt(n), ...(bad && n > 0 ? { tone: "bad" as const } : {}) });
    const tiles: Kpi[] = [tile("Critical", k.critical, true), tile("High", k.high, true), tile("Medium", k.medium, false), tile("Low", k.low, false)];
    if (ch) tiles.push(tile("New", ch.new, true), { label: "Resolved", value: fmtInt(ch.resolved), ...(ch.resolved > 0 ? { tone: "good" as const } : {}) });
    const blocks: Block[] = [{ kind: "kpiRow", items: tiles }];
    if (!data.total) blocks.push({ kind: "paragraph", text: [t("No open technical issues in the sources below.")] });
    for (const sev of ["critical", "high", "medium", "low"] as const) {
      const rows = data.issues.filter((i) => i.severity === sev);
      if (!rows.length) continue;
      blocks.push({
        kind: "table",
        title: SEVERITY_TITLE[sev],
        header: ["Issue", "Pages", "Example", "Found by", ...(ch ? ["Change"] : [])],
        rows: rows.map((i) => [d(i.title), cell(fmtInt(i.affected)), issueExample(i, ctx.domain), foundBy(i), ...(ch ? [CHANGE_TAG[i.change]] : [])]),
        numeric: [false, true, false, false, false],
      });
    }
    if (data.total > data.issues.length) blocks.push({ kind: "note", text: [t(`Showing ${fmtInt(data.issues.length)} of ${fmtInt(data.total)} open issues, most severe first.`)] });
    if (data.resolved.length) {
      blocks.push({ kind: "table", title: "Resolved since the last report", header: ["Issue", "Example", "Found by"], rows: data.resolved.map((i) => [d(i.title), issueExample(i, ctx.domain), foundBy(i)]) });
    }
    if (data.noLongerChecked) ctx.note("Technical SEO issues: some issues from earlier reports are no longer checked by any current source, so they are left out (not counted as fixed).");
    const from = data.sources.map((x) => `${ISSUE_SOURCE_NAMES[x.source]} (${fullDay(x.ranAt)}${x.stale ? ", older data" : ""})`).join(", ");
    blocks.push({
      kind: "note",
      text: [t(`From ${from}. The same problem found by several sources is listed once; "Pages" is the largest count any one source reports.${ch ? " Issues not re-checked by their source are shown as not re-checked, never as fixed." : ""}`)],
    });
    return blocks;
  },
  // Phase 13 A: Google's verdict for a sample of URLs. Coverage states and URLs are Google's (stripControl'd; escaped
  // as data). The property and today's inspection count are operator detail and never shown.
  indexing_issues: (data: IndexingIssuesData, _r, ctx) => {
    const n = data.sample.inspected;
    const pr = data.pagesReport;
    if (!n && !pr) return [];
    const notIndexed = n - data.indexed.count;
    const blocks: Block[] = [];
    // An imported Search Console Pages report: Google's complete counts per reason as of its export date, with
    // example pages (marked when URL Inspection found them indexed after the export). Reasons and URLs are Google's.
    if (pr) {
      const examples = (r: (typeof pr.reasons)[number]): Text => {
        if (!r.examples.length) return cell("");
        const shown = r.examples.slice(0, 3);
        const out: Text = [];
        shown.forEach((e, i) => {
          if (i) out.push(t(", "));
          out.push(...pagePath(e.url, ctx.domain), ...(e.indexedNow ? [t(" (indexed now)")] : []));
        });
        const more = (r.examplesTotal ?? r.examples.length) - shown.length;
        if (more > 0) out.push(t(` and ${fmtInt(more)} more`));
        return out;
      };
      const reasonRows = (group: "not_indexed" | "improve") =>
        pr.reasons
          // A reason at 0 pages (Search Console's "~" or "-") isn't a problem to list; index_coverage keeps it.
          .filter((r) => r.group === group && r.pages !== 0)
          .slice(0, REASON_ROWS_MAX)
          .map((r) => [[...severity(r.severity), t(" "), ...d(r.reason)], cell(r.pages === null ? "n/a" : fmtInt(r.pages)), examples(r)]);
      const when = pr.exportedOn ? `Search Console's Pages report exported on ${fullDay(pr.exportedOn)}` : "Search Console's Pages report (example pages only)";
      blocks.push({
        kind: "paragraph",
        text: [t(`From ${when}${pr.notIndexed !== null ? `: ${fmtInt(pr.notIndexed)} page${pr.notIndexed === 1 ? "" : "s"} not indexed${pr.indexed !== null ? ` and ${fmtInt(pr.indexed)} indexed` : ""}` : ""}.${pr.exportedOn ? " These are Google's own counts for every page it knows, by reason." : " Only example pages were imported, so there are no counts."}`)],
      });
      const notIdx = reasonRows("not_indexed");
      if (notIdx.length) blocks.push({ kind: "table", title: "Why pages aren't indexed (Search Console)", header: ["Reason", "Pages", "Example pages"], rows: notIdx, numeric: [false, true, false] });
      const improve = reasonRows("improve");
      if (improve.length) blocks.push({ kind: "table", title: "Indexed, with a problem (Search Console)", header: ["Reason", "Pages", "Example pages"], rows: improve, numeric: [false, true, false] });
      const since = pr.reasons.reduce((a, r) => a + r.indexedSince, 0);
      if (since) blocks.push({ kind: "note", text: [t(`${fmtInt(since)} example page${since === 1 ? " was" : "s were"} indexed when URL Inspection checked ${since === 1 ? "it" : "them"} after the export ("indexed now").`)] });
    }
    if (!n) return blocks;
    blocks.push(
      {
        kind: "kpiRow",
        items: [
          { label: "URLs checked", value: fmtInt(n) },
          { label: "Indexed", value: fmtInt(data.indexed.count), ...(data.indexed.share !== null ? { detail: `${data.indexed.share.toFixed(1)}% of checked` } : {}) },
          { label: "Not indexed", value: fmtInt(notIndexed), ...(notIndexed > 0 ? { tone: "bad" as const } : {}) },
          { label: "Canonical chosen differently", value: fmtInt(data.canonicalMismatches) },
        ],
      },
    );
    if (data.byCoverage.length) {
      const top = data.byCoverage.slice(0, COVERAGE_PARTS);
      const rest = data.byCoverage.slice(COVERAGE_PARTS).reduce((a, x) => a + x.count, 0);
      const parts = [...top.map((x) => x.state), ...(rest ? ["Other"] : [])];
      const values = [...top.map((x) => x.count), ...(rest ? [rest] : [])];
      blocks.push({
        kind: "chart",
        chart: {
          type: "share",
          title: "Google's verdict for checked URLs",
          parts,
          rows: [{ label: "Checked URLs", values }],
          summary: `Of ${fmtInt(n)} URLs checked, Google reports ${data.indexed.count === 1 ? "1 indexed" : `${fmtInt(data.indexed.count)} indexed`}${data.indexed.share !== null ? ` (${data.indexed.share.toFixed(1)}%)` : ""} and ${fmtInt(notIndexed)} not indexed.`,
          fallback: { kind: "table", title: "Google's verdict for checked URLs", header: ["Google says", "URLs"], rows: data.byCoverage.map((x) => [d(x.state), cell(fmtInt(x.count))]), numeric: [false, true] },
        },
      });
    }
    if (data.worst.length) {
      blocks.push({
        kind: "table",
        title: "Pages to look at",
        header: ["Page", "Google says", "In sitemap", "Last crawled"],
        rows: data.worst.map((w) => [
          pagePath(w.url, ctx.domain),
          [...severity(w.severity), t(" "), ...d(w.coverage), ...(w.googleCanonical ? [t(" (Google's canonical: "), ...pagePath(w.googleCanonical, ctx.domain), t(")")] : [])],
          cell(w.inSitemap ? "yes" : "no"),
          cell(w.lastCrawl ? fullDay(w.lastCrawl) : "never"),
        ]),
      });
    }
    if (data.sitemaps.length) {
      blocks.push({
        kind: "table",
        title: "Sitemaps",
        header: ["Sitemap", "Errors", "Warnings", "URLs submitted"],
        rows: data.sitemaps.map((m) => [[c(m.path)], toned(fmtInt(m.errors), m.errors > 0 ? "bad" : undefined), cell(fmtInt(m.warnings)), cell(m.submitted === null ? "n/a" : fmtInt(m.submitted))]),
        numeric: [false, true, true, true],
      });
    }
    const trend = data.trend.filter((x) => x.indexedShare !== null);
    if (trend.length >= 2) {
      blocks.push({
        kind: "chart",
        chart: {
          type: "line",
          title: "Share of checked URLs indexed, by month (%)",
          x: trend.map((x) => `${x.month}-01`),
          series: [{ name: "Indexed share", values: trend.map((x) => x.indexedShare), role: "current" }],
          format: "count",
          connectGaps: true,
          summary: `The share of checked URLs Google had indexed went from ${trend[0]!.indexedShare!.toFixed(1)}% to ${trend.at(-1)!.indexedShare!.toFixed(1)}% over ${trend.length} months.`,
          fallback: { kind: "table", title: "Share indexed by month", header: ["Month", "URLs checked", "Indexed"], rows: trend.map((x) => [cell(x.month), cell(fmtInt(x.inspected)), cell(`${x.indexedShare!.toFixed(1)}%`)]), numeric: [false, true, true] },
        },
      });
    }
    const s = data.sample;
    const cov = data.coverage;
    const covDays = cov?.windowDays ? ` in the last ${fmtInt(cov.windowDays)} day${cov.windowDays === 1 ? "" : "s"}` : "";
    blocks.push({
      kind: "note",
      text: [
        t(
          cov?.complete
            ? // Every URL in the site's sitemaps has a recent result: say so instead of calling it a sample.
              `Based on Google's URL Inspection of all ${fmtInt(cov.sitemapUrls)} sitemap page${cov.sitemapUrls === 1 ? "" : "s"} (checked${covDays}) plus key pages and top Search Console pages, ${fmtInt(n)} pages in all.` +
                `${s.oldestDays !== null ? ` The oldest result is ${fmtInt(s.oldestDays)} day${s.oldestDays === 1 ? "" : "s"} old.` : ""}`
            : `Based on Google's URL Inspection of ${fmtInt(n)} pages (key pages, top Search Console pages and a rotating sample of sitemap URLs), not Search Console's full Page indexing report. ` +
                `${fmtInt(s.keyPages)} key page${s.keyPages === 1 ? "" : "s"} and ${fmtInt(s.sitemapUrls)} sitemap URL${s.sitemapUrls === 1 ? "" : "s"}${s.sitemapUrlsKnown ? ` (of about ${fmtInt(s.sitemapUrlsKnown)} submitted)` : ""} were checked${s.oldestDays !== null ? `; the oldest result is ${fmtInt(s.oldestDays)} day${s.oldestDays === 1 ? "" : "s"} old` : ""}.` +
                (cov && cov.sitemapUrls ? ` ${fmtInt(cov.checked)} of the ${fmtInt(cov.sitemapUrls)} URLs in the site's sitemaps were checked${covDays || " in the last 30 days"}.` : ""),
        ),
      ],
    });
    return blocks;
  },
  keyword_gap: (data: KeywordGapData) => {
    const metric = data.gaps.find((g) => g.difficulty.value !== null)?.difficulty.metric ?? data.gaps[0]?.difficulty.metric;
    const header = ["Keyword", "Monthly volume", metric ? KD_LABEL[metric] : "Difficulty", "Competitors ranking (position)"];
    if (!data.gaps.length) return [];
    return [
      {
        kind: "paragraph",
        text: [t(`Keywords ${data.competitors.join(", ")} rank for and this site doesn't (${PROVIDER_NAME[data.provider]} data, up to ${fmtInt(data.limit)} per competitor), sorted by volume.`)],
      },
      {
        kind: "table",
        header,
        rows: data.gaps.map((g) => [d(g.keyword), cell(fmtInt(g.volume)), cell(g.difficulty.value === null ? "n/a" : String(g.difficulty.value)), d(g.competitors.map((x) => `${x.domain}${x.position === null ? "" : ` (${x.position})`}`).join(", "))]),
        numeric: [false, true, true, false],
      },
      ...(data.gaps.some((g) => g.clientCheck === "gsc") ? [{ kind: "note" as const, text: [t("Keywords this site already gets Search Console impressions for were left out.")] }] : []),
      { kind: "note", text: [t("Difficulty is the provider's own 0-100 scale; don't compare it with another provider's.")] },
    ];
  },
};

/** The blocks for one section with data; none means the section has nothing to show and is left out. */
export function sectionBlocks(s: SectionResult, report: TemplateReport, ctx: MapContext): Block[] {
  if (s.status !== "ok") return [];
  const mapper = SECTION_MAPPERS[s.type];
  if (!mapper) return [{ kind: "note", text: [t(`${s.title}: this version can't render "${s.type}" sections.`)] }];
  return mapper(s.data as never, report, ctx);
}
