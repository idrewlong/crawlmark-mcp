/**
 * DOCX renderer (D6): WordprocessingML built from the ReportDoc with the docx
 * library, not converted from HTML, so headings, lists and tables come out as
 * real Word structures in Word, Google Docs and LibreOffice. It follows the
 * HTML file's hierarchy: a shaded cover band, a row of four key-figure cells,
 * a summary callout, one Heading 2 per section, light ruled tables, and an
 * "About this report" section. Charts are native Word charts (docx's
 * ChartRun: drawn by Word from data embedded in the file, editable with "Edit
 * Data"), so the file needs no Chrome and no image. All text passes docxText
 * (control and XML-invalid characters removed); docx XML-escapes it.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableLayoutType,
  TableRow,
  TextRun,
  VerticalAlign,
  WidthType,
  type ParagraphChild,
} from "docx";
import { ChartRun, type ChartRunOptions } from "docx/charts";
import { DEFAULT_ACCENT, DEFAULT_PRIMARY, NEUTRAL, SERIES, TONE, inkOn, mix, softTextOn, textOn } from "./color.js";
import type { Block, Chart, Kpi, LineChart, ReportDoc, TableBlock, Text } from "./doc.js";
import { docxText, safeColor } from "./escape.js";
import { fit, imageSize } from "./image.js";
import type { NarrativeBlock } from "./narrative.js";
import { niceStep, shareColors, wholeStep } from "./svg.js";

const PAGE = { Letter: { width: 12240, height: 15840 }, A4: { width: 11906, height: 16838 } } as const;
/** 15 mm in twips. */
const MARGIN = 850;
const FONT = "Calibri";
const MONO = "Consolas";
const hex = (c: string) => c.replace("#", "").toUpperCase();
const H = { ink: hex(NEUTRAL.ink), muted: hex(NEUTRAL.muted), faint: hex(NEUTRAL.faint), rule: hex(NEUTRAL.rule), zebra: hex(NEUTRAL.zebra), surface: hex(NEUTRAL.surface) };
const TAG = { good: TONE.good.fg, bad: TONE.bad.fg, warn: "#8a5300", neutral: TONE.neutral.fg } as const;
const ARROW = { up: "▲", down: "▼", flat: "–" } as const;

interface Ctx {
  primary: string;
  primaryInk: string;
  /** Usable text width in twips. */
  width: number;
}

function runs(t: Text, opts: { italics?: boolean; color?: string; size?: number } = {}): TextRun[] {
  return t.flatMap((r, i) => [
    ...(r.tag && i > 0 ? [new TextRun({ text: " ", ...(opts.size ? { size: opts.size } : {}) })] : []),
    new TextRun({
      text: docxText(r.t),
      ...(r.b || r.tag || r.tone ? { bold: true } : {}),
      ...(r.c ? { font: MONO, size: 17 } : opts.size ? { size: opts.size } : {}),
      ...(r.tag ? { size: 15, allCaps: true, color: hex(TAG[r.tag]) } : {}),
      ...(r.tone ? { color: hex(TONE[r.tone].fg) } : {}),
      ...(opts.italics ? { italics: true } : {}),
      ...(opts.color && !r.tone && !r.tag ? { color: opts.color } : {}),
    }),
  ]);
}

const none = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
const line = (color: string, size = 4) => ({ style: BorderStyle.SINGLE, size, color });
const noBorders = { top: none, bottom: none, left: none, right: none };

/**
 * Column widths in twips: text columns wider than numeric ones (the first widest). Explicit widths and a fixed
 * layout, because Google Docs, Pages and Quick Look lay tables out from the grid alone.
 */
export function columnWidths(numeric: boolean[], total: number): number[] {
  const w = numeric.map((n, i) => (n ? 1 : i === 0 ? 2.4 : 1.7));
  const sum = w.reduce((a, b) => a + b, 0);
  const out = w.map((x) => Math.floor((x / sum) * total));
  out[0]! += total - out.reduce((a, b) => a + b, 0);
  return out;
}

function table(b: TableBlock, ctx: Ctx): (Paragraph | Table)[] {
  const align = (i: number) => (b.numeric?.[i] ? AlignmentType.RIGHT : AlignmentType.LEFT);
  const margins = { top: 50, bottom: 50, left: 90, right: 90 };
  const widths = columnWidths(b.header.map((_, i) => Boolean(b.numeric?.[i])), ctx.width);
  const t = new Table({
    width: { size: ctx.width, type: WidthType.DXA },
    columnWidths: widths,
    layout: TableLayoutType.FIXED,
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: [
      new TableRow({
        tableHeader: true,
        cantSplit: true,
        children: b.header.map(
          (h, i) =>
            new TableCell({
              width: { size: widths[i]!, type: WidthType.DXA },
              margins,
              verticalAlign: VerticalAlign.BOTTOM,
              borders: { ...noBorders, bottom: line("CBD2D9", 8) },
              children: [new Paragraph({ alignment: align(i), children: [new TextRun({ text: docxText(h), bold: true, size: 15, allCaps: true, color: H.muted })] })],
            }),
        ),
      }),
      ...b.rows.map(
        (r, ri) =>
          new TableRow({
            cantSplit: true,
            children: r.map(
              (c, i) =>
                new TableCell({
                  width: { size: widths[i] ?? 0, type: WidthType.DXA },
                  margins,
                  borders: { ...noBorders, bottom: line(H.rule) },
                  ...(ri % 2 === 1 ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: H.zebra } } : {}),
                  children: [new Paragraph({ alignment: align(i), children: runs(c, { size: 18 }) })],
                }),
            ),
          }),
      ),
    ],
  });
  return [...(b.title ? [new Paragraph({ keepNext: true, spacing: { before: 120, after: 60 }, children: [new TextRun({ text: docxText(b.title), bold: true, size: 19, color: H.ink })] })] : []), t, spacer()];
}

/** A full-width one-cell table (cover band, callouts) with a fixed grid. */
function oneCell(ctx: Ctx, cell: TableCell): Table {
  return new Table({
    width: { size: ctx.width, type: WidthType.DXA },
    columnWidths: [ctx.width],
    layout: TableLayoutType.FIXED,
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: [new TableRow({ cantSplit: true, children: [cell] })],
  });
}

/** A shaded one-cell box with a coloured left rule: the summary callout and commentary boxes. */
function box(ctx: Ctx, paragraphs: Paragraph[], fill: string, rule: string): Table {
  return oneCell(ctx, new TableCell({ width: { size: ctx.width, type: WidthType.DXA }, margins: { top: 120, bottom: 120, left: 200, right: 200 }, borders: { ...noBorders, left: line(rule, 24) }, shading: { type: ShadingType.CLEAR, color: "auto", fill }, children: paragraphs }));
}

function narrative(blocks: NarrativeBlock[]): Paragraph[] {
  return blocks.flatMap((b) => (b.kind === "p" ? [new Paragraph({ children: runs(b.runs), spacing: { after: 80 } })] : b.items.map((i) => new Paragraph({ bullet: { level: 0 }, children: runs(i) }))));
}

const label = (s: string, color: string) => new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: docxText(s), bold: true, size: 15, allCaps: true, color })] });

function commentary(blocks: NarrativeBlock[], ctx: Ctx): Table {
  return box(ctx, [label("Commentary", hex(ctx.primaryInk)), ...narrative(blocks)], hex(mix(ctx.primary, "#ffffff", 0.93)), hex(ctx.primary));
}

const spacer = (after = 80) => new Paragraph({ children: [], spacing: { after } });

/** Key-figure cells (the KPI row, and tiles inside sections), at most `perRow` to a row. */
function kpiCells(items: Kpi[], ctx: Ctx, big: boolean, perRow: number): Table {
  const rows: Kpi[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  const cols = Math.min(perRow, items.length);
  const w = Math.floor(ctx.width / cols);
  const cell = (k: Kpi | undefined) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      margins: { top: 110, bottom: 110, left: 150, right: 110 },
      borders: { top: line("FFFFFF", 12), bottom: line("FFFFFF", 12), left: line("FFFFFF", 12), right: line("FFFFFF", 12) },
      shading: { type: ShadingType.CLEAR, color: "auto", fill: k ? (big ? "F1F4F8" : H.zebra) : "FFFFFF" },
      children: k
        ? [
            label(k.label, H.muted),
            new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: docxText(k.value), bold: true, size: big ? 40 : 30, color: k.tone && k.tone !== "neutral" ? hex(TONE[k.tone].fg) : H.ink })] }),
            ...(k.delta ? [new Paragraph({ children: [new TextRun({ text: `${ARROW[k.delta.dir]} ${docxText(k.delta.text)}`, bold: true, size: 17, color: hex(TONE[k.delta.tone].fg) })] })] : []),
            ...(k.detail ? [new Paragraph({ children: [new TextRun({ text: docxText(k.detail), size: 15, color: H.muted })] })] : []),
          ]
        : [new Paragraph({ children: [] })],
    });
  return new Table({
    width: { size: w * cols, type: WidthType.DXA },
    columnWidths: Array.from({ length: cols }, () => w),
    layout: TableLayoutType.FIXED,
    borders: { top: none, bottom: none, left: none, right: none, insideHorizontal: none, insideVertical: none },
    rows: rows.map((r) => new TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, i) => cell(r[i])) })),
  });
}

/** The value-axis major unit for counts and positions: the same nice step as the HTML chart, at least 1. */
export function wholeInterval(c: LineChart): number {
  const vals = c.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const min = c.invert ? 1 : 0;
  const top = vals.length ? Math.max(...vals) : min + 1;
  return wholeStep(niceStep((top - min) / 4 || 1));
}

/** A native Word chart: line charts for the daily and trend series, a 100% stacked bar for shares. */
function chart(c: Chart, ctx: Ctx, half: boolean): (Paragraph | Table)[] {
  const px = Math.round((ctx.width / 1440) * 96 * (half ? 0.49 : 1));
  const font = { name: FONT };
  const axisFont = { size: 8, color: H.muted };
  let opts: ChartRunOptions;
  if (c.type === "line") {
    const cats = c.x.map((d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]}` : docxText(d)));
    const color = (s: (typeof c.series)[number]) => hex(s.role === "current" ? inkOn(ctx.primary, "#ffffff", 3) : s.role === "previous" ? NEUTRAL.previous : SERIES[(s.index ?? 0) % SERIES.length]!);
    opts = {
      type: "line",
      font,
      title: { text: docxText(c.title), font: { size: 10, bold: true, color: H.ink } },
      categories: cats,
      series: c.series.map((s) => ({ name: docxText(s.name), values: s.values.slice(0, cats.length).map((x) => (x !== null && Number.isFinite(x) ? x : null)), color: color(s), line: { color: color(s), width: s.role === "previous" ? 1.25 : 2, dash: s.role === "previous" ? ("dash" as const) : ("solid" as const) }, markers: false })),
      emptyValues: c.connectGaps ? "connect" : "gap",
      legend: c.series.length > 1 ? { position: "top", font: { size: 8, color: H.muted } } : false,
      categoryAxis: { font: axisFont, gridlines: false },
      valueAxis: {
        font: axisFont,
        numberFormat: c.format === "score" ? "0.00" : c.format === "position" ? "0" : "#,##0",
        ...(c.invert ? { reverseOrder: true, minimum: 1 } : { minimum: 0 }),
        // Whole-number labels need a whole-number major unit, or Word prints "1, 1, 2, 2".
        ...(c.format === "count" || c.format === "position" ? { interval: wholeInterval(c) } : {}),
      },
      chartArea: { fill: "FFFFFF", border: "none" },
      transformation: { width: px, height: Math.round(px * (half ? 0.62 : 0.34)) },
      altText: { name: docxText(c.title), description: docxText(c.summary), title: docxText(c.title) },
    };
  } else {
    const colors = shareColors(ctx.primary, c.parts.length).map(hex);
    opts = {
      type: "bar",
      font,
      title: { text: docxText(c.title), font: { size: 10, bold: true, color: H.ink } },
      categories: [...c.rows].reverse().map((r) => docxText(r.label)),
      series: c.parts.map((p, i) => ({ name: docxText(p), values: [...c.rows].reverse().map((r) => { const x = r.values[i]; return x !== undefined && Number.isFinite(x) ? x : 0; }), color: colors[i % colors.length]! })),
      stacking: "percent",
      gapWidth: 60,
      legend: { position: "top", font: { size: 8, color: H.muted } },
      categoryAxis: { font: axisFont },
      valueAxis: { font: axisFont, numberFormat: "0%" },
      chartArea: { fill: "FFFFFF", border: "none" },
      transformation: { width: px, height: Math.max(110, 50 + c.rows.length * 40) },
      altText: { name: docxText(c.title), description: docxText(c.summary), title: docxText(c.title) },
    };
  }
  return [new Paragraph({ keepNext: false, spacing: { after: 80 }, children: [new ChartRun(opts)] })];
}

function block(b: Block, ctx: Ctx, half = false): (Paragraph | Table)[] {
  switch (b.kind) {
    case "heading":
      return [new Paragraph({ heading: HeadingLevel.HEADING_3, keepNext: true, children: [new TextRun({ text: docxText(b.text) })] })];
    case "paragraph":
      return [new Paragraph({ children: runs(b.text), spacing: { after: 100 } })];
    case "note":
      return [new Paragraph({ children: runs(b.text, { color: H.muted, size: 16 }), spacing: { after: 100 } })];
    case "list":
      return b.items.map((i) => new Paragraph({ bullet: { level: 0 }, children: runs(i) }));
    case "table":
      return table(b, ctx);
    case "kpiRow":
      return [kpiCells(b.items, ctx, false, b.items.length > 6 ? 5 : 4), spacer()];
    case "commentary":
      return [commentary(b.blocks, ctx), spacer()];
    case "chart":
      return chart(b.chart, ctx, half);
    case "columns":
      return b.columns.flat().flatMap((x) => block(x, ctx, false));
  }
}

function sectionHeading(title: string, ctx: Ctx): Paragraph {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: H.rule, space: 4 } },
    children: [new TextRun({ text: docxText(title), color: hex(ctx.primaryInk), bold: true, size: 28 })],
  });
}

function cover(doc: ReportDoc, ctx: Ctx): Table {
  const b = doc.branding;
  const on = hex(textOn(ctx.primary));
  const soft = hex(softTextOn(textOn(ctx.primary), ctx.primary));
  const m = doc.meta;
  const logo = b.logo;
  const size = logo ? imageSize(logo.data) : undefined;
  const brandRuns: ParagraphChild[] = [
    ...(logo && size ? [new ImageRun({ type: logo.mime === "image/png" ? "png" : "jpg", data: logo.data, transformation: fit(size, 140, 40), altText: { name: "logo", description: docxText(b.agencyName ?? "Logo"), title: "Logo" } })] : []),
    ...(b.agencyName ? [new TextRun({ text: `${logo && size ? "   " : ""}${docxText(b.agencyName)}`, bold: true, size: 20, color: on })] : []),
  ];
  const meta = [`Period: ${m.periodLabel} · ${m.periodRange}`, ...(m.compareWith ? [`Compared with: ${m.compareWith}`] : []), `Generated: ${m.generated}`];
  const paragraphs = [
    ...(brandRuns.length ? [new Paragraph({ spacing: { after: 160 }, children: brandRuns })] : []),
    new Paragraph({ children: [new TextRun({ text: docxText(m.templateTitle), allCaps: true, bold: true, size: 16, color: soft })] }),
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 20 }, children: [new TextRun({ text: docxText(m.clientName), bold: true, size: 52, color: on })] }),
    new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: docxText(m.domain), size: 22, color: soft })] }),
    new Paragraph({ children: meta.flatMap((x, i) => [...(i ? [new TextRun({ text: "     ", size: 18 })] : []), new TextRun({ text: docxText(x), size: 18, bold: true, color: on })]) }),
    new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: docxText(doc.badge), allCaps: true, size: 15, color: soft })] }),
  ];
  return oneCell(
    ctx,
    new TableCell({ width: { size: ctx.width, type: WidthType.DXA }, margins: { top: 260, bottom: 220, left: 320, right: 320 }, borders: { ...noBorders, bottom: line(hex(safeColor(doc.branding.accentColor, DEFAULT_ACCENT)), 36) }, shading: { type: ShadingType.CLEAR, color: "auto", fill: hex(ctx.primary) }, children: paragraphs }),
  );
}

export async function toDocx(doc: ReportDoc): Promise<Buffer> {
  const primary = safeColor(doc.branding.primaryColor, DEFAULT_PRIMARY);
  const page = PAGE[doc.branding.paper];
  const ctx: Ctx = { primary, primaryInk: inkOn(primary), width: page.width - 2 * MARGIN };
  const children: (Paragraph | Table)[] = [cover(doc, ctx), spacer(160)];

  if (doc.kpis.length) {
    children.push(kpiCells(doc.kpis, ctx, true, 4));
    if (doc.kpiCaption) children.push(new Paragraph({ alignment: AlignmentType.RIGHT, spacing: { before: 40, after: 160 }, children: [new TextRun({ text: docxText(doc.kpiCaption), size: 15, color: H.faint })] }));
  }
  if (doc.summary) {
    const s = doc.summary;
    children.push(
      box(
        ctx,
        [
          label(s.title, hex(ctx.primaryInk)),
          ...(s.narrative ? narrative(s.narrative) : []),
          ...(s.items ?? []).map((h) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: runs(h, { size: 19 }) })),
          new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: docxText(s.caption), size: 15, color: H.faint })] }),
        ],
        hex(mix(primary, "#ffffff", 0.94)),
        hex(primary),
      ),
      spacer(120),
    );
  }
  for (const s of doc.sections) {
    children.push(sectionHeading(s.title, ctx));
    for (const b of s.blocks) children.push(...block(b, ctx));
    if (s.commentary) children.push(commentary(s.commentary, ctx), spacer());
  }
  children.push(sectionHeading("About this report", ctx));
  children.push(...doc.about.map((a) => new Paragraph({ bullet: { level: 0 }, children: runs(a, { color: H.muted, size: 16 }) })));

  const small = { color: H.faint, size: 15 };
  const footerRuns: ParagraphChild[] = [new TextRun({ text: `${doc.footer.trim() ? `${docxText(doc.footer)}   ·   ` : ""}Page `, ...small }), new TextRun({ children: [PageNumber.CURRENT], ...small }), new TextRun({ text: " of ", ...small }), new TextRun({ children: [PageNumber.TOTAL_PAGES], ...small })];
  const document = new Document({
    title: docxText(doc.meta.title),
    creator: doc.branding.hideCrawlmark ? docxText(doc.branding.agencyName ?? "") : "crawlmark",
    description: doc.meta.dataOnly ? "Data-only report" : "Report with commentary",
    styles: {
      default: { document: { run: { font: FONT, size: 20, color: H.ink }, paragraph: { spacing: { line: 264 } } } },
      paragraphStyles: [
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 28, bold: true }, paragraph: { keepNext: true } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: FONT, size: 21, bold: true }, paragraph: { keepNext: true, spacing: { before: 160, after: 60 } } },
      ],
    },
    sections: [
      {
        properties: { page: { size: page, margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN, header: 400, footer: 400 } } },
        headers: { default: new Header({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun({ text: docxText(doc.meta.runningHeader), ...small })] })] }) },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footerRuns })] }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
