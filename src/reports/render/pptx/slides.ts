/**
 * One builder per DeckSlide kind. Each returns the slide XML, its relationships (layout first, then its chart and
 * the logo, in that order) and the notes text. Shapes appear in reading order with the title first; every slide's
 * title is a title placeholder (ctrTitle on the Title layout), so PowerPoint's outline and screen readers see it.
 * All text goes through xml.ts (`esc`); nothing here interpolates data into XML directly.
 */
import { NEUTRAL, TONE } from "../color.js";
import { DECK, type DeckSlide, type DeckTable } from "../deck.js";
import type { Kpi, TableBlock, Text } from "../doc.js";
import { imageSize } from "../image.js";
import type { ChartPart } from "./charts.js";
import { bodyStyle, CONTENT_W, coverFill, coverGeometry, footerStyle, FOOTER_BOX, headingStyle, NUMBER_BOX, PH, SLIDE, titleAnchor, titleBox, type Ctx } from "./master.js";
import { chartFrame, para, picture, rect, REL, Rels, run, shape, slideNumField, spTree, tableFrame, txBody, XML_DECL, PML_NS, type Box, type Cell, type ParaStyle, type RunStyle } from "./xml.js";

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
// Shared pieces

function titleShape(x: Ctx, b: Builder, text: string, number?: number): string {
  const hs = headingStyle(x);
  const runs: string[] = [];
  if (x.t.heading.numbered && number !== undefined) runs.push(run(`${String(number).padStart(2, "0")}  `, { ...hs, bold: true, color: x.p.primaryInk }));
  runs.push(run(text, hs));
  if (x.t.heading.pill) {
    // Friendly: the title sits in a rounded tint pill sized to the text.
    const w = Math.min(CONTENT_W, Math.max(2.4, text.length * hs.size * 0.52 / 72 + 0.7));
    return shape({ id: b.next(), name: "Title", box: { x: SLIDE.margin, y: SLIDE.titleY + 0.12, w, h: 0.62 }, geom: "roundRect", radius: 50000, fill: x.p.tint, line: null, ph: { type: "title" }, text: txBody([para(runs, hs)], { anchor: "ctr", autofit: true, inset: [0.3, 0.04, 0.3, 0.04] }) });
  }
  return shape({ id: b.next(), name: "Title", box: titleBox(x), ph: { type: "title" }, text: txBody([para(runs, hs)], { anchor: titleAnchor(x), autofit: true, inset: [0, 0.05, 0, titleAnchor(x) === "b" ? 0.1 : 0.05] }) });
}

function footer(x: Ctx, b: Builder, n: number) {
  const fs = footerStyle(x);
  if (x.footer) b.add(shape({ id: b.next(), name: "Footer", box: FOOTER_BOX, ph: { type: "ftr", sz: "quarter", idx: PH.footer }, text: txBody([para([run(x.footer, fs)], fs)], { anchor: "ctr" }) }));
  b.add(shape({ id: b.next(), name: "Slide Number", box: NUMBER_BOX, ph: { type: "sldNum", sz: "quarter", idx: PH.slideNum }, text: txBody([para([slideNumField(n, fs)], fs, { align: "r" })], { anchor: "ctr" }) }));
}

const bulletPara = (x: Ctx, text: string, st: RunStyle, before = 8): string => para([run(text, st)], st, { bullet: "•", bulletColor: x.p.primary, before, lineSpacing: 105 } satisfies ParaStyle);

function bullets(x: Ctx, b: Builder, items: string[], box: Box, size = 18): void {
  const st = bodyStyle(x, size);
  b.add(shape({ id: b.next(), name: "Bullets", box, text: txBody(items.map((t) => bulletPara(x, t, st)), { autofit: true }) }));
}

function footnotes(x: Ctx, b: Builder, notes: string[], bottom: number): number {
  if (!notes.length) return bottom;
  const st: RunStyle = { size: 10, color: NEUTRAL.faint, font: x.fonts.body };
  const h = Math.min(0.75, 0.22 * notes.length + 0.08);
  b.add(shape({ id: b.next(), name: "Footnotes", box: { x: SLIDE.margin, y: bottom - h, w: CONTENT_W, h }, text: txBody(notes.map((n) => para([run(n, st)], st)), { anchor: "b", autofit: true, inset: [0, 0, 0, 0] }) }));
  return bottom - h - 0.1;
}

/** The side panel beside a chart or table: the callout fill and left rule from the theme. */
function panel(x: Ctx, b: Builder, box: Box): Box {
  const c = x.t.callout;
  const rounded = x.id === "friendly";
  if (c.fill) b.add(shape({ id: b.next(), name: "Panel", box, geom: rounded ? "roundRect" : "rect", radius: rounded ? 6000 : undefined, fill: x.col(c.fill), line: null }));
  if (c.left) b.add(rect(b.next(), "Panel rule", { x: box.x, y: box.y, w: c.left.weight / 72, h: box.h }, x.col(c.left.color)));
  const pad = c.fill || c.left ? 0.22 : 0.05;
  return { x: box.x + pad, y: box.y + pad * 0.6, w: box.w - 2 * pad, h: box.h - pad * 1.2 };
}

const ARROW = { up: "▲", down: "▼", flat: "–" } as const;

/** KPI tiles in a grid: the theme's shape, top rule or separators; label, value, change and detail. */
function tiles(x: Ctx, b: Builder, kpis: Kpi[], area: Box, cols: number, compact = false): void {
  const k = x.t.kpi;
  const gap = k.separators ? 0.3 : 0.2;
  const rows = Math.ceil(kpis.length / cols);
  const w = (area.w - gap * (cols - 1)) / cols;
  const h = Math.min(compact ? 1.5 : 2.0, (area.h - gap * (rows - 1)) / rows);
  const valueSize = compact ? Math.min(k.valueSize, 26) : k.valueSize;
  kpis.forEach((kpi, i) => {
    const box: Box = { x: area.x + (i % cols) * (w + gap), y: area.y + Math.floor(i / cols) * (h + gap), w, h };
    if (k.shape) b.add(shape({ id: b.next(), name: `Tile ${i + 1}`, box, geom: k.shape === "rounded" ? "roundRect" : "rect", radius: k.shape === "rounded" ? 8000 : undefined, fill: k.fill ? x.col(k.fill) : null, line: k.border ? { color: x.col(k.border), weight: 0.75 } : null }));
    if (k.topRule) b.add(rect(b.next(), `Tile ${i + 1} rule`, { x: box.x, y: box.y, w: box.w, h: k.topRule.weight / 72 }, x.col(k.topRule.color)));
    if (k.separators && i % cols > 0) b.add(rect(b.next(), `Tile ${i + 1} separator`, { x: box.x - gap / 2, y: box.y + 0.1, w: 0.75 / 72, h: box.h - 0.2 }, "#E6E8EB"));
    const label: RunStyle = { size: compact ? 10 : 11, bold: x.id === "bold", caps: k.labelCaps, italic: k.labelItalic, color: x.id === "bold" ? x.p.dark : NEUTRAL.muted, font: x.fonts.body, spacing: k.labelCaps ? 0.5 : undefined };
    const value: RunStyle = { size: valueSize, bold: k.valueBold, color: kpi.tone && kpi.tone !== "neutral" ? TONE[kpi.tone].fg : x.col(k.valueColor), font: x.fonts.heading };
    const paras = [para([run(kpi.label, label)], label), para([run(kpi.value, value)], value, { before: 2 })];
    if (kpi.delta) {
      const d: RunStyle = { size: compact ? 11 : 12, bold: true, color: TONE[kpi.delta.tone].fg, font: x.fonts.body };
      paras.push(para([run(`${ARROW[kpi.delta.dir]} ${kpi.delta.text}`, d)], d, { before: 2 }));
    }
    if (kpi.detail) {
      const s: RunStyle = { size: compact ? 9 : 10, color: NEUTRAL.faint, font: x.fonts.body };
      paras.push(para([run(kpi.detail, s)], s, { before: 2 }));
    }
    const inset = k.shape ? 0.18 : 0.04;
    b.add(shape({ id: b.next(), name: `Tile ${i + 1} text`, box: { x: box.x, y: box.y + (k.topRule ? 0.1 : 0), w: box.w, h: box.h - (k.topRule ? 0.1 : 0) }, text: txBody(paras, { autofit: true, inset: [inset, inset * 0.8, inset, inset * 0.6] }) }));
  });
}

/** A table: header from the theme (colour, bold, caps, italic, rule), zebra rows or thin row rules. */
function table(x: Ctx, b: Builder, t: DeckTable, area: Box): number {
  const tt = x.t.table;
  const cols = Math.max(1, t.header.length);
  const weights = Array.from({ length: cols }, (_, i) => (t.numeric[i] ? 1 : i === 0 ? 2.6 : 1.6));
  const sum = weights.reduce((s, v) => s + v, 0);
  const widths = weights.map((v) => (area.w * v) / sum);
  const n = t.rows.length + 1;
  const rowH = Math.max(0.28, Math.min(0.42, area.h / n));
  const size = rowH < 0.34 ? 11 : 12;
  const head: RunStyle = { size: size - 1, bold: tt.headerBold, caps: tt.headerCaps, italic: tt.headerItalic, color: x.col(tt.headerColor), font: x.fonts.body, spacing: tt.headerCaps ? 0.4 : undefined };
  const body = bodyStyle(x, size);
  const rowRule = tt.zebra ? null : { color: NEUTRAL.rule, weight: 0.5 };
  const align = (i: number): "l" | "r" => (t.numeric[i] ? "r" : "l");
  const cells: Cell[][] = [
    t.header.map((h, i) => ({ text: h, style: head, align: align(i), fill: null, bottom: { color: x.col(tt.headerRule.color), weight: tt.headerRule.weight } })),
    ...t.rows.map((r, ri) => Array.from({ length: cols }, (_, i) => ({ text: r[i] ?? "", style: body, align: align(i), fill: tt.zebra && ri % 2 === 1 ? x.col(tt.zebra) : null, bottom: rowRule }))),
  ];
  b.add(tableFrame(b.next(), "Table", area, widths, Array(n).fill(rowH), cells));
  return n * rowH;
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

function agendaSlide(x: Ctx, s: Of<"agenda">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const twoCols = s.items.length > 7;
  const per = twoCols ? Math.ceil(s.items.length / 2) : s.items.length;
  const size = twoCols ? 16 : 20;
  const num: RunStyle = { size, bold: true, color: x.p.primaryInk, font: x.fonts.body };
  const st = bodyStyle(x, size);
  for (let col = 0; col < (twoCols ? 2 : 1); col++) {
    const items = s.items.slice(col * per, (col + 1) * per);
    const paras = items.map((t, i) => para([run(`${String(col * per + i + 1).padStart(2, "0")}   `, num), run(t, st)], st, { before: 10 }));
    const w = twoCols ? CONTENT.w / 2 - 0.2 : CONTENT.w;
    b.add(shape({ id: b.next(), name: `Agenda ${col + 1}`, box: { x: CONTENT.x + col * (CONTENT.w / 2 + 0.2), y: CONTENT.y + 0.1, w, h: CONTENT.h - 0.1 }, text: txBody(paras, { autofit: true }) }));
  }
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

function kpiSlide(x: Ctx, s: Of<"kpis">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const cols = Math.min(4, Math.max(1, s.kpis.length));
  tiles(x, b, s.kpis.slice(0, 8), { x: CONTENT.x, y: CONTENT.y + 0.4, w: CONTENT.w, h: s.kpis.length > 4 ? 4.2 : 2.2 }, cols);
  if (s.caption) footnotes(x, b, [s.caption], SLIDE.contentBottom);
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

function summarySlide(x: Ctx, s: Of<"summary">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  const bottom = footnotes(x, b, s.caption ? [s.caption] : [], SLIDE.contentBottom);
  const inner = panel(x, b, { x: CONTENT.x, y: CONTENT.y + 0.1, w: CONTENT.w, h: bottom - CONTENT.y - 0.1 });
  bullets(x, b, s.bullets, inner, 20);
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
}

function textSlide(x: Ctx, s: Of<"text">, env: SlideEnv): BuiltSlide {
  // Text slides carry no section number in the contract; use one if the deck model adds it.
  const number = (s as { number?: number }).number;
  const b = bodySlide(x, s.title, number);
  bullets(x, b, s.bullets, { ...CONTENT, y: CONTENT.y + 0.1, h: CONTENT.h - 0.1 });
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
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

  const drawChart = (box: Box) => {
    if (s.chart && env.chart) {
      const rId = b.rels.add(REL.chart, `../charts/chart${env.chartNo}.xml`);
      b.add(chartFrame(b.next(), "Chart", s.chart.summary || s.chart.title, rId, box));
      chart = { no: env.chartNo, part: env.chart };
    } else if (fallback) table(x, b, fallback, box);
  };
  const drawSide = () => {
    if (s.bullets.length) bullets(x, b, s.bullets, panel(x, b, sideBox), 16);
    else if (tilesList.length) tiles(x, b, tilesList.slice(0, 4), sideBox, 2, true);
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
    table(x, b, s.table, main);
    if (side) drawSide();
  } else if (tilesList.length) {
    const rows = Math.ceil(tilesList.length / 4);
    const th = Math.min(rows * 1.8, s.bullets.length ? area.h * 0.55 : area.h);
    tiles(x, b, tilesList, { ...area, h: th }, Math.min(4, tilesList.length), rows > 1);
    if (s.bullets.length) bullets(x, b, s.bullets, { ...area, y: area.y + th + 0.25, h: area.h - th - 0.25 }, 16);
  } else if (s.bullets.length) bullets(x, b, s.bullets, area);

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
