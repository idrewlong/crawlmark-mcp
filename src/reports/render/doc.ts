/**
 * One report model, four renderers (D1). buildReportDoc turns a TemplateReport
 * (plus optional narrative and branding) into a ReportDoc; toMarkdown, toHtml
 * and toDocx are pure functions of it and toPdf prints toHtml's output. Section
 * blocks come from the mapper table in sections.ts. Pure: no I/O (the logo
 * bytes are passed in).
 */
import { basename } from "node:path";
import type { TemplateReport } from "../report-types.js";
import { periodName, rangeLabel } from "../templates/period.js";
import type { ResolvedBranding } from "../templates/load.js";
import { parseNarrative, type Narrative, type NarrativeBlock, type Run } from "./narrative.js";
import { fmtInt, keyFigures, sectionBlocks, statusLine } from "./sections.js";

export type { Run };
/** Inline text: runs of plain, bold or code text. */
export type Text = Run[];

export type Block =
  | { kind: "heading"; level: 1 | 2 | 3; text: string }
  | { kind: "paragraph"; text: Text }
  | { kind: "list"; items: Text[] }
  | { kind: "table"; header: string[]; rows: Text[][]; numeric?: boolean[] }
  | { kind: "kpiRow"; items: Kpi[] }
  | { kind: "note"; text: Text }
  | { kind: "commentary"; blocks: NarrativeBlock[] };

export interface Kpi {
  label: string;
  value: string;
  detail?: string;
}

export interface DocBranding {
  agencyName?: string;
  primaryColor: string;
  accentColor: string;
  footer?: string;
  paper: "Letter" | "A4";
  logo?: { mime: "image/png" | "image/jpeg"; data: Buffer };
}

export interface ReportDoc {
  meta: {
    /** "Example Co - SEO report - September 2026": the document / Google Doc title. */
    title: string;
    clientLine: string;
    reportLine: string;
    compareLine: string;
    generated: string;
    dataOnly: boolean;
  };
  banner: { title: string; text: string };
  kpis: Kpi[];
  highlights: Text[];
  /** The narrative summary, when given. */
  summary?: NarrativeBlock[];
  blocks: Block[];
  sourcesAndNotes: Block[];
  footer: string;
  branding: DocBranding;
}

export const txt = (t: string): Run => ({ t });
export const code = (t: string): Run => ({ t, c: true });
export const bold = (t: string): Run => ({ t, b: true });

const DATA_ONLY_TEXT = "Built automatically from Search Console and Google Analytics. It has no written commentary.";
export const COMMENTARY_TEXT = "Commentary written with Claude; all figures come from the data below.";

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
}

export function buildReportDoc(report: TemplateReport, opts: BuildOptions): ReportDoc {
  const b = opts.branding ?? {};
  const narrative = opts.narrative;
  const hasNarrative = Boolean(narrative && ((narrative.summary ?? "").trim() || Object.values(narrative.sections ?? {}).some((v) => v.trim())));
  const p = report.period;
  const comparisons = [p.comparisons.previous_period, p.comparisons.previous_year].filter((r): r is NonNullable<typeof r> => Boolean(r));

  const blocks: Block[] = [];
  report.sections.forEach((s, i) => {
    blocks.push({ kind: "heading", level: 2, text: `${i + 1} ${s.title}` });
    blocks.push(...sectionBlocks(s, report));
    const commentary = narrative?.sections?.[s.id];
    if (commentary?.trim()) blocks.push({ kind: "commentary", blocks: parseNarrative(commentary) });
  });

  const sourcesAndNotes: Block[] = [
    { kind: "heading", level: 2, text: "Data sources and notes" },
    {
      kind: "list",
      items: [
        [txt(`Period: ${rangeLabel(p.current)}.`)],
        ...(p.comparisons.previous_period ? [[txt(`Previous period: ${rangeLabel(p.comparisons.previous_period)}.`)]] : []),
        ...(p.comparisons.previous_year ? [[txt(`Previous year: ${rangeLabel(p.comparisons.previous_year)}.`)]] : []),
        [txt("Sources: Google Search Console (search), Google Analytics 4 (organic traffic), saved crawlmark audits, the Chrome UX Report and Google Tag Manager when those sections are included.")],
        [txt("Search Console counts anonymized queries in its totals but not in the query tables, so the query tables don't add up to the totals.")],
      ],
    },
  ];
  // Phase 12 B sources, listed only when those sections are in the report.
  const ok = (type: string) => report.sections.some((s) => s.type === type && s.status === "ok");
  const extraSources: Text[] = [];
  if (ok("rank_trend")) extraSources.push([txt("Rank trends: crawlmark's stored rank checks (Search Console 7-day averages; live ranks from DataForSEO when they were checked).")]);
  if (ok("bing_overview")) extraSources.push([txt("Bing: Bing Webmaster Tools (free, read-only). Bing updates query and page stats weekly.")]);
  if (ok("ai_readiness")) extraSources.push([txt("AI readiness: robots.txt and llms.txt as read by the newest saved crawlmark audit (free).")]);
  if (ok("site_crawl")) extraSources.push([txt("Site crawl: crawlmark's own crawl of the site from this machine (free), the newest one saved.")]);
  if (ok("keyword_gap")) extraSources.push([txt("Keyword gap: the client's SEO data provider (paid), named in that section.")]);
  if (extraSources.length) sourcesAndNotes.push({ kind: "list", items: extraSources });
  const statuses = report.sections.filter((s) => s.status !== "ok");
  if (statuses.length) sourcesAndNotes.push({ kind: "list", items: statuses.map((s) => [txt(statusLine(s))]) });
  if (report.notes.length) sourcesAndNotes.push({ kind: "list", items: report.notes.map((n) => [txt(n)]) });
  if (report.spend.usd > 0 || report.spend.units.ahrefs > 0 || report.spend.units.semrush > 0) {
    sourcesAndNotes.push({ kind: "paragraph", text: [txt(`Paid data for this report: $${report.spend.usd.toFixed(4)}, ${fmtInt(report.spend.units.ahrefs)} Ahrefs units, ${fmtInt(report.spend.units.semrush)} Semrush units.`)] });
  }
  if (opts.branding?.logo && !opts.logo) sourcesAndNotes.push({ kind: "note", text: [txt(`The logo (${basename(opts.branding.logo.path)}) couldn't be used, so the report has none.`)] });

  const footerParts = [b.footer, `crawlmark ${opts.version}`].filter((x): x is string => Boolean(x && x.trim()));
  return {
    meta: {
      title: `${report.client.name} - SEO report - ${p.label}`,
      clientLine: `${report.client.name} (${report.client.domain})`,
      reportLine: `${report.template.title} · ${p.label} (${rangeLabel(p.current)})`,
      compareLine: `${comparisons.length ? `Compared with ${comparisons.map(periodName).join(" and ")} · ` : ""}Generated ${day(report.generatedAt)}`,
      generated: report.generatedAt,
      dataOnly: !hasNarrative,
    },
    banner: hasNarrative ? { title: "Commentary", text: COMMENTARY_TEXT } : { title: "Data-only report", text: DATA_ONLY_TEXT },
    kpis: keyFigures(report),
    highlights: report.highlights.map((h) => [txt(h.text)]),
    ...(hasNarrative && narrative?.summary?.trim() ? { summary: parseNarrative(narrative.summary) } : {}),
    blocks,
    sourcesAndNotes,
    footer: footerParts.join(" · "),
    branding: {
      ...(b.agencyName ? { agencyName: b.agencyName } : {}),
      primaryColor: b.primaryColor ?? "#1f4e79",
      accentColor: b.accentColor ?? "#2e8540",
      ...(b.footer ? { footer: b.footer } : {}),
      paper: b.paper ?? "Letter",
      ...(opts.logo ? { logo: opts.logo } : {}),
    },
  };
}
