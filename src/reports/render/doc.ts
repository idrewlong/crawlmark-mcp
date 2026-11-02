/**
 * One report model, four renderers (D1). buildReportDoc turns a TemplateReport
 * (plus optional narrative and branding) into a ReportDoc laid out like an
 * agency dashboard: a cover band, four key-figure cards, a summary box, one
 * card per section with data (charts, tables), and a short "About this
 * report" footer. toMarkdown, toHtml and toDocx are pure functions of it and
 * toPdf prints toHtml's output. Section blocks come from the mapper table in
 * sections.ts. Pure: no I/O (the logo bytes are passed in).
 *
 * Client files carry no operator detail: sections without data are left out
 * (named once in the About section), paid-data spend and tool hints stay in
 * the tool and CLI results.
 */
import type { BlockSectionData, TemplateReport } from "../report-types.js";
import { periodName, rangeLabel } from "../templates/period.js";
import type { ResolvedBranding } from "../templates/load.js";
import { DEFAULT_ACCENT, DEFAULT_PRIMARY } from "./color.js";
import { clientText, MAX_CHART_REFS, parseNarrative, type Narrative, type NarrativeBlock, type Run } from "./narrative.js";
import type { CoverField } from "../templates/schema.js";
import { keyFigures, scrubDeep, sectionBlocks, statusLine, type MapContext } from "./sections.js";

export type { Run };
/** Inline text: runs of plain, bold, code, toned or tagged text. */
export type Text = Run[];

/** Parsed commentary after `{{chart}}` references are resolved: a reference becomes the chart itself (or is dropped). */
export type DocNarrativeBlock = NarrativeBlock | { kind: "chart"; chart: Chart };

export type Tone = "good" | "bad" | "neutral";

/** A change shown as a coloured chip: the arrow follows the number, the colour follows whether it's good. */
export interface Delta {
  text: string;
  dir: "up" | "down" | "flat";
  tone: Tone;
}

export interface Kpi {
  label: string;
  value: string;
  delta?: Delta;
  /** A small line under the value ("vs 952", "lower is better"). */
  detail?: string;
  /** Colour the value itself (an issue count above zero, for example). */
  tone?: Tone;
}

export interface TableBlock {
  kind: "table";
  header: string[];
  rows: Text[][];
  numeric?: boolean[];
  /** A small title above the table ("Gained clicks"). */
  title?: string;
  /** Draw a proportional bar behind one numeric column (HTML); `values` has one number per row. */
  bar?: { col: number; values: number[] };
}

export interface LineSeries {
  name: string;
  values: (number | null)[];
  /** `current` is the brand colour with an area fill, `previous` a dashed grey line, `series` a categorical colour by `index`. */
  role: "current" | "previous" | "series";
  index?: number;
}

export interface LineChart {
  type: "line";
  title: string;
  /** ISO dates, one per point. */
  x: string[];
  series: LineSeries[];
  format: "count" | "ms" | "score" | "position";
  /** Lower is better and drawn at the top (positions). */
  invert?: boolean;
  /** Good / poor thresholds drawn as faint bands (Core Web Vitals). */
  bands?: { good: number; poor: number };
  /** Join points across missing values (sparse stored checks). */
  connectGaps?: boolean;
  /** One sentence for screen readers and the alt text. */
  summary: string;
  /** What Markdown, DOCX and the Google Docs copy show instead (left out when a table already has the numbers). */
  fallback?: TableBlock;
}

export interface ShareChart {
  type: "share";
  title: string;
  parts: string[];
  rows: { label: string; values: number[] }[];
  summary: string;
  fallback?: TableBlock;
}

export type Chart = LineChart | ShareChart;

export type Block =
  | { kind: "heading"; level: 3; text: string }
  | { kind: "paragraph"; text: Text }
  | { kind: "list"; items: Text[] }
  | TableBlock
  | { kind: "kpiRow"; items: Kpi[] }
  | { kind: "note"; text: Text }
  | { kind: "commentary"; blocks: DocNarrativeBlock[] }
  | { kind: "chart"; chart: Chart }
  /** Side by side in HTML (two or three columns); one after another elsewhere. */
  | { kind: "columns"; columns: Block[][] }
  /** A `block` section's text: the same Markdown as commentary, without the "Commentary" box. */
  | { kind: "rich"; blocks: DocNarrativeBlock[] };

export interface DocSection {
  id: string;
  /** The link target for the contents list: `s-<id>`. */
  anchor: string;
  title: string;
  blocks: Block[];
  commentary?: DocNarrativeBlock[];
  /** Half width: two consecutive half sections share a row in HTML. */
  half?: boolean;
  /** Start on a new page (standard layout only). */
  pageBreakBefore?: true;
}

export type FontFallback = "sans-serif" | "serif";

export interface DocBranding {
  agencyName?: string;
  primaryColor: string;
  accentColor: string;
  footer?: string;
  paper: "Letter" | "A4";
  logo?: { mime: "image/png" | "image/jpeg"; data: Buffer };
  /** White label: no crawlmark name or version in the file. */
  hideCrawlmark?: boolean;
  /** Font family names from the branding (null: the renderer's own default). `heading` falls back to `body` in the renderers. */
  fonts: { body: string | null; heading: string | null; fallback: FontFallback };
  /** White label for data providers (DataForSEO): `hideProviders`, else `hideCrawlmark`. Ahrefs and Semrush source lines stay. */
  hideProviders?: true;
  /** The line that says commentary is written by a person or a tool; null: no line. Resolved from the branding. */
  commentaryNote: string | null;
}

export interface ReportDoc {
  meta: {
    /** "Example Co - SEO report - September 2026": the document / Google Doc title. */
    title: string;
    clientName: string;
    domain: string;
    templateTitle: string;
    /** "September 2026". */
    periodLabel: string;
    /** "1–30 Sep 2026". */
    periodRange: string;
    /** "August 2026 and September 2025", when there are comparisons. */
    compareWith?: string;
    /** "13 Oct 2026". */
    generated: string;
    dataOnly: boolean;
    layout: "standard" | "onepage";
    /** The PDF's running header: "Example Co · Monthly SEO report · September 2026". */
    runningHeader: string;
    /** The cover's fields in display order, and the optional texts they show. */
    cover: { fields: CoverField[]; subtitle?: string; preparedFor?: string; preparedBy?: string };
  };
  /** The contents list (sections in order, then the About section). Absent unless the template asks for it and the layout is standard. */
  contents?: { anchor: string; title: string }[];
  /** Operator-only problems found while building the document. Never rendered. */
  warnings: string[];
  /** "Data-only report" or "With commentary", shown as a badge in the cover. */
  badge: string;
  /** Exactly four cards (clicks, impressions, CTR, average position) when Search Console data is in the report. */
  kpis: Kpi[];
  /** "Change vs August 2026 (previous period)". */
  kpiCaption?: string;
  summary?: { title: string; caption: string; items?: Text[]; narrative?: DocNarrativeBlock[] };
  sections: DocSection[];
  /** The "About this report" footer section: plain-language period, sources and notes. */
  about: Text[];
  footer: string;
  branding: DocBranding;
}

export const txt = (t: string): Run => ({ t });
export const code = (t: string): Run => ({ t, c: true });
export const bold = (t: string): Run => ({ t, b: true });

export const DATA_ONLY_TEXT = "Built automatically from Search Console and Google Analytics. It has no written commentary.";
export const COMMENTARY_TEXT = "Commentary written with Claude; all figures come from the data below.";
/** The commentary line when hideCrawlmark is on and the branding sets no commentaryNote. */
export const WHITE_LABEL_COMMENTARY_TEXT = "Written commentary; all figures come from the data below.";
/** The About section's link target in the contents list (no `s-` prefix, so no section id can collide with it). */
export const ABOUT_ANCHOR = "about-this-report";
const HIGHLIGHTS_CAPTION = "Computed automatically from the data in this report.";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const day = (iso: string) => {
  const d = new Date(iso);
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
};

export interface BuildOptions {
  narrative?: Narrative | undefined;
  branding?: ResolvedBranding | undefined;
  /** Logo bytes, already checked (PNG or JPEG, at most 512 KB). */
  logo?: DocBranding["logo"] | undefined;
  version: string;
  /** The branding preview: made-up example.com data, badged "Sample data" on the cover. */
  sample?: boolean | undefined;
}

const ONEPAGE_HIGHLIGHTS = 3;

/** Every chart in a section's blocks, in reading order (charts inside columns included). */
function chartsOf(blocks: Block[]): Chart[] {
  return blocks.flatMap((b): Chart[] => (b.kind === "chart" ? [b.chart] : b.kind === "columns" ? chartsOf(b.columns.flat()) : []));
}

/** How many more `{{chart}}` references one report may resolve; shared by the summary, the sections and the block texts. */
export interface ChartRefBudget {
  left: number;
  /** The over-the-limit warning was already recorded. */
  warned: boolean;
}
export const chartRefBudget = (limit = MAX_CHART_REFS): ChartRefBudget => ({ left: limit, warned: false });

/**
 * Turns `{{chart <section> <n>}}` references into the n-th chart of that section (a copy), or drops the reference
 * and records an operator-only warning when the section has no such chart. Each resolved reference uses one of the
 * report's `budget`; past it a reference is dropped and one warning says so (SEC-1).
 */
export function resolveChartRefs(blocks: readonly NarrativeBlock[], charts: (sectionId: string) => Chart[], field: string, warnings: string[], budget: ChartRefBudget = chartRefBudget()): DocNarrativeBlock[] {
  const out: DocNarrativeBlock[] = [];
  for (const b of blocks) {
    if (b.kind !== "chartRef") {
      out.push(b);
      continue;
    }
    const chart = charts(b.section)[b.index - 1];
    if (chart && budget.left <= 0) {
      if (!budget.warned) warnings.push(`${field.startsWith("blocks.") ? field : `narrative.${field}`}: more than ${MAX_CHART_REFS} {{chart}} references in this report; the rest were left out.`);
      budget.warned = true;
    } else if (chart) {
      budget.left--;
      out.push({ kind: "chart", chart: structuredClone(chart) });
    }
    else warnings.push(`narrative.${field}: {{chart ${b.section}${b.index === 1 ? "" : ` ${b.index}`}}} has no chart to show; left out.`);
  }
  return out;
}

/** The cover as renderers draw it: `domain` and `badge` have fixed places; the other fields are labelled entries in display order. */
export interface CoverEntry {
  field: Exclude<CoverField, "domain" | "badge">;
  label: string;
  value: string;
}
export function coverEntries(m: ReportDoc["meta"]): { domain: boolean; badge: boolean; entries: CoverEntry[] } {
  const entries: CoverEntry[] = [];
  for (const f of m.cover.fields) {
    if (f === "period") entries.push({ field: f, label: "Period", value: `${m.periodLabel} · ${m.periodRange}` });
    else if (f === "compare") {
      if (m.compareWith) entries.push({ field: f, label: "Compared with", value: m.compareWith });
    } else if (f === "generated") entries.push({ field: f, label: "Generated", value: m.generated });
    else if (f === "preparedFor") {
      if (m.cover.preparedFor) entries.push({ field: f, label: "Prepared for", value: m.cover.preparedFor });
    } else if (f === "preparedBy") {
      if (m.cover.preparedBy) entries.push({ field: f, label: "Prepared by", value: m.cover.preparedBy });
    }
  }
  return { domain: m.cover.fields.includes("domain"), badge: m.cover.fields.includes("badge"), entries };
}

export function buildReportDoc(report: TemplateReport, opts: BuildOptions): ReportDoc {
  const b = opts.branding ?? {};
  const narrative = opts.narrative;
  // Only client text counts: internal notes never make a report "with commentary".
  const hasNarrative = Boolean(narrative && ((clientText(narrative.summary) ?? "").trim() || Object.values(narrative.sections ?? {}).some((v) => (clientText(v) ?? "").trim())));
  const p = report.period;
  const layout = report.template.layout === "onepage" ? "onepage" : "standard";
  const comparisons = [p.comparisons.previous_period, p.comparisons.previous_year].filter((r): r is NonNullable<typeof r> => Boolean(r));

  const whiteLabel = b.hideCrawlmark === true;
  const hideProviders = b.hideProviders ?? b.hideCrawlmark ?? false;
  const commentaryNote = b.commentaryNote !== undefined ? (b.commentaryNote.trim() ? b.commentaryNote : null) : whiteLabel ? WHITE_LABEL_COMMENTARY_TEXT : COMMENTARY_TEXT;
  const ctx: MapContext = {
    whiteLabel,
    hideProviders,
    domain: report.client.domain,
    onepage: layout === "onepage",
    notes: [],
    note(n: string) {
      if (!this.notes.includes(n)) this.notes.push(n);
    },
  };

  const warnings: string[] = [];
  const sections: DocSection[] = [];
  const notIncluded: string[] = [];
  for (const s of report.sections) {
    const commentaryText = clientText(narrative?.sections?.[s.id]);
    const commentary = commentaryText?.trim() ? parseNarrative(commentaryText) : undefined;
    const blocks = s.status === "ok" ? sectionBlocks(s, report, ctx) : [];
    if (!blocks.length && !commentary) {
      // "No data" is only for sections that are unavailable or genuinely empty (every mapper renders a line for a
      // section that has data it can't chart). Paid sections that weren't allowed are the operator's choice, not a gap.
      if (s.status === "unavailable" || (s.status === "ok" && !["text", "data_spend"].includes(s.type))) notIncluded.push(s.title);
      continue;
    }
    sections.push({
      id: s.id,
      anchor: `s-${s.id}`,
      title: s.title,
      blocks,
      ...(commentary ? { commentary } : {}),
      ...(layout === "onepage" && ["query_movers", "opportunities"].includes(s.type) ? { half: true } : {}),
      ...(layout === "standard" && s.pageBreakBefore === true ? { pageBreakBefore: true as const } : {}),
    });
  }

  // Resolve {{chart}} references now that every section's charts are known; unresolved ones are left out and listed in `warnings`.
  // One budget for the whole report, in reading order: the summary, then each section's commentary and block text.
  const chartsFor = (id: string) => chartsOf(sections.find((x) => x.id === id)?.blocks ?? []);
  const budget = chartRefBudget();
  const summaryText = clientText(narrative?.summary);
  const summaryNarrative = hasNarrative && summaryText?.trim() ? resolveChartRefs(parseNarrative(summaryText), chartsFor, "summary", warnings, budget) : undefined;
  for (const x of sections) {
    if (x.commentary) x.commentary = resolveChartRefs(x.commentary as NarrativeBlock[], chartsFor, `sections.${x.id}`, warnings, budget);
    const src = report.sections.find((r) => r.id === x.id);
    const field = `blocks.${src?.status === "ok" && src.type === "block" ? (src.data as BlockSectionData).blockId : x.id}`;
    x.blocks = x.blocks.map((bl) => (bl.kind === "rich" ? { ...bl, blocks: resolveChartRefs(bl.blocks as NarrativeBlock[], chartsFor, field, warnings, budget) } : bl));
  }

  // Two consecutive narrow sections (tables of at most four columns, no chart or commentary) share a row,
  // so short tables don't each take a full-width band (page movers next to landing pages, for example).
  // A section that starts a new page is never paired.
  if (layout === "standard") {
    const narrow = (x: DocSection) => !x.pageBreakBefore && !x.commentary && x.blocks.every((bl) => (bl.kind === "table" ? bl.header.length <= 4 : bl.kind === "note"));
    for (let i = 0; i + 1 < sections.length; i++) {
      if (narrow(sections[i]!) && narrow(sections[i + 1]!)) {
        sections[i]!.half = true;
        sections[i + 1]!.half = true;
        i++;
      }
    }
  }

  // About this report: plain language, no tool names, no spend.
  const about: Text[] = [];
  const cmpText = [
    p.comparisons.previous_period ? `${periodName(p.comparisons.previous_period)} (${rangeLabel(p.comparisons.previous_period)})` : "",
    p.comparisons.previous_year ? `${periodName(p.comparisons.previous_year)} (${rangeLabel(p.comparisons.previous_year)}, the same period a year earlier)` : "",
  ].filter(Boolean);
  about.push([
    txt(
      layout === "onepage"
        ? `Period: ${p.label} (${rangeLabel(p.current)})${comparisons.length ? `, compared with ${comparisons.map(periodName).join(" and ")}` : ""}.`
        : `Period: ${p.label} (${rangeLabel(p.current)})${cmpText.length ? `, compared with ${cmpText.join(" and ")}` : ""}.`,
    ),
  ]);
  if (!hasNarrative) about.push([txt(`Data-only report. ${DATA_ONLY_TEXT}`)]);
  else if (commentaryNote) about.push([txt(commentaryNote)]);
  about.push([
    txt(
      layout === "onepage"
        ? "Sources: Google Search Console and Google Analytics 4."
        : `Sources: Google Search Console (search), Google Analytics 4 (organic traffic), ${whiteLabel ? "saved site audits" : "saved crawlmark audits"}, the Chrome UX Report and Google Tag Manager when those sections are included.`,
    ),
  ]);
  const ok = (type: string) => sections.some((x) => report.sections.find((s) => s.id === x.id)?.type === type);
  if (layout === "standard" && ["top_queries", "query_movers", "branded_split", "tracked_keywords"].some(ok)) {
    about.push([txt("Search Console counts anonymized queries in its totals but not in the query tables, so the query tables don't add up to the totals.")]);
  }
  if (ok("rank_trend")) about.push([txt(`Rank trends: ${whiteLabel ? "stored rank checks" : "crawlmark's stored rank checks"} (Search Console 7-day averages; live ranks${hideProviders ? "" : " from DataForSEO"} when they were checked).`)]);
  if (ok("bing_overview")) about.push([txt("Bing: Bing Webmaster Tools (free, read-only). Bing updates query and page stats weekly.")]);
  if (ok("ai_readiness")) about.push([txt(`AI readiness: robots.txt and llms.txt as read by the newest saved ${whiteLabel ? "site" : "crawlmark"} audit (free).`)]);
  if (ok("site_crawl")) about.push([txt(whiteLabel ? "Site crawl: a crawl of the site without JavaScript rendering, the newest one saved." : "Site crawl: crawlmark's own crawl of the site from this machine (free), the newest one saved.")]);
  if (ok("local_profile")) about.push([txt(`Local search: Google Business Profile and Google Maps results${hideProviders ? "" : " via DataForSEO"} (paid).`)]);
  if (ok("ai_visibility")) about.push([txt(hideProviders ? "AI search visibility: an AI-answer dataset (paid)." : "AI search visibility: DataForSEO LLM Mentions (paid).")]);
  if (ok("keyword_gap")) about.push([txt("Keyword gap: the client's SEO data provider (paid), named in that section.")]);
  // Phase 13 B: name the SEO data provider(s) behind the provider sections (kept in white label: attribution).
  const providerTypes = ["backlinks", "organic_visibility", "competitor_overview"];
  const providers = [...new Set(report.sections.filter((s) => s.status === "ok" && providerTypes.includes(s.type) && sections.some((x) => x.id === s.id)).map((s) => (s as { data: { provider?: string } }).data.provider))]
    .map((p) => ({ dataforseo: hideProviders ? "a third-party SEO data provider" : "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" })[p as "dataforseo"])
    .filter(Boolean);
  if (providers.length) about.push([txt(`Backlinks, organic visibility and competitors: ${providers.join(" and ")} (paid), stored month by month; each figure and its comparison come from the same provider.`)]);
  if (ok("technical_issues")) about.push([txt(`Technical SEO issues: ${whiteLabel ? "saved site audits and crawls" : "crawlmark's saved audits and crawls"}, a stored ${hideProviders ? "third-party" : "DataForSEO"} crawl and Google URL Inspection when available, merged into one list and compared with the previous report.`)]);
  if (ok("indexing_issues")) {
    const ix = report.sections.find((s) => s.type === "indexing_issues" && s.status === "ok") as { data?: { pagesReport?: unknown; coverage?: { complete?: boolean }; sample?: { inspected?: number } } } | undefined;
    const what = ix?.data?.coverage?.complete ? "of every sitemap page" : "of a sample of pages";
    // With only an imported export (no inspections yet), the section shows the export alone.
    if (ix?.data?.pagesReport && ix.data.sample?.inspected === 0) about.push([txt("Google indexing: an export of Search Console's Pages report (imported, read on this machine).")]);
    else about.push([txt(`Google indexing: Search Console's URL Inspection ${what} and its sitemap report (free, read-only)${ix?.data?.pagesReport ? ", and an export of its Pages report" : ""}.`)]);
  }
  for (const n of [...ctx.notes, ...report.notes]) about.push([txt(n)]);
  for (const s of report.sections) if (s.status === "error") about.push([txt(statusLine(s))]);
  if (notIncluded.length) about.push([txt(`Not included this time (no data for this period): ${notIncluded.join(", ")}.`)]);

  const kpis = keyFigures(report);
  const vs = kpis.length ? kpiComparison(report) : undefined;
  const highlights = report.highlights.map((h): Text => [txt(hideProviders ? scrubDeep(h.text) : h.text)]);
  const summary: ReportDoc["summary"] =
    summaryNarrative
      ? { title: "Summary", caption: commentaryNote ?? "", narrative: summaryNarrative }
      : highlights.length
        ? { title: "Highlights", caption: HIGHLIGHTS_CAPTION, items: layout === "onepage" ? highlights.slice(0, ONEPAGE_HIGHLIGHTS) : highlights }
        : undefined;

  const cover = report.template.cover;
  const coverFields: CoverField[] = cover?.fields ?? ["domain", "period", "compare", "generated", ...(cover?.preparedFor ? (["preparedFor"] as const) : []), ...(cover?.preparedBy ? (["preparedBy"] as const) : []), "badge"];
  const contents = report.template.contents === true && layout === "standard" ? [...sections.map((x) => ({ anchor: x.anchor, title: x.title })), { anchor: ABOUT_ANCHOR, title: "About this report" }] : undefined;

  const footerParts = [b.footer, whiteLabel ? "" : `crawlmark ${opts.version}`].filter((x): x is string => Boolean(x && x.trim()));
  return {
    meta: {
      title: `${report.client.name} - SEO report - ${p.label}`,
      clientName: report.client.name,
      domain: report.client.domain,
      templateTitle: report.template.title,
      periodLabel: p.label,
      periodRange: rangeLabel(p.current),
      ...(comparisons.length ? { compareWith: comparisons.map(periodName).join(" and ") } : {}),
      generated: day(report.generatedAt),
      dataOnly: !hasNarrative,
      layout,
      runningHeader: `${report.client.name} · ${report.template.title} · ${p.label}`,
      cover: { fields: coverFields, ...(cover?.subtitle ? { subtitle: cover.subtitle } : {}), ...(cover?.preparedFor ? { preparedFor: cover.preparedFor } : {}), ...(cover?.preparedBy ? { preparedBy: cover.preparedBy } : {}) },
    },
    ...(contents ? { contents } : {}),
    warnings,
    badge: opts.sample ? "Sample data" : hasNarrative ? "With commentary" : "Data-only report",
    kpis,
    ...(vs ? { kpiCaption: vs } : {}),
    ...(summary ? { summary } : {}),
    sections,
    about: hideProviders ? scrubDeep(about) : about,
    footer: footerParts.join(" · "),
    branding: {
      ...(b.agencyName ? { agencyName: b.agencyName } : {}),
      primaryColor: b.primaryColor ?? DEFAULT_PRIMARY,
      accentColor: b.accentColor ?? DEFAULT_ACCENT,
      ...(b.footer ? { footer: b.footer } : {}),
      paper: b.paper ?? "Letter",
      ...(opts.logo ? { logo: opts.logo } : {}),
      ...(whiteLabel ? { hideCrawlmark: true } : {}),
      fonts: { body: b.bodyFont ?? null, heading: b.headingFont ?? null, fallback: b.fontFallback ?? "sans-serif" },
      ...(hideProviders ? { hideProviders: true as const } : {}),
      commentaryNote,
    },
  };
}

/** The caption under the key figures: which period the chips compare with. */
function kpiComparison(report: TemplateReport): string {
  const s = report.sections.find((x) => x.type === "search_overview" && x.status === "ok");
  const data = s && s.status === "ok" ? (s.data as { vsPreviousPeriod: { previous: unknown } | null; vsPreviousYear: { previous: unknown } | null }) : undefined;
  const pp = report.period.comparisons.previous_period;
  const py = report.period.comparisons.previous_year;
  if (pp && data?.vsPreviousPeriod?.previous) return `Change vs ${periodName(pp)} (previous period)`;
  if (py && data?.vsPreviousYear?.previous) return `Change vs ${periodName(py)} (same period last year)`;
  return "No comparison period in this report";
}
