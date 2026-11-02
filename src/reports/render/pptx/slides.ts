/**
 * One builder per DeckSlide kind. Each returns the slide XML, its relationships (layout first, then its chart and
 * the logo, in that order) and the notes text. Shapes appear in reading order with the title first; every slide's
 * title is a title placeholder (ctrTitle on the Title layout), so PowerPoint's outline and screen readers see it.
 * All text goes through xml.ts (`esc`); nothing here interpolates data into XML directly.
 */
import { inkOn, NEUTRAL, SERIES, TONE } from "../color.js";
import { DECK, type DeckSlide, type DeckTable } from "../deck.js";
import type { Chart, Kpi, TableBlock, Text } from "../doc.js";
import { shareColors } from "../svg.js";
import { imageSize } from "../image.js";
import type { ChartPart } from "./charts.js";
import { bodyStyle, CONTENT_W, coverFill, coverGeometry, footerStyle, FOOTER_BOX, headingStyle, NUMBER_BOX, PH, SLIDE, titleAnchor, titleBox, type Ctx } from "./master.js";
import { chartFrame, para, picture, REL, Rels, run, shape, slideNumField, spTree, tableFrame, tabRun, txBody, XML_DECL, PML_NS, type Box, type Cell, type ParaStyle, type RunStyle } from "./xml.js";

export interface BuiltSlide {
  xml: string;
  rels: Rels;
  notes?: string;
  /** The chart part this slide shows, stored as ppt/charts/chart<chartNo>.xml. */
  chart?: { no: number; part: ChartPart };
  logo: boolean;
}

export interface SlideEnv {
  /** 1-based slide number. */
  number: number;
  /** The chart part for a section slide's chart: undefined = no chart, null = the chart couldn't be drawn. */
  chart?: ChartPart | null;
  /** The number the chart part gets when this slide stores one. */
  chartNo: number;
  logo?: { mime: "image/png" | "image/jpeg"; data: Buffer };
}

export const LOGO_TARGET = (mime: "image/png" | "image/jpeg") => `../media/logo.${mime === "image/png" ? "png" : "jpeg"}`;
export const MORE_DETAIL = "More detail in the full report.";

/**
 * A rule on a slide (tile rules, panel rules, separators): a filled rectangle at least 1 pt thick with an empty text
 * body. Quick Look draws lines and text-less shapes as pictures and repeats those pictures on later slides, striking
 * through other content; shapes with a text body it draws in place. (Rules on the master are unaffected.)
 */
function bar(b: Builder, name: string, box: Box, color: string): string {
  const min = 1 / 72;
  return shape({ id: b.next(), name, box: { ...box, w: Math.max(box.w, min), h: Math.max(box.h, min) }, geom: "rect", fill: color, line: null, text: txBody([]) });
}

/** One slide's shapes, ids and relationships. */
class Builder {
  readonly shapes: string[] = [];
  readonly rels = new Rels();
  private id = 1;
  constructor(layout: 1 | 2) {
    this.rels.add(REL.slideLayout, `../slideLayouts/slideLayout${layout}.xml`);
  }
  next(): number {
    return ++this.id;
  }
  add(...s: string[]) {
    this.shapes.push(...s);
  }
  xml(): string {
    return `${XML_DECL}<p:sld ${PML_NS}><p:cSld>${spTree(this.shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sld>`;
  }
}

const plain = (t: Text) =>
  t
    .map((r) => r.t)
    .join(t.some((r) => r.tag) ? " " : "")
    .replace(/\s+/g, " ")
    .trim();
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** A chart's fallback table as a deck table (the deck's column, row and cell limits). */
export function fallbackTable(t: TableBlock, maxRows: number): DeckTable {
  const cols = Math.min(t.header.length, DECK.maxTableCols);
  return {
    header: t.header.slice(0, cols).map((h) => cut(h, DECK.maxCellChars)),
    rows: t.rows.slice(0, maxRows).map((r) => r.slice(0, cols).map((c) => cut(plain(c), DECK.maxCellChars))),
    numeric: (t.numeric ?? []).slice(0, cols),
    shown: Math.min(t.rows.length, maxRows),
    total: t.rows.length,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Text measurement (estimates for sizing boxes; the renderer still wraps and autofits)

/** Glyph widths (share of the font size) after Helvetica/Arial's metrics, by character class. */
function glyphEm(ch: string): number {
  if (ch === " ") return 0.28;
  if ("iljtfrI.,:;'!|()[]/".includes(ch)) return 0.3;
  if ("mwMW@%".includes(ch)) return 0.86;
  if (/[0-9]/.test(ch)) return 0.556;
  if (/[A-Z]/.test(ch)) return 0.68;
  return 0.54;
}

/** Each family's width against Arial's (bold adds about 6%). */
function familyScale(font: string, bold = false): number {
  const f = font.toLowerCase();
  const k = f.includes("black") ? 1.28 : f.includes("verdana") ? 1.13 : f.includes("georgia") ? 1.04 : f.includes("trebuchet") ? 0.95 : f.includes("calibri") ? 0.9 : 1;
  return k * (bold ? 1.06 : 1);
}

/** Exported for tests. The estimated width of one line of text, in inches. */
export function textWidth(text: string, st: RunStyle): number {
  let em = 0;
  for (const ch of st.caps ? text.toUpperCase() : text) em += glyphEm(ch);
  return (em * st.size * familyScale(st.font, st.bold) + text.length * (st.spacing ?? 0)) / 72;
}

/** Estimated wrapped line count: greedy word wrap with the average glyph width. */
function lineCount(text: string, st: RunStyle, width: number): number {
  const words = text.split(/\s+/).filter(Boolean);
  if (!words.length) return 1;
  const space = textWidth(" ", st);
  let lines = 1;
  let used = 0;
  for (const w of words) {
    const ww = textWidth(w, st);
    if (used > 0 && used + space + ww > width) {
      lines++;
      used = ww;
    } else used += (used > 0 ? space : 0) + ww;
    if (ww > width) lines += Math.floor(ww / width);
  }
  return lines;
}

const lineH = (st: RunStyle, spacing = 1) => (st.size * 1.2 * spacing) / 72;

// ---------------------------------------------------------------------------------------------------------------
// Shared pieces

/** Friendly's pill: padding left and right of the title text. */
const PILL_PAD = 0.28;

/** Exported for tests. The primary as small text on the body slides' background (4.5:1 there, not just on white). */
export const accentInk = (x: Ctx) => inkOn(x.p.primaryInk, x.col(x.t.background), 4.5);

function titleShape(x: Ctx, b: Builder, text: string, number?: number): string {
  const hs = headingStyle(x);
  const runs: string[] = [];
  if (x.t.heading.numbered && number !== undefined) runs.push(run(`${String(number).padStart(2, "0")}  `, { ...hs, bold: true, color: accentInk(x) }));
  runs.push(run(text, hs));
  if (x.t.heading.pill) {
    // Friendly: the title sits in a rounded tint pill sized to the text (an estimate from the font and size). The pill
    // is its own shape behind an unfilled, non-wrapping title placeholder, so every app draws the rounded ends and
    // a long title never wraps out of it.
    const box: Box = { x: SLIDE.margin, y: SLIDE.titleY + 0.12, w: CONTENT_W, h: 0.62 };
    const w = Math.min(CONTENT_W, textWidth(text, hs) + 2 * PILL_PAD);
    b.add(shape({ id: b.next(), name: "Title pill", box: { ...box, w }, geom: "roundRect", radius: 50000, fill: x.p.tint, line: null, text: txBody([]) }));
    return shape({ id: b.next(), name: "Title", box, fill: null, line: null, ph: { type: "title" }, text: txBody([para(runs, hs)], { anchor: "ctr", wrap: false, inset: [PILL_PAD, 0.04, PILL_PAD, 0.04] }) });
  }
  return shape({ id: b.next(), name: "Title", box: titleBox(x), ph: { type: "title" }, text: txBody([para(runs, hs)], { anchor: titleAnchor(x), autofit: true, inset: [0, 0.05, 0, titleAnchor(x) === "b" ? 0.1 : 0.05] }) });
}

function footer(x: Ctx, b: Builder, n: number) {
  const fs = footerStyle(x);
  if (x.footer) b.add(shape({ id: b.next(), name: "Footer", box: FOOTER_BOX, ph: { type: "ftr", sz: "quarter", idx: PH.footer }, text: txBody([para([run(x.footer, fs)], fs)], { anchor: "ctr" }) }));
  b.add(shape({ id: b.next(), name: "Slide Number", box: NUMBER_BOX, ph: { type: "sldNum", sz: "quarter", idx: PH.slideNum }, text: txBody([para([slideNumField(n, fs)], fs, { align: "r" })], { anchor: "ctr" }) }));
}

/** Exported for tests. The bullet's hanging indent for a font size: the dot sits just left of the text. */
export const bulletHang = (size: number) => Math.round((size * 0.75) / 72 * 100) / 100;
const BULLET_BEFORE = 8;
const BULLET_SPACING = 1.05;

const bulletPara = (x: Ctx, text: string, st: RunStyle, before = BULLET_BEFORE): string => para([run(text, st)], st, { bullet: "•", bulletColor: x.p.primary, before, lineSpacing: BULLET_SPACING * 100, hang: bulletHang(st.size) } satisfies ParaStyle);

/** The estimated height of a bullet list in a box `width` wide (text insets included). */
function bulletsHeight(x: Ctx, items: string[], width: number, size: number, lIns = 0): number {
  const st = bodyStyle(x, size);
  const textW = width - lIns - bulletHang(size) - 0.1;
  const body = items.reduce((h, t, i) => h + lineCount(t, st, textW) * lineH(st, BULLET_SPACING) + (i ? BULLET_BEFORE / 72 : 0), 0);
  return body + 0.1 + 0.15;
}

/**
 * A bullet list. `lIns` is the text box's left inset: in a panel it's the hanging indent, so the dot stays clear of
 * the panel's left rule even in Apple's Quick Look, which draws the dot a whole hang further left than PowerPoint
 * and Keynote do.
 */
function bullets(x: Ctx, b: Builder, items: string[], box: Box, size = 18, lIns = 0): void {
  const st = bodyStyle(x, size);
  b.add(shape({ id: b.next(), name: "Bullets", box, text: txBody(items.map((t) => bulletPara(x, t, st)), { autofit: true, inset: [lIns, 0.05, 0.1, 0.05] }) }));
}

function footnotes(x: Ctx, b: Builder, notes: string[], bottom: number): number {
  if (!notes.length) return bottom;
  const st: RunStyle = { size: 11, color: NEUTRAL.faint, font: x.fonts.body };
  const h = Math.min(0.8, 0.24 * notes.length + 0.08);
  b.add(shape({ id: b.next(), name: "Footnotes", box: { x: SLIDE.margin, y: bottom - h, w: CONTENT_W, h }, text: txBody(notes.map((n) => para([run(n, st)], st)), { anchor: "b", autofit: true, inset: [0, 0, 0, 0] }) }));
  return bottom - h - 0.1;
}

/** Panel padding: left (past the rule), top and bottom, right. */
function panelPad(x: Ctx): { l: number; v: number; r: number } {
  const c = x.t.callout;
  if (!c.fill && !c.left) return { l: 0.05, v: 0.05, r: 0.05 };
  return { l: (c.left ? c.left.weight / 72 : 0) + 0.25, v: 0.2, r: 0.25 };
}

/** The panel box that fits a bullet list `width` wide (at the top of `area`, never taller than it). */
function bulletPanelHeight(x: Ctx, items: string[], width: number, size: number, max: number): number {
  const p = panelPad(x);
  const h = bulletsHeight(x, items, width - p.l - p.r, size, bulletHang(size)) + 2 * p.v;
  return Math.min(max, Math.max(1.1, h));
}

/** A bullet panel: the callout fill and left rule from the theme, then the bullets inside its padding. */
function bulletPanel(x: Ctx, b: Builder, box: Box, items: string[], size: number): void {
  const c = x.t.callout;
  const rounded = x.id === "friendly";
  // Rounded shapes carry an (empty) text body: Quick Look draws a rounded shape without one as a picture and
  // repeats such pictures on later slides.
  if (c.fill) b.add(shape({ id: b.next(), name: "Panel", box, geom: rounded ? "roundRect" : "rect", radius: rounded ? 6000 : undefined, fill: x.col(c.fill), line: null, ...(rounded ? { text: txBody([]) } : {}) }));
  if (c.left) b.add(bar(b, "Panel rule", { x: box.x, y: box.y, w: c.left.weight / 72, h: box.h }, x.col(c.left.color)));
  const p = panelPad(x);
  bullets(x, b, items, { x: box.x + p.l, y: box.y + p.v, w: box.w - p.l - p.r, h: box.h - 2 * p.v }, size, bulletHang(size));
}

const ARROW = { up: "▲", down: "▼", flat: "–" } as const;

/** Tile sizes: "hero" on the Key numbers slide, "row" for a section's tile row, "side" beside a chart or table. */
type TileSize = "hero" | "row" | "side";

interface TileStyles {
  label: RunStyle;
  value: (kpi: Kpi) => RunStyle;
  delta: RunStyle;
  detail: RunStyle;
  /** Padding inside a tile (shaped tiles) or under a top rule. */
  pad: number;
}

const TILE_TYPE: Record<TileSize, { label: number; delta: number; detail: number; valueScale: number; valueMax: number }> = {
  hero: { label: 15, delta: 16, detail: 13, valueScale: 1.6, valueMax: 66 },
  row: { label: 12, delta: 12, detail: 11, valueScale: 1, valueMax: 44 },
  side: { label: 11, delta: 11, detail: 11, valueScale: 0.8, valueMax: 28 },
};

/** The tile type for a list of KPIs in tiles `w` wide: the value shrinks until the widest value fits. */
function tileStyles(x: Ctx, size: TileSize, kpis: Kpi[], w: number): TileStyles {
  const k = x.t.kpi;
  const t = TILE_TYPE[size];
  const pad = k.shape ? (size === "side" ? 0.16 : 0.22) : 0.02;
  const base: RunStyle = { size: Math.min(t.valueMax, Math.round(k.valueSize * t.valueScale)), bold: k.valueBold, color: NEUTRAL.ink, font: x.fonts.heading };
  const room = w - 2 * pad - 0.15;
  const widest = Math.max(0.01, ...kpis.map((kpi) => textWidth(kpi.value, base)));
  const valueSize = Math.max(16, Math.min(base.size, Math.floor((base.size * room) / widest)));
  return {
    label: { size: t.label, bold: x.id === "bold", caps: k.labelCaps, italic: k.labelItalic, color: x.id === "bold" ? x.p.dark : NEUTRAL.muted, font: x.fonts.body, spacing: k.labelCaps ? 0.5 : undefined },
    value: (kpi) => ({ ...base, size: valueSize, color: kpi.tone && kpi.tone !== "neutral" ? TONE[kpi.tone].fg : x.col(k.valueColor) }),
    delta: { size: t.delta, bold: true, color: NEUTRAL.ink, font: x.fonts.body },
    detail: { size: t.detail, color: NEUTRAL.faint, font: x.fonts.body },
    pad,
  };
}

const CHIP_PAD = 0.09;
const chipH = (st: RunStyle) => lineH(st) + 0.06;
const TILE_GAP = 0.05;

/** Where each line of a tile sits (offsets from the tile's top) and the tile's height. */
function tileRows(x: Ctx, st: TileStyles, kpi: Kpi, w: number): { label: number; labelH: number; value: number; valueH: number; delta: number; detail: number; detailH: number; h: number } {
  const k = x.t.kpi;
  const inner = w - 2 * st.pad - 0.1;
  let y = st.pad + (k.topRule ? k.topRule.weight / 72 + 0.1 : 0);
  const label = y;
  const labelH = lineCount(kpi.label, st.label, inner) * lineH(st.label);
  y += labelH + TILE_GAP;
  const value = y;
  const valueH = lineH(st.value(kpi), 1.05);
  y += valueH + TILE_GAP;
  const delta = y;
  if (kpi.delta) y += (k.chip ? chipH(st.delta) : lineH(st.delta)) + TILE_GAP;
  const detail = y;
  const detailH = kpi.detail ? lineCount(kpi.detail, st.detail, inner) * lineH(st.detail) : 0;
  y += detailH;
  return { label, labelH, value, valueH, delta, detail, detailH, h: y + st.pad + (k.shape ? 0 : 0.05) };
}

/** The height of the tallest tile (a row of tiles shares it). */
function tileHeight(x: Ctx, kpis: Kpi[], w: number, size: TileSize): number {
  const st = tileStyles(x, size, kpis, w);
  return Math.max(0, ...kpis.map((kpi) => tileRows(x, st, kpi, w).h));
}

/** A text line in a tile: no insets, so the tile's own padding places it. */
const tileText = (b: Builder, name: string, box: Box, runs: string[], st: RunStyle, anchor: "t" | "ctr" = "t") =>
  shape({ id: b.next(), name, box, text: txBody([para(runs, st)], { anchor, inset: [0, 0, 0, 0] }) });

/**
 * KPI tiles in a grid: the theme's shape, top rule or separators; label, value, change (a tinted chip in cards,
 * bold and friendly, as in their report themes) and detail. Returns the grid height.
 */
function tiles(x: Ctx, b: Builder, kpis: Kpi[], area: Box, cols: number, size: TileSize = "row"): number {
  const k = x.t.kpi;
  const gap = k.separators ? 0.3 : 0.2;
  const rows = Math.ceil(kpis.length / cols);
  const w = (area.w - gap * (cols - 1)) / cols;
  const st = tileStyles(x, size, kpis, w);
  const h = Math.min(tileHeight(x, kpis, w, size), (area.h - gap * (rows - 1)) / rows);
  kpis.forEach((kpi, i) => {
    const box: Box = { x: area.x + (i % cols) * (w + gap), y: area.y + Math.floor(i / cols) * (h + gap), w, h };
    // Rounded shapes carry an empty text body (see bulletPanel).
    if (k.shape) b.add(shape({ id: b.next(), name: `Tile ${i + 1}`, box, geom: k.shape === "rounded" ? "roundRect" : "rect", radius: k.shape === "rounded" ? 8000 : undefined, fill: k.fill ? x.col(k.fill) : null, line: k.border ? { color: x.col(k.border), weight: 0.75 } : null, text: txBody([]) }));
    if (k.topRule) b.add(bar(b, `Tile ${i + 1} rule`, { x: box.x, y: box.y, w: box.w, h: k.topRule.weight / 72 }, x.col(k.topRule.color)));
    if (k.separators && i % cols > 0) b.add(bar(b, `Tile ${i + 1} separator`, { x: box.x - gap / 2, y: box.y + 0.1, w: 1 / 72, h: box.h - 0.2 }, "#E6E8EB"));
    const r = tileRows(x, st, kpi, w);
    const left = box.x + st.pad;
    const inner = w - 2 * st.pad;
    const value = st.value(kpi);
    b.add(tileText(b, `Tile ${i + 1} label`, { x: left, y: box.y + r.label, w: inner, h: r.labelH }, [run(kpi.label, st.label)], st.label));
    b.add(tileText(b, `Tile ${i + 1} value`, { x: left, y: box.y + r.value, w: inner, h: r.valueH }, [run(kpi.value, value)], value));
    if (kpi.delta) {
      const tone = TONE[kpi.delta.tone];
      const d: RunStyle = { ...st.delta, color: tone.fg };
      const label = `${ARROW[kpi.delta.dir]} ${kpi.delta.text}`;
      if (k.chip) {
        const cw = Math.min(inner, textWidth(label, d) + 2 * CHIP_PAD + 0.04);
        b.add(shape({ id: b.next(), name: `Tile ${i + 1} change`, box: { x: left, y: box.y + r.delta, w: cw, h: chipH(d) }, geom: "roundRect", radius: 50000, fill: tone.bg, line: null, text: txBody([para([run(label, d)], d, { align: "ctr" })], { anchor: "ctr", wrap: false, inset: [CHIP_PAD, 0, CHIP_PAD, 0] }) }));
      } else b.add(tileText(b, `Tile ${i + 1} change`, { x: left, y: box.y + r.delta, w: inner, h: lineH(d) }, [run(label, d)], d));
    }
    if (kpi.detail) b.add(tileText(b, `Tile ${i + 1} detail`, { x: left, y: box.y + r.detail, w: inner, h: r.detailH }, [run(kpi.detail, st.detail)], st.detail));
  });
  return rows * h + (rows - 1) * gap;
}

/** Table cell margins (left + right) as written by xml.ts, plus a little slack. */
const CELL_PAD = 0.16 + 0.06;
/** Extra space before a left-aligned column that follows a right-aligned (number) column, so the two don't touch. */
const GUTTER = 0.25;
const gutterBefore = (numeric: boolean[], i: number) => i > 0 && !numeric[i] && numeric[i - 1] === true;

/**
 * Exported for tests. Column widths from the content: each column wants its longest cell (and its header, which may
 * wrap past 1.8 in); spare width is shared in proportion, and when the table is too wide the widest columns give
 * way first (none below `min`, or its own need when that is smaller).
 */
export function columnWidths(header: string[], rows: string[][], total: number, head: RunStyle, body: RunStyle, min = 0.85, numeric: boolean[] = []): number[] {
  const need = header.map((h, i) => Math.max(Math.min(textWidth(h, head), 1.8), ...rows.map((r) => textWidth(r[i] ?? "", body))) + CELL_PAD + (gutterBefore(numeric, i) ? GUTTER : 0));
  const sum = need.reduce((a, v) => a + v, 0);
  if (sum <= total) return need.map((v) => v + ((total - sum) * v) / sum);
  const floor = need.map((v) => Math.min(v, min));
  const floorSum = floor.reduce((a, v) => a + v, 0);
  if (floorSum >= total) return floor.map((f) => (total * f) / floorSum);
  // The cap c where the columns, each at min(need, c) and at least its floor, add up to the total.
  let lo = 0;
  let hi = Math.max(...need);
  for (let i = 0; i < 40; i++) {
    const c = (lo + hi) / 2;
    const w = need.reduce((a, v, j) => a + Math.max(floor[j]!, Math.min(v, c)), 0);
    if (w > total) hi = c;
    else lo = c;
  }
  const widths = need.map((v, j) => Math.max(floor[j]!, Math.min(v, lo)));
  const k = total / widths.reduce((a, v) => a + v, 0);
  return widths.map((v) => v * k);
}

interface TableLayout {
  widths: number[];
  rowH: number[];
  size: number;
  height: number;
}

/** Row height and type size scale with the room (up to 0.5 in rows at 14 pt); widths follow the content. */
function tableLayout(x: Ctx, t: DeckTable, area: Box): TableLayout {
  const tt = x.t.table;
  const n = t.rows.length + 1;
  // Short tables get taller rows and larger type (up to 16 pt, the body size) rather than leaving the slide empty.
  const base = Math.max(0.3, Math.min(0.58, area.h / n));
  const size = base >= 0.54 ? 16 : base >= 0.46 ? 14 : base >= 0.4 ? 13 : 12;
  const head: RunStyle = { size: Math.max(11, size - 2), bold: tt.headerBold, caps: tt.headerCaps, italic: tt.headerItalic, color: x.col(tt.headerColor), font: x.fonts.body, spacing: tt.headerCaps ? 0.4 : undefined };
  const body = bodyStyle(x, size);
  const widths = columnWidths(t.header, t.rows, area.w, head, body, 0.85, t.numeric);
  const rowLines = (cells: string[], st: RunStyle) => Math.max(1, ...cells.map((c, i) => lineCount(c, st, widths[i]! - CELL_PAD + 0.04)));
  const rowH = [t.header, ...t.rows].map((r, i) => Math.max(base, rowLines(r, i ? body : head) * lineH(i ? body : head) + 0.12));
  return { widths, rowH, size, height: rowH.reduce((a, v) => a + v, 0) };
}

/** A table: header from the theme (colour, bold, caps, italic, rule), zebra rows or thin row rules. Returns its height. */
function table(x: Ctx, b: Builder, t: DeckTable, area: Box, layout = tableLayout(x, t, area)): number {
  const tt = x.t.table;
  const cols = Math.max(1, t.header.length);
  const { widths, rowH, size } = layout;
  const head: RunStyle = { size: Math.max(11, size - 2), bold: tt.headerBold, caps: tt.headerCaps, italic: tt.headerItalic, color: x.col(tt.headerColor), font: x.fonts.body, spacing: tt.headerCaps ? 0.4 : undefined };
  const body = bodyStyle(x, size);
  const rowRule = tt.zebra ? null : { color: NEUTRAL.rule, weight: 0.5 };
  const align = (i: number): "l" | "r" => (t.numeric[i] ? "r" : "l");
  const padL = (i: number) => (gutterBefore(t.numeric, i) ? { padL: GUTTER } : {});
  const cells: Cell[][] = [
    t.header.map((h, i) => ({ text: h, style: head, align: align(i), fill: null, anchor: "b" as const, bottom: { color: x.col(tt.headerRule.color), weight: tt.headerRule.weight }, ...padL(i) })),
    ...t.rows.map((r, ri) => Array.from({ length: cols }, (_, i) => ({ text: r[i] ?? "", style: body, align: align(i), fill: tt.zebra && ri % 2 === 1 ? x.col(tt.zebra) : null, bottom: rowRule, ...padL(i) }))),
  ];
  b.add(tableFrame(b.next(), "Table", area, widths, rowH, cells));
  return layout.height;
}

function logo(b: Builder, env: SlideEnv, box: Box, descr: string): boolean {
  if (!env.logo) return false;
  const px = imageSize(env.logo.data);
  if (!px) return false;
  // Scaled to the box (up or down), keeping the aspect ratio: a small logo still reads on a 13-inch slide.
  const k = Math.min(box.w / px.width, box.h / px.height);
  const w = Math.round(px.width * k * 1000) / 1000;
  const h = Math.round(px.height * k * 1000) / 1000;
  const rId = b.rels.add(REL.image, LOGO_TARGET(env.logo.mime));
  b.add(picture(b.next(), "Logo", descr, rId, { x: box.x + box.w - w, y: box.y, w, h }));
  return true;
}

// ---------------------------------------------------------------------------------------------------------------
// Slide kinds

type Of<K extends DeckSlide["kind"]> = Extract<DeckSlide, { kind: K }>;

function coverText(x: Ctx) {
  const onFill = coverFill(x) !== null;
  return {
    title: { size: x.t.title.titleSize, bold: x.t.title.titleBold, color: x.col(x.t.title.titleColor), font: x.fonts.heading } satisfies RunStyle,
    kicker: { size: 14, bold: true, caps: true, color: x.col(x.t.title.kickerColor), font: x.fonts.body, spacing: 1.5 } satisfies RunStyle,
    sub: { size: 20, italic: x.id === "editorial", color: onFill ? x.col("onFillSoft") : NEUTRAL.muted, font: x.fonts.body } satisfies RunStyle,
    label: { size: 10, caps: true, color: onFill ? x.col("onFillSoft") : NEUTRAL.muted, font: x.fonts.body, spacing: 0.8 } satisfies RunStyle,
    value: { size: 15, bold: true, color: onFill ? x.col("onFill") : NEUTRAL.ink, font: x.fonts.body } satisfies RunStyle,
  };
}

function titleSlide(x: Ctx, s: Of<"title">, env: SlideEnv): BuiltSlide {
  const b = new Builder(1);
  const g = coverGeometry(x);
  const c = coverText(x);
  b.add(shape({ id: b.next(), name: "Title", box: { x: g.left, y: g.titleY, w: g.width, h: g.titleH }, ph: { type: "ctrTitle" }, text: txBody([para([run(s.title, c.title)], c.title)], { anchor: "b", autofit: true, inset: [0, 0.05, 0, 0.05] }) }));
  if (s.kicker) b.add(shape({ id: b.next(), name: "Kicker", box: { x: g.left, y: g.kickerY, w: g.width, h: 0.4 }, ph: { type: "subTitle", idx: PH.body }, text: txBody([para([run(s.kicker, c.kicker)], c.kicker)], { anchor: "b", inset: [0, 0, 0, 0] }) }));
  if (s.subtitle) b.add(shape({ id: b.next(), name: "Subtitle", box: { x: g.left, y: g.subtitleY, w: g.width, h: 0.5 }, text: txBody([para([run(s.subtitle, c.sub)], c.sub)], { autofit: true, inset: [0, 0.03, 0, 0] }) }));
  const line = [s.domain, s.badge].filter((v): v is string => !!v).join("  ·  ");
  if (line) {
    const st: RunStyle = { ...c.sub, size: 13, italic: false };
    b.add(shape({ id: b.next(), name: "Domain", box: { x: g.left, y: g.lineY, w: g.width, h: 0.4 }, text: txBody([para([run(line, st)], st)], { inset: [0, 0.03, 0, 0] }) }));
  }
  const entries = s.entries.slice(0, 8);
  if (entries.length) {
    const per = Math.min(4, entries.length);
    const w = g.width / per;
    entries.forEach((e, i) => {
      const box: Box = { x: g.left + (i % per) * w, y: g.entriesY + Math.floor(i / per) * 0.75, w: w - 0.15, h: 0.72 };
      b.add(shape({ id: b.next(), name: `Cover field ${i + 1}`, box, text: txBody([para([run(e.label, c.label)], c.label), para([run(e.value, c.value)], c.value, { before: 2 })], { autofit: true, inset: [0, 0, 0, 0] }) }));
    });
  }
  if (s.agencyName) {
    const st: RunStyle = { ...c.value, size: 14 };
    b.add(shape({ id: b.next(), name: "Agency", box: { x: g.left, y: g.agencyY, w: g.width - 2.2, h: 0.4 }, text: txBody([para([run(s.agencyName, st)], st)], { inset: [0, 0, 0, 0] }) }));
  }
  const hasLogo = s.logo && logo(b, env, g.logo, s.agencyName || "Logo");
  return { xml: b.xml(), rels: b.rels, logo: hasLogo };
}

function closingSlide(x: Ctx, s: Of<"closing">, env: SlideEnv): BuiltSlide {
  const b = new Builder(1);
  const g = coverGeometry(x);
  const c = coverText(x);
  b.add(shape({ id: b.next(), name: "Title", box: { x: g.left, y: g.titleY, w: g.width, h: g.titleH }, ph: { type: "ctrTitle" }, text: txBody([para([run(s.title, c.title)], c.title)], { anchor: "b", autofit: true, inset: [0, 0.05, 0, 0.05] }) }));
  if (s.agencyName) b.add(shape({ id: b.next(), name: "Agency", box: { x: g.left, y: g.kickerY, w: g.width, h: 0.4 }, ph: { type: "subTitle", idx: PH.body }, text: txBody([para([run(s.agencyName, c.kicker)], c.kicker)], { anchor: "b", inset: [0, 0, 0, 0] }) }));
  if (s.lines.length) {
    const st: RunStyle = { ...c.sub, size: 14, italic: false };
    b.add(shape({ id: b.next(), name: "Lines", box: { x: g.left, y: g.subtitleY, w: g.width, h: 1.4 }, text: txBody(s.lines.map((l) => para([run(l, st)], st, { before: 4 })), { autofit: true, inset: [0, 0.03, 0, 0] }) }));
  }
  const hasLogo = s.logo && logo(b, env, g.logo, s.agencyName || "Logo");
  return { xml: b.xml(), rels: b.rels, logo: hasLogo, notes: s.notes };
}

function bodySlide(x: Ctx, title: string, number?: number): Builder {
  const b = new Builder(2);
  b.add(titleShape(x, b, title, number));
  return b;
}

const CONTENT: Box = { x: SLIDE.margin, y: SLIDE.contentY, w: CONTENT_W, h: SLIDE.contentBottom - SLIDE.contentY };

/** Exported for tests. The agenda's number column: "00" in the number style plus a gap; the item text starts at this tab stop. */
export const agendaTab = (num: RunStyle) => Math.round((textWidth("00", num) + 0.3) * 100) / 100;

function agendaSlide(x: Ctx, s: Of<"agenda">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const twoCols = s.items.length > 7;
  const per = twoCols ? Math.ceil(s.items.length / 2) : s.items.length;
  const size = twoCols ? 18 : 22;
  const num: RunStyle = { size, bold: true, color: accentInk(x), font: x.fonts.body };
  const st = bodyStyle(x, size);
  // A tab stop and a hanging indent at the same place: one- and two-digit numbers, wrapped lines and every item's
  // text all start at one x.
  const tab = agendaTab(num);
  for (let col = 0; col < (twoCols ? 2 : 1); col++) {
    const items = s.items.slice(col * per, (col + 1) * per);
    const paras = items.map((t, i) => para([run(String(col * per + i + 1).padStart(2, "0"), num), tabRun(num), run(t, st)], st, { before: 14, hang: tab, tabs: [tab] }));
    const w = twoCols ? CONTENT.w / 2 - 0.2 : CONTENT.w;
    b.add(shape({ id: b.next(), name: `Agenda ${col + 1}`, box: { x: CONTENT.x + col * (CONTENT.w / 2 + 0.2), y: CONTENT.y + 0.1, w, h: CONTENT.h - 0.1 }, text: txBody(paras, { autofit: true }) }));
  }
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

/** Where a block `h` tall sits in `area`: a little above the middle (the optical centre). */
const centred = (area: Box, h: number) => area.y + Math.max(0, (area.h - h) * 0.42);

function kpiSlide(x: Ctx, s: Of<"kpis">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const kpis = s.kpis.slice(0, 8);
  const cols = Math.min(4, Math.max(1, kpis.length));
  const bottom = s.caption ? footnotes(x, b, [s.caption], SLIDE.contentBottom) : SLIDE.contentBottom;
  const area: Box = { x: CONTENT.x, y: CONTENT.y + 0.1, w: CONTENT.w, h: bottom - CONTENT.y - 0.1 };
  const rows = Math.ceil(kpis.length / cols);
  const gap = x.t.kpi.separators ? 0.3 : 0.2;
  const w = (area.w - gap * (cols - 1)) / cols;
  const h = Math.min(rows * tileHeight(x, kpis, w, "hero") + (rows - 1) * gap, area.h);
  tiles(x, b, kpis, { ...area, y: centred(area, h), h }, cols, "hero");
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

const SUMMARY_SIZE = 24;

function summarySlide(x: Ctx, s: Of<"summary">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const bottom = footnotes(x, b, s.caption ? [s.caption] : [], SLIDE.contentBottom);
  const area: Box = { x: CONTENT.x, y: CONTENT.y + 0.1, w: CONTENT.w, h: bottom - CONTENT.y - 0.1 };
  // The panel fits its bullets and sits at the optical centre, so three bullets don't leave a mostly empty box.
  const h = bulletPanelHeight(x, s.bullets, area.w, SUMMARY_SIZE, area.h);
  bulletPanel(x, b, { ...area, y: centred(area, h), h }, s.bullets, SUMMARY_SIZE);
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
}

function textSlide(x: Ctx, s: Of<"text">, env: SlideEnv): BuiltSlide {
  // Text slides carry no section number in the contract; use one if the deck model adds it.
  const number = (s as { number?: number }).number;
  const b = bodySlide(x, s.title, number);
  bullets(x, b, s.bullets, { ...CONTENT, y: CONTENT.y + 0.1, h: CONTENT.h - 0.1 }, 20);
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
}

/** The chart's caption row above the frame: the title on the left, the legend on the right (the chart part has neither on a slide). */
const CAPTION_H = 0.4;

/** Legend entries in the chart's own colours (chart-options.ts): a solid bar, a dashed one for the previous period, a square for shares. */
function legendEntries(c: Chart, primary: string): { mark: string; color: string; name: string }[] {
  if (c.type === "line") {
    if (c.series.length < 2) return [];
    return c.series.map((s) => ({
      mark: s.role === "previous" ? "– –" : "—",
      color: s.role === "current" ? inkOn(primary, "#ffffff", 3) : s.role === "previous" ? NEUTRAL.previous : SERIES[(s.index ?? 0) % SERIES.length]!,
      name: s.name,
    }));
  }
  const colors = shareColors(primary, c.parts.length);
  return c.parts.map((p, i) => ({ mark: "■", color: colors[i % colors.length]!, name: p }));
}

function chartCaption(x: Ctx, b: Builder, c: Chart, box: Box): void {
  const cs: RunStyle = { size: 12, bold: true, color: NEUTRAL.muted, font: x.fonts.body };
  const ls: RunStyle = { size: 12, color: NEUTRAL.muted, font: x.fonts.body };
  const entries = legendEntries(c, x.p.primary);
  const runs = entries.flatMap((e, i) => [run(`${i ? "     " : ""}${e.mark} `, { ...ls, bold: true, color: e.color }), run(e.name, ls)]);
  const legendW = entries.length ? Math.min(box.w * 0.6, textWidth(entries.map((e) => `${e.mark} ${e.name}`).join("     "), ls) + 0.3) : 0;
  b.add(shape({ id: b.next(), name: "Chart caption", box: { ...box, w: box.w - legendW, h: CAPTION_H }, text: txBody([para([run(c.title, cs)], cs)], { anchor: "t", inset: [0, 0.02, 0, 0] }) }));
  if (entries.length) b.add(shape({ id: b.next(), name: "Chart legend", box: { x: box.x + box.w - legendW, y: box.y, w: legendW, h: CAPTION_H }, text: txBody([para(runs, ls, { align: "r" })], { anchor: "t", inset: [0, 0.02, 0, 0] }) }));
}

/** The P-C4 section layouts: chart with a side panel, chart over a table, table with a side panel, tiles, bullets. */
function sectionSlide(x: Ctx, s: Of<"section">, env: SlideEnv): BuiltSlide & { chartFailed: boolean } {
  const b = bodySlide(x, s.title, s.number);
  const notes = [...s.footnotes];
  let chart: BuiltSlide["chart"];
  let chartFailed = false;
  let fallback: DeckTable | undefined;
  if (s.chart && env.chart === null) {
    chartFailed = true;
    if (s.chart.fallback) fallback = fallbackTable(s.chart.fallback, s.table ? DECK.maxTableRowsUnderChart : DECK.maxTableRows);
    if (!notes.includes(MORE_DETAIL)) notes.push(MORE_DETAIL);
  }
  const bottom = footnotes(x, b, notes, SLIDE.contentBottom);
  const area: Box = { x: CONTENT.x, y: CONTENT.y + 0.1, w: CONTENT.w, h: bottom - CONTENT.y - 0.1 };
  const tilesList = (s.tiles ?? []).slice(0, 8);
  const side = s.bullets.length > 0 || tilesList.length > 0;
  const main: Box = side ? { ...area, w: SLIDE.mainW } : area;
  const sideBox: Box = { x: SLIDE.sideX, y: area.y, w: SLIDE.sideW, h: area.h };
  const SIDE_SIZE = 16;

  /** The side column's height: a panel fitted to its bullets, or the tile grid. */
  const sideHeight = () => {
    if (s.bullets.length) return bulletPanelHeight(x, s.bullets, sideBox.w, SIDE_SIZE, sideBox.h);
    const t = tilesList.slice(0, 4);
    const rows = Math.ceil(t.length / 2);
    const gap = x.t.kpi.separators ? 0.3 : 0.2;
    return rows ? rows * tileHeight(x, t, (sideBox.w - gap) / 2, "side") + (rows - 1) * gap : 0;
  };
  const drawChart = (box: Box) => {
    if (s.chart && env.chart) {
      chartCaption(x, b, s.chart, box);
      const rId = b.rels.add(REL.chart, `../charts/chart${env.chartNo}.xml`);
      b.add(chartFrame(b.next(), "Chart", s.chart.summary || s.chart.title, rId, { ...box, y: box.y + CAPTION_H, h: box.h - CAPTION_H }));
      chart = { no: env.chartNo, part: env.chart };
    } else if (fallback) table(x, b, fallback, box);
  };
  const drawSide = (y = sideBox.y) => {
    const h = sideHeight();
    if (s.bullets.length) bulletPanel(x, b, { ...sideBox, y, h }, s.bullets, SIDE_SIZE);
    else if (tilesList.length) tiles(x, b, tilesList.slice(0, 4), { ...sideBox, y, h }, 2, "side");
  };

  if (s.chart) {
    if (side) {
      drawChart(main);
      drawSide();
    } else if (s.table) {
      const ch = Math.min(3.0, area.h * 0.55);
      drawChart({ ...area, h: ch });
      table(x, b, s.table, { ...area, y: area.y + ch + 0.15, h: area.h - ch - 0.15 });
    } else drawChart(area);
  } else if (s.table) {
    // The table (and its side column) as one block at the optical centre: short tables don't sit in the top third.
    const layout = tableLayout(x, s.table, main);
    const h = Math.min(area.h, Math.max(layout.height, side ? sideHeight() : 0));
    const y = centred(area, h);
    table(x, b, s.table, { ...main, y }, layout);
    if (side) drawSide(y);
  } else if (tilesList.length) {
    const cols = Math.min(4, tilesList.length);
    const gap = x.t.kpi.separators ? 0.3 : 0.2;
    const rows = Math.ceil(tilesList.length / cols);
    const size: TileSize = rows > 1 ? "side" : "row";
    const th = Math.min(rows * tileHeight(x, tilesList, (area.w - gap * (cols - 1)) / cols, size) + (rows - 1) * gap, s.bullets.length ? area.h * 0.55 : area.h);
    const bh = s.bullets.length ? Math.min(area.h - th - 0.3, bulletsHeight(x, s.bullets, area.w, SIDE_SIZE)) : 0;
    const y = centred(area, th + (bh ? bh + 0.3 : 0));
    tiles(x, b, tilesList, { ...area, y, h: th }, cols, size);
    if (s.bullets.length) bullets(x, b, s.bullets, { ...area, y: y + th + 0.3, h: area.h - (y - area.y) - th - 0.3 }, SIDE_SIZE);
  } else if (s.bullets.length) bullets(x, b, s.bullets, area, 20);

  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes, chart, chartFailed };
}

export function buildSlide(x: Ctx, s: DeckSlide, env: SlideEnv): BuiltSlide & { chartFailed?: boolean } {
  switch (s.kind) {
    case "title":
      return titleSlide(x, s, env);
    case "agenda":
      return agendaSlide(x, s, env);
    case "kpis":
      return kpiSlide(x, s, env);
    case "summary":
      return summarySlide(x, s, env);
    case "section":
      return sectionSlide(x, s, env);
    case "text":
      return textSlide(x, s, env);
    case "closing":
      return closingSlide(x, s, env);
  }
}
