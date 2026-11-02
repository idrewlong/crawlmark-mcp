/**
 * Hand-written deck fixtures for the PPTX writer tests (T3a): every slide kind and every section layout, with
 * example.com data only. Also a fixed chart part (stands in for pptx/charts.ts in unit tests), a strict-enough
 * XML well-formedness check, and zip helpers.
 */
import JSZip from "jszip";
import type { Deck, DeckSlide } from "../../../src/reports/render/deck.js";
import type { LineChart } from "../../../src/reports/render/doc.js";
import type { DeckStyle } from "../../../src/reports/render/pptx/index.js";
import { deckTheme } from "../../../src/reports/render/themes/deck-themes.js";
import { themePalette } from "../../../src/reports/render/themes/palette.js";
import type { ThemeId } from "../../../src/reports/templates/schema.js";

export const CONTROL = "\u0007";
export const NASTY = `A < B & "C" 'D'${CONTROL}`;

export const lineChart = (title = "Clicks per day"): LineChart => ({
  type: "line",
  title,
  x: ["2026-09-01", "2026-09-02", "2026-09-03"],
  series: [
    { name: "September 2026", values: [10, 20, 30], role: "current" },
    { name: "August 2026", values: [8, 15, 25], role: "previous" },
  ],
  format: "count",
  summary: "Clicks rose from 10 to 30 over September.",
  fallback: { kind: "table", header: ["Day", "Clicks"], rows: [[[{ t: "1 Sep" }], [{ t: "10" }]], [[{ t: "2 Sep" }], [{ t: "20" }]]], numeric: [false, true] },
});

const kpi = (label: string, value: string) => ({ label, value, delta: { text: "17.6%", dir: "up" as const, tone: "good" as const }, detail: "vs 952" });
const table = (cols = 3, rows = 4) => ({
  header: Array.from({ length: cols }, (_, i) => (i === 0 ? "Page" : `Metric ${i}`)),
  rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => (c === 0 ? `/page-${r + 1}` : String((r + 1) * (c + 10))))),
  numeric: Array.from({ length: cols }, (_, i) => i > 0),
  shown: rows,
  total: rows + 10,
});

export function fixtureDeck(opts: { logo?: boolean; author?: string; company?: string; agencyName?: string } = {}): Deck {
  const agencyName = opts.agencyName ?? "Example Agency";
  const slides: DeckSlide[] = [
    { kind: "title", title: "Example Co", kicker: "Monthly SEO report", subtitle: "Quarterly check-in", domain: "example.com", entries: [{ label: "Prepared for", value: "Jane Doe, Example Co" }, { label: "Period", value: "September 2026 · 1–30 Sep 2026" }, { label: "Generated", value: "13 Oct 2026" }], badge: "With commentary", agencyName, logo: opts.logo ?? false },
    { kind: "agenda", title: "Agenda", items: ["Search performance", "Top pages", "Tracked keywords", "Opportunities", "Glossary"] },
    { kind: "kpis", title: "Key numbers", kpis: [kpi("Clicks", "1,120"), kpi("Impressions", "20,000"), kpi("CTR", "5.60%"), { label: "Average position", value: "7.5", delta: { text: "0.7 better", dir: "down", tone: "good" }, detail: "from 8.2 · lower is better" }], caption: "Change vs August 2026 (previous period)" },
    { kind: "summary", title: "Summary", bullets: ["Clicks grew 17.6% in September.", "Update the services pages", "Fix the broken links"], caption: "Written commentary; all figures come from the data below.", notes: "Clicks grew 17.6% in September. Impressions followed.\n\n- Update the services pages" },
    { kind: "section", sectionId: "search", title: "Search performance", number: 1, continued: false, chart: lineChart(), table: table(), bullets: ["Clicks rose on service pages.", "Two pages reached page one."], footnotes: ["Top 4 of 14 rows; the full table is in the report."], notes: "Clicks rose on service pages. Two pages reached page one." },
    { kind: "section", sectionId: "search", title: "Search performance (continued)", number: 1, continued: true, table: table(6, 8), bullets: [], footnotes: [] },
    { kind: "section", sectionId: "pages", title: "Top pages", number: 2, continued: false, chart: lineChart("Sessions"), table: table(4, 5), bullets: [], footnotes: ["Source: Ahrefs"] },
    { kind: "section", sectionId: "keywords", title: "Tracked keywords", number: 3, continued: false, table: table(5, 8), tiles: [kpi("Tracked", "42"), kpi("Top 3", "7")], bullets: [], footnotes: [] },
    { kind: "section", sectionId: "cwv", title: "Core Web Vitals", number: 4, continued: false, tiles: [kpi("LCP", "2.1 s"), kpi("INP", "180 ms"), kpi("CLS", "0.05"), kpi("TTFB", "0.6 s"), kpi("FCP", "1.4 s")], bullets: ["All three vitals are in the good range."], footnotes: [] },
    { kind: "section", sectionId: "opportunities", title: "Opportunities", number: 5, continued: false, bullets: ["Refresh the blog post on pricing.", "Add FAQ markup to service pages."], footnotes: ["More detail in the full report."] },
    { kind: "text", sectionId: "glossary", title: "Glossary", continued: false, bullets: ["CTR: clicks divided by impressions.", "Position: the average rank in results."], notes: "CTR: clicks divided by impressions.\nPosition: the average rank in results." },
    { kind: "closing", title: "Thank you", agencyName, lines: ["Example Agency · hello@example.com", "Generated 13 Oct 2026"], logo: opts.logo ?? false, notes: "Period: 1–30 Sep 2026.\nSources: Search Console and Google Analytics." },
  ];
  return {
    meta: { title: "Example Co - SEO report - September 2026", subject: "Monthly SEO report", author: opts.author ?? "crawlmark", company: opts.company ?? "", generatedAt: "2026-10-13T00:00:00.000Z" },
    slides,
    warnings: [],
  };
}

export function styleFor(theme: ThemeId, o: { primary?: string; accent?: string; body?: string; heading?: string; logo?: DeckStyle["logo"] } = {}): DeckStyle {
  const t = deckTheme(theme);
  return {
    theme,
    palette: themePalette(o.primary ?? "#1f5ea8", o.accent ?? "#5b9bd5"),
    deck: t,
    fonts: { body: o.body ?? t.fonts.body, heading: o.heading ?? o.body ?? t.fonts.heading },
    footer: "Example Agency · hello@example.com",
    ...(o.logo ? { logo: o.logo } : {}),
  };
}

/** A fixed chart part (a small but complete c:chartSpace) and a workbook zip, standing in for chartPart. */
export async function fixedChartPart(): Promise<{ xml: string; workbook: Buffer }> {
  const wb = new JSZip();
  wb.file("xl/workbook.xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"/>`, { date: new Date(Date.UTC(2026, 0, 1)), createFolders: false });
  const workbook = await wb.generateAsync({ type: "nodebuffer" });
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<c:chart><c:autoTitleDeleted val="1"/><c:plotArea><c:layout/><c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>` +
    `<c:ser><c:idx val="0"/><c:order val="0"/><c:cat><c:strLit><c:ptCount val="2"/><c:pt idx="0"><c:v>1 Sep</c:v></c:pt><c:pt idx="1"><c:v>2 Sep</c:v></c:pt></c:strLit></c:cat><c:val><c:numLit><c:ptCount val="2"/><c:pt idx="0"><c:v>10</c:v></c:pt><c:pt idx="1"><c:v>20</c:v></c:pt></c:numLit></c:val></c:ser>` +
    `<c:marker val="1"/><c:axId val="1"/><c:axId val="2"/></c:lineChart>` +
    `<c:catAx><c:axId val="1"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:crossAx val="2"/></c:catAx>` +
    `<c:valAx><c:axId val="2"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:crossAx val="1"/></c:valAx>` +
    `</c:plotArea><c:plotVisOnly val="1"/></c:chart><c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>`;
  return { xml, workbook };
}

export async function unzip(buf: Buffer): Promise<JSZip> {
  return JSZip.loadAsync(buf);
}

export async function text(zip: JSZip, name: string): Promise<string> {
  const f = zip.file(name);
  if (!f) throw new Error(`missing part ${name}`);
  return f.async("string");
}

/** All parts of a deck as text (XML and rels only). */
export async function xmlParts(zip: JSZip): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const name of Object.keys(zip.files).sort()) if (/\.(xml|rels)$/.test(name)) out.set(name, await text(zip, name));
  return out;
}

/**
 * A well-formedness check good enough to catch builder mistakes: one root, tags balanced and properly nested,
 * attributes quoted and unique, entities known, no raw `<` or `&` in text. Returns the problem, or null.
 */
export function wellFormed(xml: string): string | null {
  const body = xml.replace(/^<\?xml[^?]*\?>\s*/, "");
  const stack: string[] = [];
  let roots = 0;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*(?:"[^"<]*"|'[^'<]*'))*)\s*(\/?)>|([^<]+)|(<)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body))) {
    if (m[6]) return `stray < at ${m.index}`;
    if (m[5] !== undefined) {
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(m[5])) return `bad entity near ${m[5].slice(0, 40)}`;
      if (!stack.length && m[5].trim()) return "text outside the root";
      continue;
    }
    const [, close, name, attrs, self] = m;
    if (attrs) {
      const names = [...attrs.matchAll(/([\w.:-]+)\s*=/g)].map((a) => a[1]);
      if (new Set(names).size !== names.length) return `duplicate attribute in <${name}>`;
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(attrs)) return `bad entity in <${name}>`;
    }
    if (close) {
      if (stack.pop() !== name) return `mismatched </${name}>`;
    } else if (!self) {
      if (!stack.length) roots++;
      stack.push(name!);
    } else if (!stack.length) roots++;
  }
  if (stack.length) return `unclosed <${stack.at(-1)}>`;
  return roots === 1 ? null : `${roots} root elements`;
}

/** The child element names of the first `<tag>` (direct children only). */
export function childNames(xml: string, tag: string): string[] {
  const start = xml.indexOf(`<${tag}`);
  const open = xml.indexOf(">", start) + 1;
  const names: string[] = [];
  let depth = 0;
  const re = /<(\/?)([A-Za-z_][\w.:-]*)[^>]*?(\/?)>/g;
  re.lastIndex = open;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    if (m[1]) {
      if (depth === 0) break;
      depth--;
    } else {
      if (depth === 0) names.push(m[2]!);
      if (!m[3]) depth++;
    }
  }
  return names;
}
