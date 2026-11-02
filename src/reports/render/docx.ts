/**
 * DOCX renderer (D6): WordprocessingML built from the ReportDoc with the docx
 * library, not converted from HTML, so headings, lists and tables come out as
 * real Word structures in Word, Google Docs and LibreOffice. It follows the
 * HTML file's hierarchy: a cover block, a row of four key-figure cells,
 * a summary callout, one Heading 2 per section, light ruled tables, and an
 * "About this report" section. The report theme (themes/docx-themes.ts) sets
 * the fonts, cover, headings, tables, key-figure cells and callouts; cards is
 * the 0.3.0 look. Charts are native Word charts (docx's ChartRun, options from
 * chart-options.ts, shared with the PowerPoint export: drawn by Word from data
 * embedded in the file, editable with "Edit Data"), so the file needs no Chrome
 * and no image. All text passes docxText (control and XML-invalid characters
 * removed); docx XML-escapes it.
 */
import {
  AlignmentType,
  Bookmark,
  BorderStyle,
  Document,
  Footer,
  Header,
  HeadingLevel,
  ImageRun,
  InternalHyperlink,
  LevelFormat,
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
import { ChartRun } from "docx/charts";
import { DEFAULT_ACCENT, DEFAULT_PRIMARY, NEUTRAL, TONE, inkOn, mix } from "./color.js";
import { coverEntries, type Block, type Chart, type DocNarrativeBlock, type Kpi, type ReportDoc, type TableBlock, type Text } from "./doc.js";
import { docxText, safeColor } from "./escape.js";
import { fit, imageSize } from "./image.js";
import { chartRunOptions } from "./chart-options.js";
import { docxTheme, type DocxTheme } from "./themes/index.js";
import type { DocxColour, Rule } from "./themes/docx-themes.js";
import { themePalette, type ThemePalette } from "./themes/palette.js";

export { wholeInterval } from "./chart-options.js";

const PAGE = { Letter: { width: 12240, height: 15840 }, A4: { width: 11906, height: 16838 } } as const;
/** 15 mm in twips. */
const MARGIN = 850;
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
  /** The body font name (charts use it). */
  font: string;
  /** The heading font name. */
  headFont: string;
  t: DocxTheme;
  pal: ThemePalette;
  /** Numbered commentary lists: each list gets its own instance so numbering restarts. */
  ol: { next(): number };
}

/** A theme colour reference as an uppercase hex string without the #. */
function col(ctx: Ctx, c: DocxColour): string {
  if (c.startsWith("#")) return hex(c);
  const p = ctx.pal;
  const dark = ctx.t.cover.fill === "dark";
  const map: Record<string, string> = {
    primary: p.primary,
    primaryInk: p.primaryInk,
    accent: p.accent,
    ink: NEUTRAL.ink,
    muted: NEUTRAL.muted,
    dark: p.dark,
    onDark: p.onDark,
    onDarkSoft: p.onDarkSoft,
    onDarkSubtle: p.onDarkSubtle,
    darkRule: p.darkRule,
    onFill: dark ? p.onDark : p.onPrimary,
    onFillSoft: dark ? p.onDarkSoft : p.onPrimarySoft,
    tint: p.tint,
    tintInk: p.tintInk,
    warm: p.warm,
    wash: p.wash,
  };
  return hex(map[c] ?? NEUTRAL.ink);
}

const ruleLine = (ctx: Ctx, r: Rule) => line(col(ctx, r.color), r.size);

/** The numbering reference for a commentary list that starts at `start`. */
const olReference = (start: number) => (start === 1 ? "narrative-ol" : `narrative-ol-${start}`);

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
  const th = ctx.t.table;
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
              borders: { ...noBorders, bottom: ruleLine(ctx, th.headerRule) },
              children: [
                new Paragraph({
                  alignment: align(i),
                  children: [new TextRun({ text: docxText(h), ...(th.headerBold ? { bold: true } : {}), ...(th.headerItalic ? { italics: true } : {}), size: th.headerSize, ...(th.headerCaps ? { allCaps: true } : {}), color: col(ctx, th.headerColor) })],
                }),
              ],
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
                  borders: { ...noBorders, ...(th.rowRule ? { bottom: ruleLine(ctx, th.rowRule) } : {}) },
                  ...(ri % 2 === 1 && th.zebra ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: col(ctx, th.zebra) } } : {}),
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

/** A one-cell box: the summary callout and commentary boxes. Fill and rules come from the theme. */
function box(ctx: Ctx, paragraphs: (Paragraph | Table)[], fill: string | null): Table {
  const c = ctx.t.callout;
  const borders = { ...noBorders, ...(c.left ? { left: ruleLine(ctx, c.left) } : {}), ...(c.topBottom ? { top: ruleLine(ctx, c.topBottom), bottom: ruleLine(ctx, c.topBottom) } : {}) };
  return oneCell(ctx, new TableCell({ width: { size: ctx.width, type: WidthType.DXA }, margins: { top: 120, bottom: 120, left: 200, right: 200 }, borders, ...(fill ? { shading: { type: ShadingType.CLEAR, color: "auto", fill } } : {}), children: paragraphs }));
}

/** Space inside a callout box (twips) that tables and charts in the commentary give up. */
const BOX_INSET = 480;

function narrative(blocks: DocNarrativeBlock[], ctx: Ctx, boxed = true): (Paragraph | Table)[] {
  const inner: Ctx = boxed ? { ...ctx, width: ctx.width - BOX_INSET } : ctx;
  return blocks.flatMap((b): (Paragraph | Table)[] => {
    switch (b.kind) {
      case "p":
        return [new Paragraph({ children: runs(b.runs), spacing: { after: 80 } })];
      case "ul":
        return b.items.map((i) => new Paragraph({ bullet: { level: 0 }, children: runs(i) }));
      case "ol": {
        const instance = ctx.ol.next();
        return b.items.map((i) => new Paragraph({ numbering: { reference: olReference(b.start), level: 0, instance }, children: runs(i) }));
      }
      case "h":
        return [new Paragraph({ heading: HeadingLevel.HEADING_4, keepNext: true, children: runs(b.runs) })];
      case "table": {
        const cols = b.header.length;
        const rows = b.rows.map((r) => Array.from({ length: cols }, (_, i) => r[i] ?? []));
        // The header is plain text in Word (the header row is bold small caps already).
        return table({ kind: "table", header: b.header.map((h) => h.map((r) => r.t).join("")), rows, numeric: b.align.slice(0, cols).map((a) => a === "right") }, inner);
      }
      case "chart":
        return chart(b.chart, inner, false);
      case "chartRef": // buildReportDoc resolves or drops these
        return [];
    }
  });
}

const label = (s: string, o: { color: string; caps: boolean; italic: boolean; bold: boolean; size: number }) =>
  new Paragraph({ spacing: { after: 40 }, children: [new TextRun({ text: docxText(s), ...(o.bold ? { bold: true } : {}), ...(o.italic ? { italics: true } : {}), size: o.size, ...(o.caps ? { allCaps: true } : {}), color: o.color })] });

/** The small heading of a callout box ("Summary", "Commentary"). */
const calloutLabel = (ctx: Ctx, s: string) => {
  const c = ctx.t.callout;
  return label(s, { color: col(ctx, c.labelColor), caps: c.labelCaps, italic: c.labelItalic, bold: c.labelBold, size: c.labelSize });
};

const calloutFill = (ctx: Ctx, summary: boolean): string | null => {
  const c = ctx.t.callout;
  if (!c.fill) return null;
  return summary && c.summaryMix ? hex(mix(ctx.primary, "#ffffff", c.summaryMix)) : col(ctx, c.fill);
};

function commentary(blocks: DocNarrativeBlock[], ctx: Ctx): Table {
  return box(ctx, [calloutLabel(ctx, "Commentary"), ...narrative(blocks, ctx)], calloutFill(ctx, false));
}

const spacer = (after = 80) => new Paragraph({ children: [], spacing: { after } });

/** Key-figure cells (the KPI row, and tiles inside sections), at most `perRow` to a row. */
function kpiCells(items: Kpi[], ctx: Ctx, big: boolean, perRow: number): Table {
  const rows: Kpi[][] = [];
  for (let i = 0; i < items.length; i += perRow) rows.push(items.slice(i, i + perRow));
  const cols = Math.min(perRow, items.length);
  const w = Math.floor(ctx.width / cols);
  const kt = ctx.t.kpi;
  // Small tiles: cards uses the zebra grey and 30; the other themes have no fill and 3/4 of the big value size.
  const valueSize = big ? kt.valueSize : Math.round(kt.valueSize * 0.75);
  const cellBorders = (ci: number) => {
    if (kt.fill) return { top: line("FFFFFF", 12), bottom: line("FFFFFF", 12), left: line("FFFFFF", 12), right: line("FFFFFF", 12) };
    if (kt.box) return { top: ruleLine(ctx, kt.box), bottom: ruleLine(ctx, kt.box), left: ruleLine(ctx, kt.box), right: ruleLine(ctx, kt.box) };
    return { ...noBorders, ...(kt.top ? { top: ruleLine(ctx, kt.top) } : {}), ...(kt.separator && ci > 0 ? { left: ruleLine(ctx, kt.separator) } : {}) };
  };
  const cell = (k: Kpi | undefined, ci: number) =>
    new TableCell({
      width: { size: w, type: WidthType.DXA },
      margins: { top: 110, bottom: 110, left: 150, right: 110 },
      borders: cellBorders(ci),
      ...(kt.fill ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: k ? (big ? col(ctx, kt.fill) : H.zebra) : "FFFFFF" } } : {}),
      children: k
        ? [
            label(k.label, { color: col(ctx, kt.labelColor), caps: kt.labelCaps, italic: kt.labelItalic, bold: !kt.labelItalic, size: kt.labelCaps ? 15 : 17 }),
            new Paragraph({
              spacing: { after: 40 },
              children: [new TextRun({ text: docxText(k.value), ...(kt.valueBold ? { bold: true } : {}), ...(kt.valueHeading ? { font: ctx.headFont } : {}), size: valueSize, color: k.tone && k.tone !== "neutral" ? hex(TONE[k.tone].fg) : col(ctx, kt.valueColor) })],
            }),
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
    rows: rows.map((r) => new TableRow({ cantSplit: true, children: Array.from({ length: cols }, (_, i) => cell(r[i], i)) })),
  });
}

/** A native Word chart: the options come from chart-options.ts (shared with the PowerPoint export). */
function chart(c: Chart, ctx: Ctx, half: boolean): (Paragraph | Table)[] {
  const widthPx = Math.round((ctx.width / 1440) * 96 * (half ? 0.49 : 1));
  const opts = chartRunOptions(c, { primary: ctx.primary, font: ctx.font, widthPx, half });
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
    case "rich":
      return narrative(b.blocks, ctx, false);
  }
}

/** Consulting's two-digit section number ("01", "02", ...). */
const sectionNumber = (n: number) => String(n).padStart(2, "0");

function sectionHeading(title: string, ctx: Ctx, opts: { bookmark?: string; pageBreakBefore?: boolean; number?: number } = {}): Paragraph {
  const h = ctx.t.heading2;
  const parts: TextRun[] = [];
  if (h.numbered && opts.number !== undefined) parts.push(new TextRun({ text: sectionNumber(opts.number), bold: true, size: 20, color: hex(ctx.primaryInk) }));
  parts.push(new TextRun({ text: `${parts.length ? "  " : ""}${docxText(title)}`, color: col(ctx, h.color), ...(h.bold ? { bold: true } : {}), ...(h.italic ? { italics: true } : {}), size: h.size }));
  const side = (r: Rule) => ({ ...ruleLine(ctx, r), space: 4 });
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    keepNext: true,
    ...(opts.pageBreakBefore ? { pageBreakBefore: true } : {}),
    spacing: { before: 280, after: 120 },
    ...(h.top || h.bottom ? { border: { ...(h.top ? { top: side(h.top) } : {}), ...(h.bottom ? { bottom: side(h.bottom) } : {}) } } : {}),
    ...(h.shading ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: col(ctx, h.shading) } } : {}),
    children: opts.bookmark ? [new Bookmark({ id: opts.bookmark, children: parts })] : parts,
  });
}

/** Word bookmark names: a letter first, then letters, digits and underscores, at most 40 characters, unique. */
function bookmarkNames(anchors: string[]): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const a of anchors) {
    const base = a.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]/, "s$&").slice(0, 36);
    let name = base;
    for (let n = 2; used.has(name); n++) name = `${base}_${n}`;
    used.add(name);
    names.set(a, name);
  }
  return names;
}

function cover(doc: ReportDoc, ctx: Ctx): Table {
  const b = doc.branding;
  const cv0 = ctx.t.cover;
  // Text on the cover: the on-fill colours when the cover has a fill, ink and muted when it is plain.
  const on = cv0.fill ? col(ctx, "onFill") : col(ctx, "ink");
  const soft = cv0.fill ? col(ctx, "onFillSoft") : col(ctx, "muted");
  const m = doc.meta;
  const logo = b.logo;
  const size = logo ? imageSize(logo.data) : undefined;
  const brandRuns: ParagraphChild[] = [
    ...(logo && size ? [new ImageRun({ type: logo.mime === "image/png" ? "png" : "jpg", data: logo.data, transformation: fit(size, 140, 40), altText: { name: "logo", description: docxText(b.agencyName ?? "Logo"), title: "Logo" } })] : []),
    ...(b.agencyName ? [new TextRun({ text: `${logo && size ? "   " : ""}${docxText(b.agencyName)}`, bold: true, size: 20, color: on })] : []),
  ];
  const cv = coverEntries(m);
  const meta = cv.entries.map((e) => `${e.label}: ${e.value}`);
  const paragraphs = [
    ...(brandRuns.length ? [new Paragraph({ spacing: { after: 160 }, children: brandRuns })] : []),
    new Paragraph({
      children: [new TextRun({ text: docxText(m.templateTitle), allCaps: true, ...(cv0.kicker.bold ? { bold: true } : {}), size: cv0.kicker.size, color: col(ctx, cv0.kicker.color), ...(cv0.kicker.spacing ? { characterSpacing: cv0.kicker.spacing } : {}) })],
    }),
    new Paragraph({ heading: HeadingLevel.TITLE, spacing: { after: 20 }, children: [new TextRun({ text: docxText(m.clientName), ...(cv0.title.bold ? { bold: true } : {}), size: cv0.title.size, color: col(ctx, cv0.title.color) })] }),
    ...(m.cover.subtitle
      ? [new Paragraph({ spacing: { after: 20 }, children: [new TextRun({ text: docxText(m.cover.subtitle), ...(cv0.subtitle.italic ? { italics: true } : {}), size: cv0.subtitle.size, color: col(ctx, cv0.subtitle.color) })] })]
      : []),
    ...(cv.domain ? [new Paragraph({ spacing: { after: 160 }, children: [new TextRun({ text: docxText(m.domain), size: 22, color: soft })] })] : []),
    ...(meta.length
      ? [
          new Paragraph({
            ...(cv0.metaRule ? { spacing: { before: cv0.metaRule.before }, border: { top: { ...ruleLine(ctx, cv0.metaRule), space: 8 } } } : {}),
            children: meta.flatMap((x, i) => [...(i ? [new TextRun({ text: "     ", size: 18 })] : []), new TextRun({ text: docxText(x), size: 18, bold: true, color: on })]),
          }),
        ]
      : []),
    ...(cv.badge ? [new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: docxText(doc.badge), allCaps: true, size: 15, color: soft })] })] : []),
  ];
  return oneCell(
    ctx,
    new TableCell({
      width: { size: ctx.width, type: WidthType.DXA },
      margins: cv0.margins,
      borders: { ...noBorders, ...(cv0.border ? { [cv0.border.side]: ruleLine(ctx, cv0.border.rule) } : {}) },
      ...(cv0.fill ? { shading: { type: ShadingType.CLEAR, color: "auto", fill: col(ctx, cv0.fill === "dark" ? "dark" : "primary") } } : {}),
      children: paragraphs,
    }),
  );
}

export async function toDocx(doc: ReportDoc): Promise<Buffer> {
  const primary = safeColor(doc.branding.primaryColor, DEFAULT_PRIMARY);
  const page = PAGE[doc.branding.paper];
  const theme = docxTheme(doc.branding.theme);
  const bodyFont = doc.branding.fonts.body ?? theme.fonts.body;
  // The heading font falls back to the branding's body font when only that is set (as in 0.3.0), then to the theme's.
  const headFont = doc.branding.fonts.heading ?? doc.branding.fonts.body ?? theme.fonts.heading;
  const fontsOn = doc.branding.fonts.body !== null || doc.branding.fonts.heading !== null;
  let instance = 0;
  const pal = themePalette(primary, safeColor(doc.branding.accentColor, DEFAULT_ACCENT));
  const ctx: Ctx = { primary, primaryInk: inkOn(primary), width: page.width - 2 * MARGIN, font: bodyFont, headFont, t: theme, pal, ol: { next: () => ++instance } };
  const themed = doc.branding.theme !== "cards";
  const numbered = theme.heading2.numbered;
  const children: (Paragraph | Table)[] = [cover(doc, ctx), spacer(160)];

  // Narrative features in use decide which styles and numbering definitions the file carries, so other files stay as in 0.2.0.
  const narratives = [...(doc.summary?.narrative ? [doc.summary.narrative] : []), ...doc.sections.flatMap((x) => [...(x.commentary ? [x.commentary] : []), ...x.blocks.flatMap((bl) => (bl.kind === "rich" ? [bl.blocks] : []))])];
  const usesH = narratives.some((bs) => bs.some((n) => n.kind === "h"));
  const olStarts = [...new Set(narratives.flatMap((bs) => bs.flatMap((n) => (n.kind === "ol" ? [n.start] : []))))];

  const names = bookmarkNames(doc.contents?.map((c) => c.anchor) ?? []);
  if (doc.contents) {
    children.push(sectionHeading("Contents", ctx));
    const ct = theme.contents;
    doc.contents.forEach((c, i) => {
      children.push(
        new Paragraph({
          spacing: { after: 50 },
          indent: { left: 200 },
          children: [
            ...(ct.numbered ? [new TextRun({ text: `${sectionNumber(i + 1)}.  `, bold: true, color: hex(ctx.primaryInk) })] : []),
            new InternalHyperlink({ anchor: names.get(c.anchor)!, children: [new TextRun({ text: docxText(c.title), color: col(ctx, ct.color), ...(ct.underline ? { underline: {} } : {}) })] }),
          ],
        }),
      );
    });
    children.push(spacer(120));
  }

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
          calloutLabel(ctx, s.title),
          ...(s.narrative ? narrative(s.narrative, ctx) : []),
          ...(s.items ?? []).map((h) => new Paragraph({ bullet: { level: 0 }, spacing: { after: 30 }, children: runs(h, { size: 19 }) })),
          ...(s.caption ? [new Paragraph({ spacing: { before: 80 }, children: [new TextRun({ text: docxText(s.caption), size: 15, color: H.faint })] })] : []),
        ],
        calloutFill(ctx, true),
      ),
      spacer(120),
    );
  }
  for (const [si, s] of doc.sections.entries()) {
    children.push(sectionHeading(s.title, ctx, { ...(doc.contents ? { bookmark: names.get(s.anchor)! } : {}), ...(s.pageBreakBefore ? { pageBreakBefore: true } : {}), ...(numbered ? { number: si + 1 } : {}) }));
    for (const b of s.blocks) children.push(...block(b, ctx));
    if (s.commentary) children.push(commentary(s.commentary, ctx), spacer());
  }
  children.push(sectionHeading("About this report", ctx, { ...(doc.contents ? { bookmark: names.get("about-this-report")! } : {}), ...(numbered ? { number: doc.sections.length + 1 } : {}) }));
  children.push(...doc.about.map((a) => new Paragraph({ bullet: { level: 0 }, children: runs(a, { color: H.muted, size: 16 }) })));

  const small = { color: H.faint, size: 15 };
  const footerRuns: ParagraphChild[] = [new TextRun({ text: `${doc.footer.trim() ? `${docxText(doc.footer)}   ·   ` : ""}Page `, ...small }), new TextRun({ children: [PageNumber.CURRENT], ...small }), new TextRun({ text: " of ", ...small }), new TextRun({ children: [PageNumber.TOTAL_PAGES], ...small })];
  const document = new Document({
    title: docxText(doc.meta.title),
    creator: doc.branding.hideCrawlmark ? docxText(doc.branding.agencyName ?? "") : "crawlmark",
    description: doc.meta.dataOnly ? "Data-only report" : "Report with commentary",
    styles: {
      default: { document: { run: { font: bodyFont, size: 20, color: H.ink }, paragraph: { spacing: { line: 264 } } } },
      paragraphStyles: [
        ...(fontsOn || themed ? [{ id: "Title", name: "Title", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: headFont } }] : []),
        { id: "Heading2", name: "Heading 2", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: headFont, size: theme.heading2.size, ...(theme.heading2.bold ? { bold: true } : {}), ...(theme.heading2.italic ? { italics: true } : {}) }, paragraph: { keepNext: true } },
        { id: "Heading3", name: "Heading 3", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: headFont, size: 21, ...(theme.heading3.bold ? { bold: true } : {}), ...(theme.heading3.italic ? { italics: true } : {}) }, paragraph: { keepNext: true, spacing: { before: 160, after: 60 } } },
        ...(fontsOn || usesH ? [{ id: "Heading4", name: "Heading 4", basedOn: "Normal", next: "Normal", quickFormat: true, run: { font: headFont, size: 20, bold: true }, paragraph: { keepNext: true, spacing: { before: 120, after: 40 } } }] : []),
      ],
    },
    ...(olStarts.length
      ? {
          numbering: {
            config: olStarts.map((start) => ({
              reference: olReference(start),
              levels: [{ level: 0, format: LevelFormat.DECIMAL, text: "%1.", alignment: AlignmentType.START, start, style: { paragraph: { indent: { left: 540, hanging: 360 } } } }],
            })),
          },
        }
      : {}),
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
