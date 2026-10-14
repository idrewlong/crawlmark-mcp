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
import type { TemplateReport } from "../report-types.js";
import { periodName, rangeLabel } from "../templates/period.js";
import type { ResolvedBranding } from "../templates/load.js";
import { DEFAULT_ACCENT, DEFAULT_PRIMARY } from "./color.js";
import { parseNarrative, type Narrative, type NarrativeBlock, type Run } from "./narrative.js";
import { keyFigures, sectionBlocks, statusLine, type MapContext } from "./sections.js";

export type { Run };
/** Inline text: runs of plain, bold, code, toned or tagged text. */
export type Text = Run[];

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
  | { kind: "commentary"; blocks: NarrativeBlock[] }
  | { kind: "chart"; chart: Chart }
  /** Side by side in HTML (two or three columns); one after another elsewhere. */
  | { kind: "columns"; columns: Block[][] };

export interface DocSection {
  id: string;
  title: string;
  blocks: Block[];
  commentary?: NarrativeBlock[];
  /** Half width: two consecutive half sections share a row in HTML. */
  half?: boolean;
}

export interface DocBranding {
  agencyName?: string;
  primaryColor: string;
  accentColor: string;
  footer?: string;
  paper: "Letter" | "A4";
  logo?: { mime: "image/png" | "image/jpeg"; data: Buffer };
  /** White label: no crawlmark name or version in the file. */
  hideCrawlmark?: boolean;
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
  };
  /** "Data-only report" or "With commentary", shown as a badge in the cover. */
  badge: string;
  /** Exactly four cards (clicks, impressions, CTR, average position) when Search Console data is in the report. */
  kpis: Kpi[];
  /** "Change vs August 2026 (previous period)". */
  kpiCaption?: string;
  summary?: { title: string; caption: string; items?: Text[]; narrative?: NarrativeBlock[] };
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

export function buildReportDoc(report: TemplateReport, opts: BuildOptions): ReportDoc {
  const b = opts.branding ?? {};
  const narrative = opts.narrative;
  const hasNarrative = Boolean(narrative && ((narrative.summary ?? "").trim() || Object.values(narrative.sections ?? {}).some((v) => v.trim())));
  const p = report.period;
  const layout = report.template.layout === "onepage" ? "onepage" : "standard";
  const comparisons = [p.comparisons.previous_period, p.comparisons.previous_year].filter((r): r is NonNullable<typeof r> => Boolean(r));

  const whiteLabel = b.hideCrawlmark === true;
  const ctx: MapContext = {
    whiteLabel,
    domain: report.client.domain,
    onepage: layout === "onepage",
    notes: [],
    note(n: string) {
      if (!this.notes.includes(n)) this.notes.push(n);
    },
  };

  const sections: DocSection[] = [];
  const notIncluded: string[] = [];
  for (const s of report.sections) {
    const commentaryText = narrative?.sections?.[s.id];
    const commentary = commentaryText?.trim() ? parseNarrative(commentaryText) : undefined;
    const blocks = s.status === "ok" ? sectionBlocks(s, report, ctx) : [];
    if (!blocks.length && !commentary) {
      // "No data" is only for sections that are unavailable or genuinely empty (every mapper renders a line for a
      // section that has data it can't chart). Paid sections that weren't allowed are the operator's choice, not a gap.
      if (s.status === "unavailable" || (s.status === "ok" && !["text", "data_spend"].includes(s.type))) notIncluded.push(s.title);
      continue;
    }
    sections.push({ id: s.id, title: s.title, blocks, ...(commentary ? { commentary } : {}), ...(layout === "onepage" && ["query_movers", "opportunities"].includes(s.type) ? { half: true } : {}) });
  }

  // Two consecutive narrow sections (tables of at most four columns, no chart or commentary) share a row,
  // so short tables don't each take a full-width band (page movers next to landing pages, for example).
  if (layout === "standard") {
    const narrow = (x: DocSection) => !x.commentary && x.blocks.every((bl) => (bl.kind === "table" ? bl.header.length <= 4 : bl.kind === "note"));
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
  about.push([txt(hasNarrative ? COMMENTARY_TEXT : `Data-only report. ${DATA_ONLY_TEXT}`)]);
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
  if (ok("rank_trend")) about.push([txt(`Rank trends: ${whiteLabel ? "stored rank checks" : "crawlmark's stored rank checks"} (Search Console 7-day averages; live ranks from DataForSEO when they were checked).`)]);
  if (ok("bing_overview")) about.push([txt("Bing: Bing Webmaster Tools (free, read-only). Bing updates query and page stats weekly.")]);
  if (ok("ai_readiness")) about.push([txt(`AI readiness: robots.txt and llms.txt as read by the newest saved ${whiteLabel ? "site" : "crawlmark"} audit (free).`)]);
  if (ok("site_crawl")) about.push([txt(whiteLabel ? "Site crawl: a crawl of the site without JavaScript rendering, the newest one saved." : "Site crawl: crawlmark's own crawl of the site from this machine (free), the newest one saved.")]);
  if (ok("local_profile")) about.push([txt("Local search: Google Business Profile and Google Maps results via DataForSEO (paid).")]);
  if (ok("ai_visibility")) about.push([txt("AI search visibility: DataForSEO LLM Mentions (paid).")]);
  if (ok("keyword_gap")) about.push([txt("Keyword gap: the client's SEO data provider (paid), named in that section.")]);
  // Phase 13 B: name the SEO data provider(s) behind the provider sections (kept in white label: attribution).
  const providerTypes = ["backlinks", "organic_visibility", "competitor_overview"];
  const providers = [...new Set(report.sections.filter((s) => s.status === "ok" && providerTypes.includes(s.type) && sections.some((x) => x.id === s.id)).map((s) => (s as { data: { provider?: string } }).data.provider))]
    .map((p) => ({ dataforseo: "DataForSEO", ahrefs: "Ahrefs", semrush: "Semrush" })[p as "dataforseo"])
    .filter(Boolean);
  if (providers.length) about.push([txt(`Backlinks, organic visibility and competitors: ${providers.join(" and ")} (paid), stored month by month; each figure and its comparison come from the same provider.`)]);
  if (ok("technical_issues")) about.push([txt(`Technical SEO issues: ${whiteLabel ? "saved site audits and crawls" : "crawlmark's saved audits and crawls"}, a stored DataForSEO crawl and Google URL Inspection when available, merged into one list and compared with the previous report.`)]);
  if (ok("indexing_issues")) about.push([txt("Google indexing: Search Console's URL Inspection of a sample of pages and its sitemap report (free, read-only).")]);
  for (const n of [...ctx.notes, ...report.notes]) about.push([txt(n)]);
  for (const s of report.sections) if (s.status === "error") about.push([txt(statusLine(s))]);
  if (notIncluded.length) about.push([txt(`Not included this time (no data for this period): ${notIncluded.join(", ")}.`)]);

  const kpis = keyFigures(report);
  const vs = kpis.length ? kpiComparison(report) : undefined;
  const highlights = report.highlights.map((h): Text => [txt(h.text)]);
  const summary: ReportDoc["summary"] =
    hasNarrative && narrative?.summary?.trim()
      ? { title: "Summary", caption: COMMENTARY_TEXT, narrative: parseNarrative(narrative.summary) }
      : highlights.length
        ? { title: "Highlights", caption: HIGHLIGHTS_CAPTION, items: layout === "onepage" ? highlights.slice(0, ONEPAGE_HIGHLIGHTS) : highlights }
        : undefined;

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
    },
    badge: opts.sample ? "Sample data" : hasNarrative ? "With commentary" : "Data-only report",
    kpis,
    ...(vs ? { kpiCaption: vs } : {}),
    ...(summary ? { summary } : {}),
    sections,
    about,
    footer: footerParts.join(" · "),
    branding: {
      ...(b.agencyName ? { agencyName: b.agencyName } : {}),
      primaryColor: b.primaryColor ?? DEFAULT_PRIMARY,
      accentColor: b.accentColor ?? DEFAULT_ACCENT,
      ...(b.footer ? { footer: b.footer } : {}),
      paper: b.paper ?? "Letter",
      ...(opts.logo ? { logo: opts.logo } : {}),
      ...(whiteLabel ? { hideCrawlmark: true } : {}),
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
