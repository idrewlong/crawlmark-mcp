/**
 * One builder per DeckSlide kind. Each returns the slide XML, its relationships (layout first, then its chart and
 * the logo, in that order) and the notes text. Shapes appear in reading order with the title first; every slide's
 * title is a title placeholder (ctrTitle on the Title layout), so PowerPoint's outline and screen readers see it.
 * All text goes through xml.ts (`esc`); nothing here interpolates data into XML directly.
 *
 * Layout follows the 0.4.0 deck design brief (docs/research/2026-11-02-deck-design-brief.md): every body slide has
 * one dominant block that fills the content area (type and row height step up a ladder until it does; short tables
 * get in-cell bars, one- and two-row tables become record cards), commentary sits in a side column as tall as the
 * chart beside it, and each theme draws its own surface (cards, rules, a label column, a serif lead, colour blocks).
 */
import { inkOn, mix, NEUTRAL, SERIES, TONE } from "../color.js";
import { AGENDA_GRID_MAX, DECK, type DeckSlide, type DeckTable, type DeckTone } from "../deck.js";
import type { Chart, Kpi, TableBlock, Text } from "../doc.js";
import { shareColors } from "../svg.js";
import { imageSize } from "../image.js";
import type { ChartPart } from "./charts.js";
import { bodyStyle, CONTENT_W, coverFill, coverGeometry, footerStyle, FOOTER_BOX, headingStyle, NUMBER_BOX, PH, SLIDE, titleAnchor, titleBox, type Ctx } from "./master.js";
import { chartFrame, para, picture, REL, Rels, run, shape, slideNumField, spTree, tableFrame, tabRun, txBody, XML_DECL, PML_NS, type Box, type Cell, type Geom, type ParaStyle, type RunStyle } from "./xml.js";

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

/** The gap between blocks and the inner padding of every panel (inches). */
const GAP = 0.25;
const PAD = 0.3;
/** A 1 pt rule. */
const RULE = 1 / 72;

/**
 * A rule on a slide (tile rules, panel rules, separators): a filled rectangle at least 1 pt thick with an empty text
 * body. Quick Look draws lines and text-less shapes as pictures and repeats those pictures on later slides, striking
 * through other content; shapes with a text body it draws in place. (Rules on the master are unaffected.)
 */
function bar(b: Builder, name: string, box: Box, color: string): string {
  return shape({ id: b.next(), name, box: { ...box, w: Math.max(box.w, RULE), h: Math.max(box.h, RULE) }, geom: "rect", fill: color, line: null, text: txBody([]) });
}

/** A decorative shape (card, block, chip, circle) with an empty text body, for the same Quick Look reason. `radius` in inches. */
function deco(b: Builder, name: string, box: Box, fill: string | null, o: { radius?: number; line?: { color: string; weight: number } | null; geom?: Geom } = {}): string {
  const geom = o.geom ?? (o.radius ? "roundRect" : "rect");
  const radius = geom === "roundRect" && o.radius ? Math.min(50000, Math.round((o.radius / Math.min(box.w, box.h)) * 100000)) : undefined;
  return shape({ id: b.next(), name, box, geom, radius, fill, line: o.line ?? null, text: txBody([]) });
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
/** The height of a wrapped text in a box `width` wide. */
const textH = (text: string, st: RunStyle, width: number, spacing = 1) => lineCount(text, st, width) * lineH(st, spacing);
/** The largest size from `sizes` (largest first) at which `ok` holds; the smallest otherwise. */
const fitSize = (sizes: number[], ok: (size: number) => boolean) => sizes.find(ok) ?? sizes[sizes.length - 1]!;

// ---------------------------------------------------------------------------------------------------------------
// Grid, surfaces and shared pieces

/**
 * Exported for tests. The content area of a body slide: under the title (and the takeaway line when there is one,
 * `takeawayLines` lines of it), above the source line.
 */
export function contentArea(takeaway: boolean, takeawayLines = 1): Box {
  const y = takeaway ? SLIDE.takeawayContentY + (Math.max(1, Math.min(2, takeawayLines)) - 1) * TAKEAWAY_LINE : SLIDE.contentY;
  return { x: SLIDE.margin, y, w: CONTENT_W, h: SLIDE.contentBottom - y };
}

const inset = (b: Box, p: number): Box => ({ x: b.x + p, y: b.y + p, w: b.w - 2 * p, h: b.h - 2 * p });
/** Where a block `h` tall sits in `area`: a little above the middle (the optical centre). */
const centred = (area: Box, h: number) => area.y + Math.max(0, (area.h - h) * 0.42);
/** The padding a content block gets inside its card (none on themes without cards). */
const cardPad = (x: Ctx) => (x.t.surface.card ? PAD : 0);
/** The surface content sits on: the card fill, else the slide background. */
const surfaceBg = (x: Ctx) => (x.t.surface.card ? x.col(x.t.surface.card.fill) : x.col(x.t.background));
/** A separator a little darker than its background. */
const ruleOn = (bg: string) => mix(bg, NEUTRAL.ink, 0.14);
/** The primary as small text on `bg` (4.5:1). */
const accentOn = (x: Ctx, bg: string) => inkOn(x.p.primaryInk, bg, 4.5);

/** Exported for tests. The primary as small text on the body slides' background (4.5:1 there, not just on white). */
export const accentInk = (x: Ctx) => accentOn(x, x.col(x.t.background));

/** A content card (cards, friendly: white, rounded, hairline border) around `box`; returns the box content goes in. */
function contentCard(x: Ctx, b: Builder, box: Box, name = "Card"): Box {
  const c = x.t.surface.card;
  if (!c) return box;
  b.add(deco(b, name, box, x.col(c.fill), { radius: c.radius, line: c.border ? { color: x.col(c.border), weight: 0.75 } : null }));
  return inset(box, PAD);
}

/** A block's top rule on themes without cards (bold: 4 pt primary; editorial: 3 pt ink; others: a 1 pt hairline). */
function topRule(x: Ctx, b: Builder, box: Box, name: string): number {
  const r = x.t.kpi.topRule;
  const weight = r && r.weight > 1 ? r.weight / 72 : RULE;
  const color = r && r.weight > 1 ? x.col(r.color) : x.id === "minimal" || x.id === "consulting" ? NEUTRAL.ink : ruleOn(x.col(x.t.background));
  b.add(bar(b, name, { x: box.x, y: box.y, w: box.w, h: weight }, color));
  return weight;
}

/**
 * The commentary panel (side column, verdict banner): the theme's callout fill (rounded on card themes), its left
 * rule with the text ≥ 0.3 in past it, or a hairline on top when the theme has neither. Returns the text box and its
 * background colour.
 */
function calloutPanel(x: Ctx, b: Builder, box: Box, name: string): { inner: Box; bg: string } {
  const c = x.t.callout;
  const card = x.t.surface.card;
  const bg = c.fill ? x.col(c.fill) : x.col(x.t.background);
  if (c.fill) b.add(deco(b, name, box, bg, card ? { radius: card.radius } : {}));
  if (c.left) b.add(bar(b, `${name} rule`, { x: box.x, y: box.y, w: c.left.weight / 72, h: box.h }, x.col(c.left.color)));
  if (!c.fill && !c.left) b.add(bar(b, `${name} rule`, { x: box.x, y: box.y, w: box.w, h: RULE }, NEUTRAL.ink));
  const l = (c.left ? c.left.weight / 72 : 0) + (c.fill || c.left ? PAD : 0);
  const top = c.fill ? PAD : 0.25;
  const bottom = c.fill ? PAD : 0;
  const right = c.fill ? PAD : 0;
  return { inner: { x: box.x + l, y: box.y + top, w: box.w - l - right, h: box.h - top - bottom }, bg };
}

/** A text box with no insets (the layout places it). */
function textBox(b: Builder, name: string, box: Box, paras: string[], o: { anchor?: "t" | "ctr" | "b"; autofit?: boolean; wrap?: boolean; ph?: { type: string; idx?: number } } = {}): string {
  return shape({ id: b.next(), name, box, ...(o.ph ? { ph: o.ph } : {}), text: txBody(paras, { anchor: o.anchor ?? "t", inset: [0, 0, 0, 0], ...(o.autofit ? { autofit: true } : {}), ...(o.wrap === false ? { wrap: false } : {}) }) });
}
const line1 = (text: string, st: RunStyle, ps: ParaStyle = {}) => para([run(text, st)], st, ps);

/** Small caps label ("Commentary", "Summary"): 12 pt, the primary as text on its background (italic, no caps, in editorial). */
const labelStyle = (x: Ctx, bg: string, size = 12): RunStyle => ({ size, bold: !x.t.kpi.labelItalic, italic: x.t.kpi.labelItalic, ...(x.t.kpi.labelItalic ? {} : { caps: true, spacing: 1 }), color: accentOn(x, bg), font: x.fonts.body });

/** Friendly's pill: padding left and right of the title text. */
const PILL_PAD = 0.28;
const CONTINUED = /\s*\(continued\)$/;

function titleShape(x: Ctx, b: Builder, text: string, number?: number, continued = false): string {
  const base = headingStyle(x);
  const title = continued ? text.replace(CONTINUED, "") : text;
  const tag: RunStyle = { size: 14, italic: x.id === "editorial", color: x.t.heading.pill ? x.col(x.t.heading.color) : NEUTRAL.muted, font: x.fonts.body };
  const tagText = continued ? "   continued" : "";
  const num = x.t.heading.numbered && number !== undefined ? `${String(number).padStart(2, "0")}  ` : "";
  // A long title steps down to 24 pt before it wraps (P14).
  const room = (x.t.heading.pill ? CONTENT_W - 2 * PILL_PAD : titleBox(x).w) - (tagText ? textWidth(tagText, tag) : 0) - 0.1;
  const hs: RunStyle = { ...base, size: fitSize([base.size, 28, 26, 24].filter((s) => s <= base.size), (s) => textWidth(num + title, { ...base, size: s }) <= room) };
  const runs: string[] = [];
  if (num) runs.push(run(num, { ...hs, bold: true, color: accentInk(x) }));
  runs.push(run(title, hs));
  if (tagText) runs.push(run(tagText, tag));
  if (x.t.heading.pill) {
    // Friendly: the title sits in a rounded tint pill sized to the text (an estimate from the font and size). The pill
    // is its own shape behind an unfilled, non-wrapping title placeholder, so every app draws the rounded ends and
    // a long title never wraps out of it.
    // The text box is exactly the pill and the text is centred in it, so an error in the width estimate is split
    // evenly between the two ends instead of piling up on the right.
    const w = Math.min(CONTENT_W, textWidth(num + title, hs) + (tagText ? textWidth(tagText, tag) : 0) + 2 * PILL_PAD);
    const box: Box = { x: SLIDE.margin, y: SLIDE.titleY + 0.12, w, h: 0.62 };
    b.add(shape({ id: b.next(), name: "Title pill", box, geom: "roundRect", radius: 50000, fill: x.p.tint, line: null, text: txBody([]) }));
    return shape({ id: b.next(), name: "Title", box, fill: null, line: null, ph: { type: "title" }, text: txBody([para(runs, hs, { align: "ctr" })], { anchor: "ctr", wrap: false, inset: [0.2, 0.04, 0.2, 0.04] }) });
  }
  return shape({ id: b.next(), name: "Title", box: titleBox(x), ph: { type: "title" }, text: txBody([para(runs, hs)], { anchor: titleAnchor(x), autofit: true, inset: [0, 0.05, 0, titleAnchor(x) === "b" ? 0.1 : 0.05] }) });
}

/** The takeaway line under the title: one sentence of the section's own text, 16 pt muted (italic in editorial). */
const TAKEAWAY_LINE = 0.27;
const takeawayStyle = (x: Ctx): RunStyle => ({ size: 16, italic: x.id === "editorial", color: NEUTRAL.muted, font: x.fonts.body });
const takeawayLeft = (x: Ctx) => (x.t.heading.pill ? SLIDE.margin : titleBox(x).x);
/** How many lines the takeaway takes (two at most; the content moves down for the second). */
const takeawayLines = (x: Ctx, text: string) => Math.min(2, lineCount(text, takeawayStyle(x), SLIDE.w - SLIDE.margin - takeawayLeft(x) - 0.2));

function takeawayLine(x: Ctx, b: Builder, text: string): void {
  const left = takeawayLeft(x);
  const h = SLIDE.takeawayContentY - SLIDE.takeawayY - 0.12 + (takeawayLines(x, text) - 1) * TAKEAWAY_LINE;
  b.add(textBox(b, "Takeaway", { x: left, y: SLIDE.takeawayY, w: SLIDE.w - SLIDE.margin - left, h }, [line1(text, takeawayStyle(x), { lineSpacing: 95 })], { autofit: true }));
}

/** The source line above the footer: sources and "more in the report" notes, 11 pt faint. */
function sourceLine(x: Ctx, b: Builder, notes: string[]): void {
  if (!notes.length) return;
  const st: RunStyle = { size: 11, color: NEUTRAL.faint, font: x.fonts.body };
  b.add(textBox(b, "Source line", { x: SLIDE.margin, y: SLIDE.sourceY, w: CONTENT_W - 1.6, h: 0.26 }, [line1(notes.join("  ·  "), st)], { anchor: "ctr", autofit: true }));
}

function footer(x: Ctx, b: Builder, n: number) {
  const fs = footerStyle(x);
  if (x.footer) b.add(shape({ id: b.next(), name: "Footer", box: FOOTER_BOX, ph: { type: "ftr", sz: "quarter", idx: PH.footer }, text: txBody([para([run(x.footer, fs)], fs)], { anchor: "ctr" }) }));
  b.add(shape({ id: b.next(), name: "Slide Number", box: NUMBER_BOX, ph: { type: "sldNum", sz: "quarter", idx: PH.slideNum }, text: txBody([para([slideNumField(n, fs)], fs, { align: "r" })], { anchor: "ctr" }) }));
}

/** Bold's colour block: a primary band bleeding off the right edge (agenda and key numbers). */
function edgeBlock(x: Ctx, b: Builder): void {
  if (x.t.surface.edgeBlock) b.add(deco(b, "Edge block", { x: SLIDE.w - 0.35, y: 0, w: 0.35, h: SLIDE.h }, x.p.primary));
}

/** Exported for tests. The bullet's hanging indent for a font size: the dot sits just left of the text. */
export const bulletHang = (size: number) => Math.round((size * 0.75) / 72 * 100) / 100;
const ITEM_SPACING = 1.08;

const bulletPara = (x: Ctx, text: string, st: RunStyle): string => para([run(text, st)], st, { bullet: "•", bulletColor: x.p.primary, lineSpacing: ITEM_SPACING * 100, hang: bulletHang(st.size) } satisfies ParaStyle);

/** A numbered item: the number in the accent, a tab, the text; wrapped lines start under the text. */
function numberedPara(num: string, text: string, ns: RunStyle, st: RunStyle, tab: number): string {
  return para([run(num, ns), tabRun(ns), run(text, st)], st, { hang: tab, tabs: [tab], lineSpacing: ITEM_SPACING * 100 });
}

/** Exported for tests. A number column: "00" in the number style plus a gap; the item text starts at this tab stop. */
export const agendaTab = (num: RunStyle) => Math.round((textWidth("00", num) + 0.3) * 100) / 100;

/**
 * Commentary items spread over a box: equal slots, each item centred in its slot, a hairline between slots. The type
 * steps down through `sizes` until every item fits its slot. Bullets, or numbers when `numbered`.
 */
function spreadItems(x: Ctx, b: Builder, box: Box, items: string[], o: { sizes: number[]; bg: string; name: string; numbered?: boolean; rules?: boolean; start?: number }): number {
  const n = Math.max(1, items.length);
  const slot = box.h / n;
  const numSt = (size: number): RunStyle => ({ size: Math.round(size * 1.25), bold: true, color: accentOn(x, o.bg), font: x.fonts.heading });
  const textW = (size: number) => box.w - (o.numbered ? agendaTab(numSt(size)) : bulletHang(size)) - 0.05;
  const size = fitSize(o.sizes, (s) => items.every((t) => textH(t, bodyStyle(x, s), textW(s), ITEM_SPACING) <= slot - 0.2));
  const st = bodyStyle(x, size);
  items.forEach((t, i) => {
    const y = box.y + i * slot;
    if (i && o.rules !== false) b.add(bar(b, `${o.name} rule ${i}`, { x: box.x, y, w: box.w, h: RULE }, ruleOn(o.bg)));
    const ns = numSt(size);
    const p = o.numbered ? numberedPara(String((o.start ?? 1) + i).padStart(2, "0"), t, ns, st, agendaTab(ns)) : bulletPara(x, t, st);
    b.add(textBox(b, `${o.name} ${i + 1}`, { x: box.x, y: y + 0.08, w: box.w, h: slot - 0.16 }, [p], { anchor: "ctr", autofit: true }));
  });
  return size;
}

/** The side column beside a chart or table: the callout panel, a "Commentary" label, the items spread over its height. */
function sideColumn(x: Ctx, b: Builder, box: Box, items: string[]): void {
  const { inner, bg } = calloutPanel(x, b, box, "Side panel");
  const ls = labelStyle(x, bg);
  b.add(textBox(b, "Side label", { ...inner, h: 0.3 }, [line1("Commentary", ls)], { anchor: "t" }));
  const list: Box = { ...inner, y: inner.y + 0.4, h: inner.h - 0.4 };
  spreadItems(x, b, list, items, { sizes: [20, 18, 16], bg, name: "Side item" });
}

/** Consulting's label column: a small caps label left of a block, with a rule over both. Returns the block's box. */
function labelColumn(x: Ctx, b: Builder, area: Box, label: string): Box {
  if (!x.t.surface.labelColumn) return area;
  const bg = x.col(x.t.background);
  b.add(bar(b, "Label rule", { x: area.x, y: area.y, w: area.w, h: RULE }, NEUTRAL.ink));
  b.add(textBox(b, "Label", { x: area.x, y: area.y + 0.2, w: 1.9, h: 0.6 }, [line1(label, labelStyle(x, bg))]));
  return { x: area.x + 2.25, y: area.y + 0.1, w: area.w - 2.25, h: area.h - 0.1 };
}

/**
 * Insight rows: numbered items over the full height (a hairline between rows), at most 1.5 in a row so a short list
 * doesn't spread thin; the block sits at the optical centre.
 */
function insightRows(x: Ctx, b: Builder, area: Box, items: string[], sizes: number[], label: string): void {
  const h = Math.min(area.h, items.length * 1.7);
  const box = labelColumn(x, b, { ...area, y: centred(area, h), h }, label);
  spreadItems(x, b, box, items, { sizes, bg: x.col(x.t.background), name: "Item", numbered: true });
}

/** Editorial's lead: the first sentence large in the serif, the rest as numbered rows under a hairline. */
function editorialLead(x: Ctx, b: Builder, area: Box, items: string[]): void {
  const [first, ...rest] = items;
  const lead: RunStyle = { size: fitSize([36, 32, 30, 28], (s) => lineCount(first!, { ...bodyStyle(x, s), font: x.fonts.heading }, area.w) <= (s > 32 ? 1 : 3)), color: NEUTRAL.ink, font: x.fonts.heading };
  const leadH = textH(first!, lead, area.w, 1.05) + 0.15;
  // The rows under the lead take at least two thirds of the height, so a short summary doesn't end halfway down.
  const restH = rest.length ? Math.min(area.h - leadH - 0.5, Math.max(rest.length * 1.1, area.h * 0.68 - leadH - 0.5)) : 0;
  const total = leadH + (rest.length ? 0.5 + restH : 0);
  const y = rest.length ? area.y + Math.max(0, (area.h - total) * 0.3) : centred(area, leadH);
  b.add(textBox(b, "Lead", { x: area.x, y, w: area.w, h: leadH }, [line1(first!, lead, { lineSpacing: 105 })], { autofit: true }));
  if (!rest.length) return;
  b.add(bar(b, "Lead rule", { x: area.x, y: y + leadH + 0.25, w: area.w, h: RULE }, NEUTRAL.ink));
  spreadItems(x, b, { x: area.x, y: y + leadH + 0.5, w: area.w, h: restH }, rest, { sizes: [22, 20, 18], bg: x.col(x.t.background), name: "Item", numbered: true });
}

/**
 * Insight cards (a summary of up to three points): equal cards across, about 70% of the content height; the number
 * at the top, the text at the bottom, 32 → 20 pt until each text fits in four lines.
 */
function insightCards(x: Ctx, b: Builder, area: Box, items: string[]): void {
  const n = items.length;
  const w = (area.w - (n - 1) * GAP) / n;
  const pad = x.t.surface.card ? PAD : 0;
  const inner = w - 2 * pad - 0.05;
  const size = fitSize([32, 28, 24, 22, 20], (s) => items.every((t) => lineCount(t, bodyStyle(x, s), inner) <= 4));
  const st = bodyStyle(x, size);
  const textMax = Math.max(...items.map((t) => textH(t, st, inner, 1.1)));
  const h = Math.min(area.h, Math.max(area.h * 0.72, textMax + 1.4 + 2 * pad));
  const y = centred(area, h);
  const bg = surfaceBg(x);
  const ns: RunStyle = { size: 40, bold: x.t.heading.bold || x.id !== "minimal", color: accentOn(x, bg), font: x.fonts.heading };
  items.forEach((t, i) => {
    const box: Box = { x: area.x + i * (w + GAP), y, w, h };
    let c = contentCard(x, b, box, `Insight card ${i + 1}`);
    if (!x.t.surface.card) {
      const r = topRule(x, b, box, `Insight ${i + 1} rule`);
      c = { ...box, y: box.y + r + 0.2, h: box.h - r - 0.2 };
    }
    b.add(textBox(b, `Insight ${i + 1} number`, { ...c, h: 0.75 }, [line1(String(i + 1).padStart(2, "0"), ns)]));
    b.add(textBox(b, `Insight ${i + 1}`, { ...c, y: c.y + 0.9, h: c.h - 0.9 }, [line1(t, st, { lineSpacing: 110 })], { anchor: "b", autofit: true }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// KPI cards

const ARROW = { up: "▲", down: "▼", flat: "–" } as const;
const CHIP_PAD = 0.1;
const chipH = (st: RunStyle) => lineH(st) + 0.08;

/** "hero": the Key numbers band (chip and comparison under the value); "row": a section's tile row (chip beside the value). */
type KpiKind = "hero" | "row";
const KPI_TYPE: Record<KpiKind, { label: number; delta: number; detail: number; inline: boolean }> = {
  hero: { label: 14, delta: 16, detail: 13, inline: false },
  row: { label: 12, delta: 13, detail: 11, inline: true },
};

/**
 * KPI cards in a grid that fills `area`: the theme's card, top rule or separators; the label at the top, the change
 * chip and comparison pinned to the bottom, the value centred between them. One value size for all cards: the
 * largest that fits every card's width and height, capped at the theme's size (P3).
 */
function kpiCards(x: Ctx, b: Builder, kpis: Kpi[], area: Box, cols: number, kind: KpiKind, valueMax = x.t.kpi.valueSize): void {
  const k = x.t.kpi;
  const T = KPI_TYPE[kind];
  const gap = k.separators ? 0.5 : GAP;
  const rows = Math.ceil(kpis.length / cols);
  const w = (area.w - gap * (cols - 1)) / cols;
  const h = (area.h - gap * (rows - 1)) / rows;
  const padX = k.shape ? (kind === "row" ? 0.25 : PAD) : 0;
  const ruleW = k.shape ? 0 : k.topRule ? Math.max(k.topRule.weight / 72, RULE) : 0;
  const padTop = k.shape ? (kind === "row" ? 0.2 : PAD) : ruleW + 0.2;
  const padBottom = k.shape ? (kind === "row" ? 0.18 : PAD) : 0.05;
  const bg = k.fill ? x.col(k.fill) : x.col(x.t.background);
  const label: RunStyle = { size: T.label, bold: x.id === "bold", caps: k.labelCaps, italic: k.labelItalic, color: x.id === "bold" ? x.p.dark : NEUTRAL.muted, font: x.fonts.body, ...(k.labelCaps ? { spacing: 1 } : {}) };
  const delta: RunStyle = { size: T.delta, bold: true, color: NEUTRAL.ink, font: x.fonts.body };
  const detail: RunStyle = { size: T.detail, color: NEUTRAL.faint, font: x.fonts.body };
  const inner = w - 2 * padX;
  const deltaText = (kpi: Kpi) => (kpi.delta ? `${ARROW[kpi.delta.dir]} ${kpi.delta.text}` : "");
  const chipW = (kpi: Kpi) => (kpi.delta ? (k.chip ? textWidth(deltaText(kpi), delta) + 2 * CHIP_PAD + 0.06 : textWidth(deltaText(kpi), delta) + 0.05) : 0);
  const labelH = Math.max(...kpis.map((kpi) => textH(kpi.label, label, inner)));
  const detailH = Math.max(0, ...kpis.map((kpi) => (kpi.detail ? textH(kpi.detail, detail, inner) : 0)));
  const deltaH = kpis.some((kpi) => kpi.delta) ? (k.chip ? chipH(delta) : lineH(delta)) : 0;
  const bottomH = (T.inline ? 0 : deltaH + (detailH ? 0.08 : 0)) + detailH;
  const base: RunStyle = { size: valueMax, bold: k.valueBold, color: NEUTRAL.ink, font: x.fonts.heading };
  const fitW = Math.min(...kpis.map((kpi) => Math.floor((base.size * (inner - 0.1 - (T.inline ? chipW(kpi) + 0.2 : 0))) / Math.max(0.01, textWidth(kpi.value, base)))));
  const valueRoom = h - padTop - padBottom - labelH - 0.1 - (bottomH ? bottomH + 0.12 : 0);
  const fitH = Math.floor((valueRoom * 72) / 1.25);
  const valueSize = Math.max(16, Math.min(valueMax, fitW, fitH));
  kpis.forEach((kpi, i) => {
    const box: Box = { x: area.x + (i % cols) * (w + gap), y: area.y + Math.floor(i / cols) * (h + gap), w, h };
    const n = i + 1;
    if (k.shape) b.add(deco(b, `Tile ${n}`, box, k.fill ? x.col(k.fill) : null, { ...(k.shape === "rounded" ? { radius: x.t.surface.card?.radius ?? 0.12 } : {}), line: k.border ? { color: x.col(k.border), weight: 0.75 } : null }));
    if (k.topRule) b.add(bar(b, `Tile ${n} rule`, { x: box.x, y: box.y, w: box.w, h: ruleW }, x.col(k.topRule.color)));
    if (k.separators && i % cols > 0) b.add(bar(b, `Tile ${n} separator`, { x: box.x - gap / 2, y: box.y + 0.1, w: RULE, h: box.h - 0.2 }, ruleOn(bg)));
    const left = box.x + padX;
    const vs: RunStyle = { ...base, size: valueSize, color: kpi.tone && kpi.tone !== "neutral" ? TONE[kpi.tone].fg : x.col(k.valueColor) };
    b.add(textBox(b, `Tile ${n} label`, { x: left, y: box.y + padTop, w: inner, h: labelH }, [line1(kpi.label, label)]));
    const bottom = box.y + box.h - padBottom;
    const mid = { y: box.y + padTop + labelH + 0.1, h: bottom - (bottomH ? bottomH + 0.12 : 0) - (box.y + padTop + labelH + 0.1) };
    const valueH = lineH(vs, 1.08);
    const valueY = mid.y + Math.max(0, (mid.h - valueH) / 2);
    b.add(textBox(b, `Tile ${n} value`, { x: left, y: valueY, w: inner, h: valueH }, [line1(kpi.value, vs)], { anchor: "ctr", wrap: false }));
    if (kpi.delta) {
      const d: RunStyle = { ...delta, color: TONE[kpi.delta.tone].fg };
      const dh = k.chip ? chipH(d) : lineH(d);
      const cw = Math.min(inner, chipW(kpi));
      const at: Box = T.inline
        ? { x: Math.min(left + inner - cw, left + textWidth(kpi.value, vs) + 0.2), y: valueY + (valueH - dh) / 2, w: cw, h: dh }
        : { x: left, y: bottom - detailH - (detailH ? 0.08 : 0) - dh, w: cw, h: dh };
      if (k.chip) b.add(shape({ id: b.next(), name: `Tile ${n} change`, box: at, geom: "roundRect", radius: 50000, fill: TONE[kpi.delta.tone].bg, line: null, text: txBody([para([run(deltaText(kpi), d)], d, { align: "ctr" })], { anchor: "ctr", wrap: false, inset: [CHIP_PAD, 0, CHIP_PAD, 0] }) }));
      else b.add(textBox(b, `Tile ${n} change`, { ...at, w: Math.min(inner, cw + 0.1) }, [line1(deltaText(kpi), d)], { anchor: "ctr", wrap: false }));
    }
    if (kpi.detail) b.add(textBox(b, `Tile ${n} detail`, { x: left, y: bottom - detailH, w: inner, h: detailH }, [line1(kpi.detail, detail)], { anchor: "b" }));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Tables

/** Table cell margins (left + right) as written by xml.ts, plus a little slack. */
const CELL_PAD = 0.16 + 0.06;
/** Extra space before a left-aligned column that follows a right-aligned (number) column, so the two don't touch. */
const GUTTER = 0.25;
const gutterBefore = (numeric: boolean[], i: number) => i > 0 && !numeric[i] && numeric[i - 1] === true;

/**
 * Exported for tests. Column widths from the content: each column wants its longest cell (and its header, which may
 * wrap past 1.8 in) plus `extra` (room for in-cell bars); spare width is shared in proportion, and when the table is
 * too wide the widest columns give way first (none below `min`, or its own need when that is smaller).
 */
export function columnWidths(header: string[], rows: string[][], total: number, head: RunStyle, body: RunStyle, min = 0.85, numeric: boolean[] = [], extra: number[] = []): number[] {
  const need = header.map((h, i) => Math.max(Math.min(textWidth(h, head), 1.8), ...rows.map((r) => textWidth(r[i] ?? "", body))) + CELL_PAD + (gutterBefore(numeric, i) ? GUTTER : 0) + (extra[i] ?? 0));
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

/** Exported for tests. The fill ladder (P1): body type and row height step up together. */
export const TABLE_LADDER = [
  { size: 14, row: 0.42 },
  { size: 16, row: 0.5 },
  { size: 18, row: 0.6 },
  { size: 20, row: 0.7 },
  // Short tables (four rows or fewer fit here) step up once more so they don't sit in half the slide.
  { size: 22, row: 0.85 },
] as const;
const HEADER_ROW = 0.45;
/** Room an in-cell bar column gets left of its numbers. */
const BAR_ROOM = 1.6;
/** In-cell bars only on short tables (four rows at most), where the rows are tall and the slide would be sparse. */
const BAR_MAX_ROWS = 4;

export interface TableLayout {
  widths: number[];
  rowH: number[];
  size: number;
  height: number;
  /** In-cell bars in the table's bar column. */
  bars: boolean;
}

const headStyle = (x: Ctx): RunStyle => {
  const tt = x.t.table;
  return { size: 12, bold: tt.headerBold, caps: tt.headerCaps, italic: tt.headerItalic, color: x.col(tt.headerColor), font: x.fonts.body, ...(tt.headerCaps ? { spacing: 0.6 } : {}) };
};
/** The first column is the label column: bold when it holds text. */
const cellStyle = (x: Ctx, t: DeckTable, size: number, col: number): RunStyle => ({ ...bodyStyle(x, size), ...(col === 0 && !t.numeric[0] ? { bold: true } : {}) });

/**
 * Exported for tests. The table's type and row heights: the largest ladder step whose table fits `maxH` (rows of
 * 0.42–0.7 in at 14–20 pt). In-cell bars are added when asked for, the table is short and no cell wraps. A table too
 * tall even at 14 pt keeps 14 pt and tightens its rows (never the type).
 */
export function tableLayout(x: Ctx, t: DeckTable, w: number, maxH: number, o: { bars?: boolean; maxStep?: number } = {}): TableLayout {
  const head = headStyle(x);
  const at = (step: { size: number; row: number }, bars: boolean): TableLayout & { wraps: boolean } => {
    const body = bodyStyle(x, step.size);
    const first = cellStyle(x, t, step.size, 0);
    const extra: number[] = t.header.map((_, i) => (bars && t.bar?.col === i ? BAR_ROOM : 0));
    extra[0] = (extra[0] ?? 0) + Math.max(0, ...t.rows.map((r) => textWidth(r[0] ?? "", first) - textWidth(r[0] ?? "", body)));
    const widths = columnWidths(t.header, t.rows, w, head, body, 0.85, t.numeric, extra);
    const room = (j: number) => widths[j]! - CELL_PAD - (gutterBefore(t.numeric, j) ? GUTTER : 0) - (bars && t.bar?.col === j ? BAR_ROOM : 0) + 0.04;
    const lines = (cells: string[], st: (j: number) => RunStyle) => Math.max(1, ...cells.map((c, j) => lineCount(c, st(j), room(j))));
    const headH = Math.max(HEADER_ROW, lines(t.header, () => head) * lineH(head) + 0.16);
    const bodyLines = t.rows.map((r) => lines(r, (j) => cellStyle(x, t, step.size, j)));
    const rowH = [headH, ...bodyLines.map((n) => Math.max(step.row, n * lineH(body) + 0.16))];
    return { widths, rowH, size: step.size, height: rowH.reduce((a, v) => a + v, 0), bars, wraps: bodyLines.some((n) => n > 1) };
  };
  const wantBars = !!o.bars && !!t.bar && t.rows.length >= 2 && t.rows.length <= BAR_MAX_ROWS && Math.max(...t.bar.values) > 0;
  const top = Math.min(o.maxStep ?? TABLE_LADDER.length - 1, TABLE_LADDER.length - 1);
  for (let i = top; i >= 0; i--) {
    let l = at(TABLE_LADDER[i]!, wantBars);
    if (l.bars && l.wraps) l = at(TABLE_LADDER[i]!, false);
    if (l.height <= maxH + 1e-6 || i === 0) {
      if (l.height > maxH + 1e-6) {
        // Tighten the body rows toward their text (down to 0.34 in) so the table fits.
        const body = l.rowH.slice(1);
        const spare = maxH - l.rowH[0]!;
        const k = Math.max(0.34 / TABLE_LADDER[0].row, Math.min(1, spare / body.reduce((a, v) => a + v, 0)));
        l.rowH = [l.rowH[0]!, ...body.map((v) => Math.max(lineH(bodyStyle(x, 14)) + 0.08, v * k))];
        l.height = l.rowH.reduce((a, v) => a + v, 0);
      }
      const { wraps: _w, ...out } = l;
      return out;
    }
  }
  throw new Error("unreachable");
}

const WARN_FG = "#8a4b00";
const toneFg = (tone: DeckTone) => (tone === "warn" ? WARN_FG : TONE[tone].fg);

/** A table at `box` (x, y, w): header from the theme, zebra rows or hairlines, toned cells, in-cell bars. */
function drawTable(x: Ctx, b: Builder, t: DeckTable, box: Box, l: TableLayout): void {
  const tt = x.t.table;
  const cols = Math.max(1, t.header.length);
  const head = headStyle(x);
  const rowRule = tt.zebra ? null : { color: NEUTRAL.rule, weight: 0.75 };
  const align = (i: number): "l" | "r" => (t.numeric[i] ? "r" : "l");
  const padL = (i: number) => (gutterBefore(t.numeric, i) ? { padL: GUTTER } : {});
  const cells: Cell[][] = [
    t.header.map((h, i) => ({ text: h, style: head, align: align(i), fill: null, anchor: "b" as const, bottom: { color: x.col(tt.headerRule.color), weight: tt.headerRule.weight }, ...padL(i) })),
    ...t.rows.map((r, ri) =>
      Array.from({ length: cols }, (_, i) => {
        const tone = t.tones?.[ri]?.[i] ?? null;
        const st = cellStyle(x, t, l.size, i);
        return { text: r[i] ?? "", style: tone ? { ...st, color: toneFg(tone), bold: true } : st, align: align(i), fill: tt.zebra && ri % 2 === 1 ? x.col(tt.zebra) : null, bottom: rowRule, ...padL(i) };
      }),
    ),
  ];
  b.add(tableFrame(b.next(), "Table", box, l.widths, l.rowH, cells));
  if (l.bars && t.bar) {
    // In-cell bars: thin primary-tint bars left of the numbers, as long as the value is against the column's largest.
    const col = t.bar.col;
    const max = Math.max(...t.bar.values);
    const x0 = box.x + l.widths.slice(0, col).reduce((a, v) => a + v, 0) + 0.12;
    const numW = Math.max(...t.rows.map((r) => textWidth(r[col] ?? "", bodyStyle(x, l.size))));
    const room = l.widths[col]! - numW - CELL_PAD - 0.35;
    const color = mix(x.p.primary, "#ffffff", 0.45);
    let y = box.y + l.rowH[0]!;
    t.bar.values.forEach((v, i) => {
      const rh = l.rowH[i + 1]!;
      const bh = Math.min(0.18, rh * 0.3);
      b.add(deco(b, `Bar ${i + 1}`, { x: x0, y: y + (rh - bh) / 2, w: Math.max(0.05, (room * Math.max(0, v)) / max), h: bh }, color));
      y += rh;
    });
  }
}

/** Records: one card per row (a table of one or two rows), each column a field with its label over its value. */
interface RecordLayout {
  widths: number[];
  numSize: number;
  textSize: number;
  labelH: number;
  valueH: number;
  h: number;
}

const recordLabel = (x: Ctx): RunStyle => ({ ...headStyle(x), color: NEUTRAL.muted, size: 12 });

function recordLayout(x: Ctx, t: DeckTable, w: number, maxH: number): RecordLayout {
  const n = t.rows.length;
  const pad = x.t.surface.card ? PAD : 0;
  const inner = w - 2 * pad;
  const label = recordLabel(x);
  const num = (size: number): RunStyle => ({ size, bold: x.t.kpi.valueBold, color: NEUTRAL.ink, font: x.fonts.heading });
  const txt = (size: number): RunStyle => ({ ...bodyStyle(x, size), bold: true });
  const fieldGap = 0.35;
  const need = t.header.map((h, i) => Math.max(textWidth(h, label), ...t.rows.map((r) => (t.numeric[i] ? textWidth(r[i] ?? "", num(36)) : Math.min(3.6, textWidth(r[i] ?? "", txt(22)) + 0.1)))) + fieldGap);
  const sum = need.reduce((a, v) => a + v, 0);
  const widths = need.map((v) => (v * inner) / sum);
  const numSize = Math.max(18, Math.min(36, ...t.rows.flatMap((r) => r.map((c, i) => (t.numeric[i] ? Math.floor((36 * (widths[i]! - fieldGap)) / Math.max(0.01, textWidth(c, num(36)))) : 36)))));
  const textSize = fitSize([22, 20, 18, 16], (s) => t.rows.every((r) => r.every((c, i) => t.numeric[i] || lineCount(c, txt(s), widths[i]! - fieldGap) <= 3)));
  const labelH = Math.max(...t.header.map((h, i) => textH(h, label, widths[i]! - fieldGap)));
  const valueH = Math.max(lineH(num(numSize)), ...t.rows.flatMap((r) => r.map((c, i) => (t.numeric[i] ? 0 : textH(c, txt(textSize), widths[i]! - fieldGap, 1.05)))));
  const content = labelH + 0.15 + valueH + 2 * pad + (pad ? 0 : 0.3);
  // On a card, one record stands alone at about 60% of the height and two share it; under a rule it's as tall as its text.
  const per = !pad ? content : n === 1 ? Math.max(content + 0.4, maxH * 0.6) : Math.max(content + 0.2, (maxH * 0.8 - GAP) / 2);
  const h = Math.min(maxH, n * per + (n - 1) * GAP);
  return { widths, numSize, textSize, labelH, valueH, h };
}

function drawRecords(x: Ctx, b: Builder, t: DeckTable, box: Box, r: RecordLayout): void {
  const n = t.rows.length;
  const per = (r.h - (n - 1) * GAP) / n;
  const label = recordLabel(x);
  const fieldGap = 0.35;
  t.rows.forEach((row, ri) => {
    const card: Box = { x: box.x, y: box.y + ri * (per + GAP), w: box.w, h: per };
    let c = contentCard(x, b, card, `Record ${ri + 1}`);
    if (!x.t.surface.card) {
      const rw = topRule(x, b, card, `Record ${ri + 1} rule`);
      c = { ...card, y: card.y + rw + 0.15, h: card.h - rw - 0.15 };
    }
    const blockH = r.labelH + 0.15 + r.valueH;
    const y = x.t.surface.card ? c.y + Math.max(0, (c.h - blockH) / 2) : c.y + 0.1;
    let fx = c.x;
    row.forEach((v, i) => {
      const fw = r.widths[i]! - fieldGap;
      const tone = t.tones?.[ri]?.[i] ?? null;
      const vs: RunStyle = t.numeric[i] ? { size: r.numSize, bold: x.t.kpi.valueBold, color: NEUTRAL.ink, font: x.fonts.heading } : { ...bodyStyle(x, r.textSize), bold: true };
      const st = tone ? { ...vs, color: toneFg(tone) } : vs;
      b.add(textBox(b, `Record ${ri + 1} label ${i + 1}`, { x: fx, y, w: fw, h: r.labelH }, [line1(t.header[i] ?? "", label)]));
      b.add(textBox(b, `Record ${ri + 1} value ${i + 1}`, { x: fx, y: y + r.labelH + 0.15, w: fw, h: r.valueH }, [line1(v, st, { lineSpacing: 105 })], { autofit: true }));
      fx += r.widths[i]!;
    });
  });
}

/**
 * A one-row table as a record sheet: its text columns as labelled rows (label column, value at 24 pt, a hairline
 * between rows) and its number columns as a band of big numbers under them.
 */
interface SheetLayout {
  textCols: number[];
  numCols: number[];
  rowH: number[];
  textSize: number;
  numSize: number;
  bandH: number;
  h: number;
}

const SHEET_LABEL_W = 2.4;

function sheetLayout(x: Ctx, t: DeckTable, w: number, maxH: number): SheetLayout {
  const pad = x.t.surface.card ? PAD : 0;
  const top = pad ? 0 : 0.15;
  const inner = w - 2 * pad;
  const row = t.rows[0]!;
  const textCols = t.header.map((_, i) => i).filter((i) => !t.numeric[i]);
  const numCols = t.header.map((_, i) => i).filter((i) => t.numeric[i]);
  const valueW = inner - SHEET_LABEL_W;
  const txt = (size: number): RunStyle => ({ ...bodyStyle(x, size), bold: true });
  const textSize = fitSize([28, 24, 22, 20], (sz) => textCols.every((i) => lineCount(row[i] ?? "", txt(sz), valueW) <= 2));
  const rowH = textCols.map((i) => Math.max(0.8, textH(row[i] ?? "", txt(textSize), valueW, 1.05) + 0.4));
  const num = (size: number): RunStyle => ({ size, bold: x.t.kpi.valueBold, color: NEUTRAL.ink, font: x.fonts.heading });
  const colW = numCols.length ? inner / numCols.length : 0;
  const numSize = numCols.length ? Math.max(24, Math.min(x.t.kpi.valueSize, 60, ...numCols.map((i) => Math.floor((60 * (colW - 0.4)) / Math.max(0.01, textWidth(row[i] ?? "", num(60))))))) : 0;
  const bandH = numCols.length ? 0.3 + lineH(recordLabel(x)) + 0.1 + lineH(num(numSize)) : 0;
  const content = top + rowH.reduce((a, v) => a + v, 0) + (numCols.length ? (textCols.length ? 0.35 : 0) + bandH : 0) + 2 * pad;
  return { textCols, numCols, rowH, textSize, numSize, bandH, h: Math.min(maxH, Math.max(content, pad ? Math.min(maxH, content + 0.4) : content)) };
}

function drawSheet(x: Ctx, b: Builder, t: DeckTable, box: Box, r: SheetLayout): void {
  const row = t.rows[0]!;
  let c = contentCard(x, b, box, "Record 1");
  if (!x.t.surface.card) {
    const rw = topRule(x, b, box, "Record 1 rule");
    c = { ...box, y: box.y + rw + 0.15, h: box.h - rw - 0.15 };
  }
  const label = recordLabel(x);
  const bg = surfaceBg(x);
  const tone = (i: number) => t.tones?.[0]?.[i] ?? null;
  let y = c.y;
  r.textCols.forEach((i, k) => {
    const h = r.rowH[k]!;
    if (k) b.add(bar(b, `Record 1 rule ${k}`, { x: c.x, y, w: c.w, h: RULE }, ruleOn(bg)));
    const vs: RunStyle = { ...bodyStyle(x, r.textSize), bold: true, ...(tone(i) ? { color: toneFg(tone(i)!) } : {}) };
    b.add(textBox(b, `Record 1 label ${i + 1}`, { x: c.x, y, w: SHEET_LABEL_W - 0.2, h }, [line1(t.header[i] ?? "", label)], { anchor: "ctr" }));
    b.add(textBox(b, `Record 1 value ${i + 1}`, { x: c.x + SHEET_LABEL_W, y, w: c.w - SHEET_LABEL_W, h }, [line1(row[i] ?? "", vs, { lineSpacing: 105 })], { anchor: "ctr", autofit: true }));
    y += h;
  });
  if (!r.numCols.length) return;
  if (r.textCols.length) {
    b.add(bar(b, "Record 1 band rule", { x: c.x, y: y + 0.15, w: c.w, h: RULE }, ruleOn(bg)));
    y += 0.35;
  }
  const colW = c.w / r.numCols.length;
  r.numCols.forEach((i, k) => {
    const fx = c.x + k * colW;
    const vs: RunStyle = { size: r.numSize, bold: x.t.kpi.valueBold, color: tone(i) ? toneFg(tone(i)!) : x.col(x.t.kpi.valueColor), font: x.fonts.heading };
    b.add(textBox(b, `Record 1 label ${i + 1}`, { x: fx, y: y + 0.3, w: colW - 0.3, h: lineH(label) }, [line1(t.header[i] ?? "", label)]));
    b.add(textBox(b, `Record 1 value ${i + 1}`, { x: fx, y: y + 0.4 + lineH(label), w: colW - 0.3, h: lineH(vs) }, [line1(row[i] ?? "", vs)], { wrap: false }));
  });
}

/** A measured table block: records (one or two rows) or a table, in its card, with the truncation note under it. */
interface TableBlockPlan {
  h: number;
  draw: (b: Builder, at: Box) => void;
}

const NOTE_H = 0.32;

function planTable(x: Ctx, t: DeckTable, w: number, maxH: number, o: { note?: string; records?: boolean; bars?: boolean; maxStep?: number } = {}): TableBlockPlan {
  const pad = cardPad(x);
  const noteH = o.note ? NOTE_H : 0;
  const room = maxH - noteH;
  const note = (b: Builder, at: Box, h: number) => {
    if (!o.note) return;
    const st: RunStyle = { size: 11, color: NEUTRAL.faint, font: x.fonts.body };
    b.add(textBox(b, "Table note", { x: at.x, y: at.y + h + 0.08, w: at.w, h: NOTE_H - 0.08 }, [line1(o.note, st)], { anchor: "t" }));
  };
  if (o.records && t.rows.length === 1) {
    const r = sheetLayout(x, t, w, room);
    return { h: r.h + noteH, draw: (b, at) => (drawSheet(x, b, t, { ...at, h: r.h }, r), note(b, at, r.h)) };
  }
  if (o.records && t.rows.length === 2) {
    const r = recordLayout(x, t, w, room);
    return { h: r.h + noteH, draw: (b, at) => (drawRecords(x, b, t, { ...at, h: r.h }, r), note(b, at, r.h)) };
  }
  const opts = { bars: o.bars ?? true, ...(o.maxStep !== undefined ? { maxStep: o.maxStep } : {}) };
  let l = tableLayout(x, t, w - 2 * pad, room - 2 * pad, opts);
  if (l.height > room - 2 * pad + 1e-6 && t.rows.length > 1) {
    // Too tall even at 14 pt with tight rows: show fewer rows (never smaller type) and say so under the table.
    let n = t.rows.length;
    let fewer: DeckTable = t;
    while (n > 1 && l.height > room - 2 * pad - (o.note ? 0 : NOTE_H) + 1e-6) {
      n--;
      fewer = { ...t, rows: t.rows.slice(0, n), shown: n, ...(t.tones ? { tones: t.tones.slice(0, n) } : {}), ...(t.bar ? { bar: { ...t.bar, values: t.bar.values.slice(0, n) } } : {}) };
      l = tableLayout(x, fewer, w - 2 * pad, room - 2 * pad, opts);
    }
    return planTable(x, fewer, w, maxH, { ...o, note: `Top ${n} of ${t.total} rows; the full table is in the report.` });
  }
  const h = l.height + 2 * pad;
  return {
    h: h + noteH,
    draw: (b, at) => {
      const c = contentCard(x, b, { ...at, h }, "Table card");
      drawTable(x, b, t, { ...c, h: l.height }, l);
      note(b, at, h);
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Charts

/** The chart's caption row inside its panel: the title on the left (16 pt bold), the legend on the right (12 pt). */
const CAPTION_H = 0.42;

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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Exported for tests. A chart value as its value axis shows it: whole thousands as "k" from 10,000 and whole
 * millions as "M" (the axis's #,##0,"k" / #,##0,,"M"), else grouped digits with decimals only when needed.
 */
export function axisNumber(v: number, format: "count" | "ms" | "score" | "position"): string {
  const a = Math.abs(v);
  const group = (n: number, d = 0) => n.toLocaleString("en-US", { minimumFractionDigits: 0, maximumFractionDigits: d });
  if (a >= 1_000_000) return `${group(Math.round(v / 1_000_000))}M`;
  if (a >= 10_000) return `${group(Math.round(v / 1_000))}k`;
  return group(v, format === "position" ? 1 : Number.isInteger(v) ? 0 : 2);
}

/**
 * Exported for tests. The latest value of a line chart's current series (or its only series) and its day: Keynote
 * and Quick Look drop a per-point data label, so the caption row says it ("Latest: 48 (30 Sep)").
 */
export function latestLabel(c: Chart): string | null {
  if (c.type !== "line") return null;
  const s = c.series.find((v) => v.role === "current") ?? (c.series.length === 1 ? c.series[0] : undefined);
  if (!s) return null;
  for (let i = s.values.length - 1; i >= 0; i--) {
    const v = s.values[i];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    const iso = c.x[i] ?? "";
    const m = /^\d{4}-(\d{2})-(\d{2})/.exec(iso);
    const day = m ? `${Number(m[2])} ${MONTHS[Number(m[1]) - 1]}` : iso;
    const unit = c.format === "ms" ? " ms" : "";
    return `Latest: ${axisNumber(v, c.format)}${unit}${day ? ` (${day})` : ""}`;
  }
  return null;
}

function chartCaption(x: Ctx, b: Builder, c: Chart, box: Box): void {
  const cs: RunStyle = { size: 16, bold: true, italic: x.id === "editorial", color: NEUTRAL.ink, font: x.fonts.body };
  const ls: RunStyle = { size: 12, italic: x.id === "editorial", color: NEUTRAL.muted, font: x.fonts.body };
  const entries = legendEntries(c, x.p.primary);
  const latest = latestLabel(c);
  const lt: RunStyle = { ...ls, size: 13, bold: true, color: accentOn(x, surfaceBg(x)) };
  const sep = "     ";
  const runs = [...(latest ? [run(latest, lt)] : []), ...entries.flatMap((e, i) => [run(`${i || latest ? sep : ""}${e.mark} `, { ...ls, bold: true, italic: false, color: e.color }), run(e.name, ls)])];
  const legendText = [...(latest ? [latest] : []), ...entries.map((e) => `${e.mark} ${e.name}`)].join(sep);
  const legendW = runs.length ? Math.min(box.w * 0.66, textWidth(legendText, lt) + 0.6) : 0;
  b.add(shape({ id: b.next(), name: "Chart caption", box: { ...box, w: box.w - legendW, h: CAPTION_H }, text: txBody([para([run(c.title, cs)], cs)], { anchor: "t", inset: [0, 0.02, 0, 0] }) }));
  if (runs.length) b.add(shape({ id: b.next(), name: "Chart legend", box: { x: box.x + box.w - legendW, y: box.y, w: legendW, h: CAPTION_H }, text: txBody([para(runs, ls, { align: "r" })], { anchor: "t", inset: [0, 0.02, 0, 0] }) }));
}

// ---------------------------------------------------------------------------------------------------------------
// Logo

function logoBox(env: SlideEnv, box: Box, align: "r" | "ctr" = "r"): Box | null {
  if (!env.logo) return null;
  const px = imageSize(env.logo.data);
  if (!px) return null;
  // Scaled to the box (up or down), keeping the aspect ratio: a small logo still reads on a 13-inch slide.
  const k = Math.min(box.w / px.width, box.h / px.height);
  const w = Math.round(px.width * k * 1000) / 1000;
  const h = Math.round(px.height * k * 1000) / 1000;
  return { x: align === "r" ? box.x + box.w - w : box.x + (box.w - w) / 2, y: box.y, w, h };
}

/** The logo; on a filled cover it sits on a white rounded card so any logo reads. */
function logo(x: Ctx, b: Builder, env: SlideEnv, box: Box, descr: string, align: "r" | "ctr" = "r"): boolean {
  const at = logoBox(env, box, align);
  if (!at || !env.logo) return false;
  if (coverFill(x)) b.add(deco(b, "Logo card", { x: at.x - 0.2, y: at.y - 0.15, w: at.w + 0.4, h: at.h + 0.3 }, "#ffffff", { radius: 0.12 }));
  const rId = b.rels.add(REL.image, LOGO_TARGET(env.logo.mime));
  b.add(picture(b.next(), "Logo", descr, rId, at));
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
    sub: { size: 22, italic: x.id === "editorial", color: onFill ? x.col("onFillSoft") : NEUTRAL.muted, font: x.fonts.body } satisfies RunStyle,
    label: { size: 11, caps: true, color: onFill ? x.col("onFillSoft") : NEUTRAL.muted, font: x.fonts.body, spacing: 0.8 } satisfies RunStyle,
    value: { size: 16, bold: true, color: onFill ? x.col("onFill") : NEUTRAL.ink, font: x.fonts.body } satisfies RunStyle,
  };
}

/** The first letter or digit of a name, upper-cased (minimal's and editorial's cover monogram). */
const initial = (s: string) => /[\p{L}\p{N}]/u.exec(s)?.[0]?.toUpperCase() ?? "";

/** The cover's right region: each theme's element, so the half right of the text is never empty. */
function coverElement(x: Ctx, b: Builder, s: Of<"title">, hasLogo: boolean): void {
  const r = coverGeometry(x).right;
  const top = hasLogo ? 2.3 : 1.4;
  switch (x.id) {
    case "cards": {
      // Three cards in a slightly lighter (or darker) shade of the cover, each with a short accent bar.
      const tone = mix(x.p.primary, x.p.onPrimary, 0.1);
      const cardsAt: Box[] = [
        { x: r.x, y: top, w: r.w, h: 1.9 },
        { x: r.x, y: top + 2.15, w: (r.w - GAP) / 2, h: 1.45 },
        { x: r.x + (r.w + GAP) / 2, y: top + 2.15, w: (r.w - GAP) / 2, h: 1.45 },
      ];
      cardsAt.forEach((c, i) => {
        b.add(deco(b, `Cover card ${i + 1}`, c, tone, { radius: 0.12 }));
        b.add(deco(b, `Cover card ${i + 1} bar`, { x: c.x + PAD, y: c.y + PAD, w: 0.5, h: 0.06 }, x.p.accent));
      });
      break;
    }
    case "friendly": {
      b.add(deco(b, "Cover circle 1", { x: 9.15, y: top - 0.2, w: 3.4, h: 3.4 }, mix(x.p.primary, x.p.onPrimary, 0.12), { radius: 1.7 }));
      b.add(deco(b, "Cover circle 2", { x: 10.45, y: top + 2.6, w: 2.0, h: 2.0 }, mix(x.p.primary, x.p.onPrimary, 0.22), { radius: 1.7 }));
      break;
    }
    case "bold":
      b.add(deco(b, "Cover block", { x: 9.55, y: 0, w: SLIDE.w - 9.55, h: SLIDE.h }, x.p.primary));
      break;
    case "consulting":
      b.add(deco(b, "Cover block", { x: 9.1, y: 0, w: SLIDE.w - 9.1, h: SLIDE.h }, "#F6F7F9"));
      break;
    case "minimal":
    case "editorial": {
      const letter = initial(s.title);
      if (!letter) break;
      const st: RunStyle = { size: 300, color: x.id === "minimal" ? "#EEF1F4" : mix(x.p.primary, "#ffffff", 0.85), font: x.fonts.heading };
      b.add(textBox(b, "Monogram", { x: r.x, y: top - 0.6, w: r.w, h: 5.0 }, [line1(letter, st, { align: "r" })], { anchor: "ctr", wrap: false }));
      break;
    }
  }
}

function titleSlide(x: Ctx, s: Of<"title">, env: SlideEnv): BuiltSlide {
  const b = new Builder(1);
  const g = coverGeometry(x);
  const c = coverText(x);
  const willLogo = s.logo && !!env.logo && !!imageSize(env.logo.data);
  const meta = s.entries.slice(0, 8);
  const metaInBlock = x.id === "consulting";
  const metaRows = metaInBlock || !meta.length ? 0 : Math.ceil(meta.length / 4);
  const metaTop = metaRows ? g.metaY - (metaRows - 1) * 0.75 : SLIDE.h - 0.8;

  // The text group: kicker, title (60 → 44 pt to stay within two lines), subtitle (80 characters), domain line.
  const ts: RunStyle = { ...c.title, size: fitSize([c.title.size, 54, 50, 48, 44].filter((v) => v <= c.title.size), (v) => lineCount(s.title, { ...c.title, size: v }, g.width) <= 2) };
  const titleH = textH(s.title, ts, g.width, 1.0) + 0.1;
  const sub = s.subtitle ? cut(s.subtitle, 80) : "";
  const subH = sub ? textH(sub, c.sub, g.width) + 0.05 : 0;
  const line = [s.domain, s.badge].filter((v): v is string => !!v).join("  ·  ");
  const ls: RunStyle = { ...c.sub, size: 14, italic: false };
  const groupH = 0.3 + 0.25 + titleH + (subH ? 0.15 + subH : 0) + (line ? 0.2 + 0.3 : 0);
  const regionTop = 0.8;
  const regionBottom = metaTop - 0.45;
  const top = regionTop + Math.max(0, (regionBottom - regionTop - groupH) / 2);
  let y = top + 0.55;
  // The title first (reading order), then the kicker above it; the theme element sits right of the text.
  b.add(shape({ id: b.next(), name: "Title", box: { x: g.left, y, w: g.width, h: titleH }, ph: { type: "ctrTitle" }, text: txBody([line1(s.title, ts, { lineSpacing: 95 })], { anchor: "t", autofit: true, inset: [0, 0, 0, 0] }) }));
  if (s.kicker) b.add(textBox(b, "Kicker", { x: g.left, y: top, w: g.width, h: 0.3 }, [line1(s.kicker, c.kicker)], { anchor: "b", ph: { type: "subTitle", idx: PH.body } }));
  y += titleH;
  if (sub) {
    y += 0.15;
    b.add(textBox(b, "Subtitle", { x: g.left, y, w: g.width, h: subH }, [line1(sub, c.sub)], { autofit: true }));
    y += subH;
  }
  if (line) b.add(textBox(b, "Domain", { x: g.left, y: y + 0.2, w: g.width, h: 0.3 }, [line1(line, ls)]));
  coverElement(x, b, s, willLogo);

  if (metaInBlock) {
    // Consulting: the details stacked in the grey block on the right.
    const bx = 9.55;
    let my = willLogo ? 2.4 : 1.4;
    meta.forEach((e, i) => {
      b.add(textBox(b, `Cover field ${i + 1}`, { x: bx, y: my, w: SLIDE.w - bx - 0.5, h: 0.7 }, [line1(e.label, c.label), line1(e.value, c.value, { before: 3 })], { autofit: true }));
      my += 0.85;
    });
  } else if (meta.length) {
    // Fields as wide as their text (a chip adds its padding), 0.45 in apart; four to a row.
    const chips = x.t.title.panel === "rounded";
    const per = Math.min(4, meta.length);
    const avail = SLIDE.w - g.left - (chips ? 1.1 : 0.9);
    const want = meta.map((e) => Math.max(textWidth(e.label, c.label), textWidth(e.value, c.value)) + (chips ? 0.6 : 0.1));
    let fx = g.left;
    meta.forEach((e, i) => {
      if (i % per === 0) fx = g.left;
      const rowWant = want.slice(i - (i % per), i - (i % per) + per);
      const k = Math.min(1, (avail - 0.45 * (rowWant.length - 1)) / rowWant.reduce((a, v) => a + v, 0));
      const w = want[i]! * k;
      const box: Box = { x: fx, y: metaTop + Math.floor(i / per) * 0.75, w, h: 0.62 };
      fx += w + (chips ? 0.2 : 0.45);
      if (chips) {
        // Friendly: each field in a pill chip (as in the mockup).
        b.add(deco(b, `Cover chip ${i + 1}`, box, x.p.chipBg, { radius: 0.31 }));
        b.add(textBox(b, `Cover field ${i + 1}`, { x: box.x + 0.28, y: box.y + 0.06, w: w - 0.4, h: box.h - 0.12 }, [line1(e.label, { ...c.label, color: x.p.onChipSoft }), line1(e.value, c.value, { before: 1 })], { anchor: "ctr", wrap: false }));
      } else b.add(textBox(b, `Cover field ${i + 1}`, box, [line1(e.label, c.label), line1(e.value, c.value, { before: 3 })], { wrap: k >= 1 ? false : true, autofit: k < 1 }));
    });
  }
  if (s.agencyName) {
    const onBlock = x.id === "bold" ? x.p.onPrimary : x.id === "cards" || x.id === "friendly" ? x.col("onFill") : NEUTRAL.ink;
    const st: RunStyle = { size: 14, bold: true, color: onBlock, font: x.fonts.body };
    const at: Box = x.id === "consulting" ? { x: 9.55, y: 6.35, w: SLIDE.w - 9.55 - 0.5, h: 0.35 } : { x: g.right.x, y: 6.35, w: g.right.w - (x.t.title.panel === "rounded" ? 0.3 : 0), h: 0.35 };
    b.add(textBox(b, "Agency", at, [line1(s.agencyName, st, { align: x.id === "consulting" ? "l" : "r" })], { anchor: "b", autofit: true }));
  }
  const logoAt = x.id === "consulting" ? { x: 9.55, y: 0.85, w: 2.4, h: 1.0 } : { ...g.logo, x: g.logo.x - (x.t.title.panel === "rounded" ? 0.3 : 0) };
  const hasLogo = s.logo && logo(x, b, env, logoAt, s.agencyName || "Logo", "r");
  return { xml: b.xml(), rels: b.rels, logo: hasLogo };
}

/** The closing: a centred group (logo, "Thank you", agency, contact lines in a row) in the cover's frame. */
function closingSlide(x: Ctx, s: Of<"closing">, env: SlideEnv): BuiltSlide {
  const b = new Builder(1);
  const c = coverText(x);
  const left = x.t.title.strip?.side === "left" ? x.t.title.strip.size : 0;
  const cx = left + (SLIDE.w - left) / 2;
  const w = Math.min(10.5, SLIDE.w - left - 1.8);
  const lx = cx - w / 2;
  const ts: RunStyle = { ...c.title, size: Math.max(54, c.title.size) };
  const lineSt: RunStyle = { ...c.sub, size: 16, italic: false };
  const rowW = s.lines.reduce((a, l) => a + textWidth(l, lineSt), 0) + 0.5 * Math.max(0, s.lines.length - 1);
  const inRow = rowW <= w;
  const linesH = s.lines.length ? (inRow ? 0.35 : s.lines.length * 0.35) : 0;
  const lb = logoBox(env, { x: lx, y: 0, w, h: 1.0 }, "ctr");
  const showLogo = s.logo && !!lb;
  const groupH = (showLogo ? lb!.h + 0.5 : 0) + lineH(ts) + (s.agencyName ? 0.2 + 0.32 : 0) + (linesH ? 0.3 + linesH : 0);
  const logoY = (SLIDE.h - groupH) / 2;
  let y = logoY + (showLogo ? lb!.h + 0.5 : 0);
  b.add(shape({ id: b.next(), name: "Title", box: { x: lx, y, w, h: lineH(ts) }, ph: { type: "ctrTitle" }, text: txBody([line1(s.title, ts, { align: "ctr" })], { anchor: "ctr", autofit: true, inset: [0, 0, 0, 0] }) }));
  y += lineH(ts);
  if (s.agencyName) {
    b.add(textBox(b, "Agency", { x: lx, y: y + 0.2, w, h: 0.32 }, [line1(s.agencyName, { ...c.kicker, size: 16 }, { align: "ctr" })], { anchor: "ctr", ph: { type: "subTitle", idx: PH.body } }));
    y += 0.52;
  }
  if (s.lines.length) {
    y += 0.3;
    const paras = inRow ? [para(s.lines.flatMap((l, i) => [...(i ? [run("      ", lineSt)] : []), run(l, lineSt)]), lineSt, { align: "ctr" })] : s.lines.map((l) => line1(l, lineSt, { align: "ctr" }));
    b.add(textBox(b, "Lines", { x: lx, y, w, h: linesH }, paras, { anchor: "t", autofit: true }));
  }
  const hasLogo = showLogo && logo(x, b, env, { x: lx, y: logoY, w, h: 1.0 }, s.agencyName || "Logo", "ctr");
  return { xml: b.xml(), rels: b.rels, logo: hasLogo, notes: s.notes };
}

function bodySlide(x: Ctx, title: string, number?: number, continued = false): Builder {
  const b = new Builder(2);
  b.add(titleShape(x, b, title, number, continued));
  return b;
}

/**
 * The agenda. Up to six items: a grid of numbered blocks (3 × 2, or 2 × 2 for four) with the section's takeaway as
 * a one-line description. Seven to twelve: two columns with the rows spread over the full height; more: three.
 */
function agendaSlide(x: Ctx, s: Of<"agenda">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  edgeBlock(x, b);
  const A = contentArea(false);
  const n = s.items.length;
  const bg = surfaceBg(x);
  if (n <= AGENDA_GRID_MAX) {
    const cols = n === 4 ? 2 : Math.min(3, n);
    const rows = Math.ceil(n / cols);
    const w = (A.w - (cols - 1) * GAP) / cols;
    const h = rows === 1 ? Math.min(A.h, 3.4) : (A.h - GAP) / 2;
    const top = centred(A, rows * h + (rows - 1) * GAP);
    const ns: RunStyle = { size: 40, bold: x.id !== "minimal", color: accentOn(x, bg), font: x.fonts.heading };
    const is: RunStyle = { ...bodyStyle(x, 20), bold: true };
    const ds: RunStyle = { size: 14, color: NEUTRAL.muted, italic: x.id === "editorial", font: x.fonts.body };
    s.items.forEach((item, i) => {
      const box: Box = { x: A.x + (i % cols) * (w + GAP), y: top + Math.floor(i / cols) * (h + GAP), w, h };
      let c = contentCard(x, b, box, `Agenda block ${i + 1}`);
      if (!x.t.surface.card) {
        const r = topRule(x, b, box, `Agenda block ${i + 1} rule`);
        c = { ...box, y: box.y + r + 0.2, h: box.h - r - 0.2 };
      }
      b.add(textBox(b, `Agenda number ${i + 1}`, { ...c, h: 0.7 }, [line1(String(i + 1).padStart(2, "0"), ns)]));
      const detail = s.details?.[i] ?? "";
      const itemH = textH(item, is, c.w) + 0.05;
      b.add(textBox(b, `Agenda item ${i + 1}`, { ...c, y: c.y + 0.85, h: itemH }, [line1(item, is)], { autofit: true }));
      if (detail) b.add(textBox(b, `Agenda detail ${i + 1}`, { ...c, y: c.y + 0.85 + itemH + 0.1, h: Math.max(0.3, c.h - 0.95 - itemH) }, [line1(detail, ds, { lineSpacing: 105 })], { autofit: true }));
    });
  } else {
    const colsN = n > 12 ? 3 : 2;
    const per = Math.ceil(n / colsN);
    const size = colsN === 3 ? 18 : 20;
    const ns: RunStyle = { size: colsN === 3 ? 24 : 28, bold: true, color: accentOn(x, x.col(x.t.background)), font: x.fonts.heading };
    const st = bodyStyle(x, size);
    const tab = agendaTab(ns);
    const colW = (A.w - (colsN - 1) * 0.5) / colsN;
    const rowH = A.h / per;
    for (let col = 0; col < colsN; col++) {
      const cx = A.x + col * (colW + 0.5);
      s.items.slice(col * per, (col + 1) * per).forEach((t, i) => {
        const y = A.y + i * rowH;
        if (i) b.add(bar(b, `Agenda rule ${col + 1}.${i}`, { x: cx, y, w: colW, h: RULE }, ruleOn(x.col(x.t.background))));
        b.add(textBox(b, `Agenda ${col * per + i + 1}`, { x: cx, y: y + 0.04, w: colW, h: rowH - 0.08 }, [numberedPara(String(col * per + i + 1).padStart(2, "0"), t, ns, st, tab)], { anchor: "ctr", autofit: true }));
      });
    }
  }
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

/** The verdict banner: one sentence of the report's own text on the theme's callout (dark in bold, a label column in consulting). */
function bannerHeight(x: Ctx, text: string, w: number): number {
  const st = bodyStyle(x, 18);
  const room = w - 2 * PAD - (x.t.surface.labelColumn ? 2.25 : 0) - (x.t.callout.left ? 0.1 : 0);
  return Math.max(0.95, textH(text, st, room, 1.1) + 2 * PAD);
}

function banner(x: Ctx, b: Builder, box: Box, text: string): void {
  const bold = x.id === "bold";
  let inner: Box;
  let bg: string;
  if (bold) {
    bg = x.p.dark;
    b.add(deco(b, "Banner", box, bg));
    b.add(bar(b, "Banner rule", { x: box.x, y: box.y, w: 4 / 72, h: box.h }, x.p.primary));
    inner = inset(box, PAD);
  } else {
    const p = calloutPanel(x, b, box, "Banner");
    inner = p.inner;
    bg = p.bg;
  }
  const st: RunStyle = { ...bodyStyle(x, 18), italic: x.id === "editorial", ...(bold ? { color: x.p.onDark, bold: true } : {}) };
  if (x.t.surface.labelColumn) {
    b.add(textBox(b, "Banner label", { x: inner.x, y: inner.y, w: 1.9, h: inner.h }, [line1("Summary", labelStyle(x, bg))], { anchor: "ctr" }));
    inner = { ...inner, x: inner.x + 2.25, w: inner.w - 2.25 };
  }
  b.add(textBox(b, "Banner text", inner, [line1(text, st, { lineSpacing: 110 })], { anchor: "ctr", autofit: true }));
}

function kpiSlide(x: Ctx, s: Of<"kpis">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  edgeBlock(x, b);
  sourceLine(x, b, s.caption ? [s.caption] : []);
  const A = contentArea(false);
  const kpis = s.kpis.slice(0, 8);
  const bh = s.takeaway ? bannerHeight(x, s.takeaway, A.w) : 0;
  if (kpis.length === 1) {
    // One number: a big-number slide (P10).
    const h = Math.min(3.6, A.h - (bh ? bh + 0.4 : 0));
    const y = centred(A, h + (bh ? bh + 0.4 : 0));
    kpiCards(x, b, kpis, { x: A.x + (A.w - 6) / 2, y, w: 6, h }, 1, "hero", 96);
    if (s.takeaway) banner(x, b, { ...A, y: y + h + 0.4, h: bh }, s.takeaway);
  } else {
    const cols = Math.min(4, kpis.length);
    const rows = Math.ceil(kpis.length / cols);
    const band = Math.min(rows === 1 ? 3.6 : 4.6, A.h - (bh ? bh + 0.4 : 0));
    const y = centred(A, band + (bh ? bh + 0.4 : 0));
    kpiCards(x, b, kpis, { ...A, y, h: band }, cols, rows === 1 ? "hero" : "row", rows === 1 ? x.t.kpi.valueSize : 48);
    if (s.takeaway) banner(x, b, { ...A, y: y + band + 0.4, h: bh }, s.takeaway);
  }
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false };
}

/** Bullets as the slide's main block: insight cards (summary, up to three), a serif lead (editorial), or numbered rows. */
function textBlock(x: Ctx, b: Builder, area: Box, items: string[], o: { cards: boolean; label: string }): void {
  if (!items.length) return;
  if (x.t.surface.lead && (items.length <= 5 || o.cards)) return editorialLead(x, b, area, items);
  if (o.cards && items.length <= 3 && !x.t.surface.labelColumn) return insightCards(x, b, area, items);
  if (items.length <= 5) return insightRows(x, b, area, items, items.length <= 4 ? [24, 22, 20, 18] : [22, 20, 18], o.label);
  // Six to eight: two columns of numbered rows.
  const half = Math.ceil(items.length / 2);
  const h = Math.min(area.h, half * 1.2);
  const box = labelColumn(x, b, { ...area, y: centred(area, h), h }, o.label);
  const colW = (box.w - 0.5) / 2;
  const bg = x.col(x.t.background);
  spreadItems(x, b, { ...box, w: colW }, items.slice(0, half), { sizes: [20, 18], bg, name: "Item", numbered: true });
  spreadItems(x, b, { ...box, x: box.x + colW + 0.5, w: colW }, items.slice(half), { sizes: [20, 18], bg, name: "Item b", numbered: true, start: half + 1 });
}

function summarySlide(x: Ctx, s: Of<"summary">, env: SlideEnv): BuiltSlide {
  const b = bodySlide(x, s.title);
  sourceLine(x, b, s.caption ? [s.caption] : []);
  textBlock(x, b, contentArea(false), s.bullets, { cards: true, label: "Key points" });
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
}

function textSlide(x: Ctx, s: Of<"text">, env: SlideEnv): BuiltSlide {
  // Text slides carry no section number in the contract; use one if the deck model adds it.
  const number = (s as { number?: number }).number;
  const b = bodySlide(x, s.title, number, s.continued);
  textBlock(x, b, contentArea(false), s.bullets, { cards: false, label: "Key points" });
  footer(x, b, env.number);
  return { xml: b.xml(), rels: b.rels, logo: false, notes: s.notes };
}

/** The tile row above a chart or table: 1.5 in by default, taller when the block under it is short. */
const TILE_ROW = { min: 1.5, max: 2.4 } as const;
const isTableNote = (n: string) => /^Top \d+ of \d+ rows/.test(n);

/** The P-C4 section layouts with the brief's recipes (chart + side column, KPI row + chart, chart over table, table + side, records, tiles, text). */
function sectionSlide(x: Ctx, s: Of<"section">, env: SlideEnv): BuiltSlide & { chartFailed: boolean } {
  const b = bodySlide(x, s.title, s.number, s.continued);
  if (s.takeaway) takeawayLine(x, b, s.takeaway);
  const notes = [...s.footnotes];
  let chart: BuiltSlide["chart"];
  let chartFailed = false;
  let fallback: DeckTable | undefined;
  if (s.chart && env.chart === null) {
    chartFailed = true;
    if (s.chart.fallback) fallback = fallbackTable(s.chart.fallback, s.table ? DECK.maxTableRowsUnderChart : DECK.maxTableRows);
    if (!notes.includes(MORE_DETAIL)) notes.push(MORE_DETAIL);
  }
  const tableNote = notes.find(isTableNote);
  sourceLine(x, b, notes.filter((n) => !isTableNote(n)));
  const A = contentArea(!!s.takeaway, s.takeaway ? takeawayLines(x, s.takeaway) : 1);
  const tiles = (s.tiles ?? []).slice(0, 8);
  const bullets = s.bullets;
  const mainW = SLIDE.mainW;
  const side = (y: number, h: number) => sideColumn(x, b, { x: SLIDE.sideX, y, w: SLIDE.sideW, h }, bullets);

  const drawChart = (box: Box) => {
    if (s.chart && env.chart) {
      const c = contentCard(x, b, box, "Chart card");
      chartCaption(x, b, s.chart, c);
      const rId = b.rels.add(REL.chart, `../charts/chart${env.chartNo}.xml`);
      b.add(chartFrame(b.next(), "Chart", s.chart.summary || s.chart.title, rId, { ...c, y: c.y + CAPTION_H, h: c.h - CAPTION_H }));
      chart = { no: env.chartNo, part: env.chart };
    } else if (fallback) planTable(x, fallback, box.w, box.h, { bars: false }).draw(b, box);
  };

  if (s.chart) {
    let rest = A;
    if (tiles.length) {
      // KPI tiles + chart: the tiles in a row on top, the chart (and commentary) below.
      kpiCards(x, b, tiles.slice(0, 4), { ...A, h: TILE_ROW.min }, Math.min(4, tiles.length), "row", 40);
      rest = { ...A, y: A.y + TILE_ROW.min + GAP, h: A.h - TILE_ROW.min - GAP };
    }
    if (bullets.length) {
      drawChart({ ...rest, w: mainW });
      side(rest.y, rest.h);
    } else if (s.table && s.table.header.length <= 3 && !tiles.length) {
      // A narrow table goes in the side column, top-aligned with the chart.
      drawChart({ ...rest, w: mainW });
      planTable(x, s.table, SLIDE.sideW, rest.h, { maxStep: 0, bars: false, ...(tableNote ? { note: tableNote } : {}) }).draw(b, { x: SLIDE.sideX, y: rest.y, w: SLIDE.sideW, h: rest.h });
    } else if (s.table) {
      // Chart over table: the table takes what it needs (the chart keeps at least 2 in), the chart the rest.
      const plan = planTable(x, s.table, rest.w, Math.max(1.4, rest.h - 2.0 - GAP), { bars: false, maxStep: 1, ...(tableNote ? { note: tableNote } : {}) });
      const ch = rest.h - plan.h - GAP;
      drawChart({ ...rest, h: ch });
      plan.draw(b, { ...rest, y: rest.y + ch + GAP, h: plan.h });
    } else drawChart(rest);
  } else if (s.table) {
    const t = s.table;
    let area = A;
    const mainBox = (a: Box) => (bullets.length ? { ...a, w: mainW } : a);
    if (tiles.length) {
      // Tiles over the table: the row grows (up to 2.4 in) when the table under it is short.
      const probe = planTable(x, t, mainBox(A).w, A.h - TILE_ROW.min - GAP, { records: true, ...(tableNote ? { note: tableNote } : {}) });
      const rowH = Math.max(TILE_ROW.min, Math.min(TILE_ROW.max, A.h * 0.9 - probe.h - GAP));
      kpiCards(x, b, tiles.slice(0, 4), { ...A, h: rowH }, Math.min(4, tiles.length), "row", rowH > 2 ? 54 : 40);
      area = { ...A, y: A.y + rowH + GAP, h: A.h - rowH - GAP };
    }
    const box = mainBox(area);
    const plan = planTable(x, t, box.w, area.h, { records: true, ...(tableNote ? { note: tableNote } : {}) });
    const h = bullets.length ? Math.max(plan.h, Math.min(area.h, 3.2)) : plan.h;
    const y = tiles.length ? area.y : centred(area, h);
    plan.draw(b, { ...box, y, h: plan.h });
    if (bullets.length) side(y, h);
  } else if (tiles.length) {
    const cols = tiles.length <= 4 ? tiles.length : tiles.length <= 6 ? 3 : 4;
    const rows = Math.ceil(tiles.length / cols);
    const listH = bullets.length ? Math.min(A.h * 0.4, bullets.length * 0.75 + 0.5) : 0;
    const gridH = Math.min(A.h - (listH ? listH + 0.4 : 0), rows * 3.0 + (rows - 1) * GAP);
    const y = centred(A, gridH + (listH ? listH + 0.4 : 0));
    kpiCards(x, b, tiles, { ...A, y, h: gridH }, cols, rows === 1 && gridH >= 2.6 ? "hero" : "row", rows === 1 ? x.t.kpi.valueSize : 44);
    if (bullets.length) {
      const list = { ...A, y: y + gridH + 0.4, h: listH };
      const { inner, bg } = calloutPanel(x, b, list, "Commentary panel");
      spreadItems(x, b, inner, bullets, { sizes: [20, 18, 16], bg, name: "Item" });
    }
  } else textBlock(x, b, A, bullets, { cards: false, label: "Commentary" });

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
