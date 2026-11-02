/**
 * The deck's design parts: the Office theme (colours and fonts), one slide master built for the report theme, its
 * two layouts (Title, Body) and the notes master. Everything visual that repeats on every body slide (the cards
 * bar, the rules under or above the title, the background) lives on the master, so the deck's look is editable in
 * PowerPoint's Slide Master view. The title layout hides the master's shapes and draws the cover look instead.
 */
import type { ThemeId } from "../../templates/schema.js";
import { NEUTRAL, SERIES } from "../color.js";
import { THEMES } from "../themes/index.js";
import type { DeckTheme } from "../themes/deck-themes.js";
import type { Colour, ThemePalette } from "../themes/palette.js";
import { background, emu, esc, hex, para, PML_NS, rect, shape, slideNumField, spTree, sz, txBody, XML_DECL, type Box, type RunStyle } from "./xml.js";

/** Slide geometry in inches (P-C4). */
export const SLIDE = { w: 13.333, h: 7.5, margin: 0.5, titleY: 0.35, titleH: 0.8, contentY: 1.35, contentBottom: 6.75, footerY: 7.0, footerH: 0.3, mainW: 8.1, sideX: 8.85, sideW: 3.98 } as const;
export const CONTENT_W = SLIDE.w - 2 * SLIDE.margin;

/** Placeholder indexes shared by the master, the layouts and the slides. */
export const PH = { body: 1, footer: 11, slideNum: 12 } as const;

/** Everything the parts need to draw one theme: the theme table, the palette and the resolved fonts. */
export interface Ctx {
  id: ThemeId;
  t: DeckTheme;
  p: ThemePalette;
  fonts: { body: string; heading: string };
  footer: string;
  /** A theme colour reference as #rrggbb. */
  col(c: Colour): string;
}

export function makeCtx(id: ThemeId, t: DeckTheme, p: ThemePalette, fonts: { body: string; heading: string }, footer: string): Ctx {
  const fill = t.title.fill;
  const map: Record<Exclude<Colour, `#${string}`>, string> = {
    primary: p.primary,
    primaryInk: p.primaryInk,
    accent: p.accent,
    ink: NEUTRAL.ink,
    muted: NEUTRAL.muted,
    dark: p.dark,
    onDark: p.onDark,
    onDarkSoft: p.onDarkSoft,
    onFill: fill === "primary" ? p.onPrimary : fill === "dark" ? p.onDark : NEUTRAL.ink,
    onFillSoft: fill === "primary" ? p.onPrimarySoft : fill === "dark" ? p.onDarkSoft : NEUTRAL.muted,
    tint: p.tint,
    tintInk: p.tintInk,
    warm: p.warm,
    wash: p.wash,
  };
  return { id, t, p, fonts, footer, col: (c) => (c.startsWith("#") ? `#${hex(c)}` : map[c as Exclude<Colour, `#${string}`>]) };
}

/** The title slide's fill colour (the cover band or panel), or null for a white cover. */
export const coverFill = (x: Ctx) => (x.t.title.fill === "primary" ? x.p.primary : x.t.title.fill === "dark" ? x.p.dark : null);

// ---------------------------------------------------------------------------------------------------------------
// Theme (theme1 for the slides, theme2 for the notes master)

/** The fixed format scheme: three fill, line, effect and background-fill styles each, as the schema requires. */
const FMT_SCHEME =
  `<a:fmtScheme name="Office">` +
  `<a:fillStyleLst>${`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${[6350, 12700, 19050].map((w) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`).join("")}</a:lnStyleLst>` +
  `<a:effectStyleLst>${`<a:effectStyle><a:effectLst/></a:effectStyle>`.repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${`<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>`.repeat(3)}</a:bgFillStyleLst>` +
  `</a:fmtScheme>`;

export function themeXml(x: Ctx): string {
  const name = esc(THEMES[x.id].label);
  const c = (tag: string, color: string) => `<a:${tag}><a:srgbClr val="${hex(color)}"/></a:${tag}>`;
  const clr =
    `<a:clrScheme name="${name}">` +
    c("dk1", NEUTRAL.ink) +
    c("lt1", "#ffffff") +
    c("dk2", x.id === "bold" ? x.p.dark : x.p.primaryInk) +
    c("lt2", NEUTRAL.surface) +
    c("accent1", x.p.primary) +
    c("accent2", x.p.accent) +
    SERIES.slice(1, 5).map((s, i) => c(`accent${i + 3}`, s)).join("") +
    c("hlink", x.p.primaryInk) +
    c("folHlink", NEUTRAL.muted) +
    `</a:clrScheme>`;
  const font = (tag: string, f: string) => `<a:${tag}><a:latin typeface="${esc(f)}"/><a:ea typeface=""/><a:cs typeface=""/></a:${tag}>`;
  const fonts = `<a:fontScheme name="${name}">${font("majorFont", x.fonts.heading)}${font("minorFont", x.fonts.body)}</a:fontScheme>`;
  return `${XML_DECL}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${name}"><a:themeElements>${clr}${fonts}${FMT_SCHEME}</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Slide master

const CLR_MAP = `bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"`;

const defRPr = (st: RunStyle) => `<a:defRPr sz="${sz(st.size)}" b="${st.bold ? 1 : 0}"${st.italic ? ` i="1"` : ""} kern="1200"><a:solidFill><a:srgbClr val="${hex(st.color)}"/></a:solidFill><a:latin typeface="${esc(st.font)}"/><a:ea typeface="${esc(st.font)}"/><a:cs typeface="${esc(st.font)}"/></a:defRPr>`;

function lvl(n: number, st: RunStyle, bullet: boolean, before: number): string {
  const ind = bullet ? ` marL="${emu(0.3 * n)}" indent="${-emu(0.3)}"` : ` marL="0" indent="0"`;
  const bu = bullet ? `<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/>` : "<a:buNone/>";
  return `<a:lvl${n}pPr${ind} algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:lnSpc><a:spcPct val="${bullet ? 110000 : 95000}"/></a:lnSpc><a:spcBef><a:spcPts val="${before * 100}"/></a:spcBef>${bu}${defRPr(st)}</a:lvl${n}pPr>`;
}

/** Heading run style for slide titles. */
export const headingStyle = (x: Ctx): RunStyle => ({ size: x.t.heading.size, bold: x.t.heading.bold, color: x.col(x.t.heading.color), font: x.fonts.heading });
/** Body text. */
export const bodyStyle = (x: Ctx, size = 18): RunStyle => ({ size, color: NEUTRAL.ink, font: x.fonts.body });
/** Footer text: 9 pt, faint. */
export const footerStyle = (x: Ctx): RunStyle => ({ size: 9, color: NEUTRAL.faint, font: x.fonts.body });

export const TITLE_BOX: Box = { x: SLIDE.margin, y: SLIDE.titleY, w: CONTENT_W, h: SLIDE.titleH };
export const FOOTER_BOX: Box = { x: SLIDE.margin, y: SLIDE.footerY, w: 9.5, h: SLIDE.footerH };
export const NUMBER_BOX: Box = { x: SLIDE.w - SLIDE.margin - 1.5, y: SLIDE.footerY, w: 1.5, h: SLIDE.footerH };

/** Where the title text sits on body slides (cards moves it right of its bar). */
export function titleBox(x: Ctx): Box {
  if (x.t.heading.bar) return { ...TITLE_BOX, x: TITLE_BOX.x + 0.2, w: TITLE_BOX.w - 0.2 };
  return TITLE_BOX;
}
export const titleAnchor = (x: Ctx): "t" | "ctr" | "b" => (x.t.heading.rule?.pos === "below" || x.id === "bold" ? "b" : "ctr");

/** The decorations every body slide shows (drawn on the master): the cards bar, rules above or below the title. */
function masterDecorations(x: Ctx, nextId: () => number): string[] {
  const out: string[] = [];
  const h = x.t.heading;
  const below = SLIDE.titleY + SLIDE.titleH + 0.05;
  if (h.bar) out.push(rect(nextId(), "Title bar", { x: SLIDE.margin, y: SLIDE.titleY + SLIDE.titleH / 2 - 0.2, w: 0.06, h: 0.4 }, x.p.primary));
  // Bold: a full-width light rule with the short primary bar standing on it.
  if (x.id === "bold") out.push(rect(nextId(), "Title rule", { x: SLIDE.margin, y: below, w: CONTENT_W, h: 1 / 72 }, "#DFE3E8"));
  if (h.rule) {
    const t = h.rule.weight / 72;
    const w = h.rule.width === "full" ? CONTENT_W : h.rule.width;
    const y = h.rule.pos === "below" ? below + (x.id === "bold" ? 1 / 72 - t : 0) : SLIDE.titleY - 0.08;
    out.push(rect(nextId(), "Title rule", { x: SLIDE.margin, y, w, h: t }, x.col(h.rule.color)));
  }
  return out;
}

function masterPlaceholders(x: Ctx, nextId: () => number): string[] {
  const hs = headingStyle(x);
  const fs = footerStyle(x);
  return [
    shape({ id: nextId(), name: "Title Placeholder", box: titleBox(x), ph: { type: "title" }, text: txBody([para([], hs)], { anchor: titleAnchor(x), autofit: true }) }),
    shape({ id: nextId(), name: "Text Placeholder", box: { x: SLIDE.margin, y: SLIDE.contentY, w: CONTENT_W, h: SLIDE.contentBottom - SLIDE.contentY }, ph: { type: "body", idx: PH.body }, text: txBody([para([], bodyStyle(x))], { autofit: true }) }),
    shape({ id: nextId(), name: "Footer Placeholder", box: FOOTER_BOX, ph: { type: "ftr", sz: "quarter", idx: PH.footer }, text: txBody([para([], fs)], { anchor: "ctr" }) }),
    shape({ id: nextId(), name: "Slide Number Placeholder", box: NUMBER_BOX, ph: { type: "sldNum", sz: "quarter", idx: PH.slideNum }, text: txBody([para([slideNumField(1, fs).replace("<a:t>1</a:t>", "<a:t>&#8249;#&#8250;</a:t>")], fs, { align: "r" })], { anchor: "ctr" }) }),
  ];
}

export function slideMasterXml(x: Ctx): string {
  let id = 1;
  const nextId = () => ++id;
  const shapes = [...masterDecorations(x, nextId), ...masterPlaceholders(x, nextId)];
  const title = headingStyle(x);
  const body = bodyStyle(x);
  const other = bodyStyle(x, 14);
  const txStyles =
    `<p:txStyles>` +
    `<p:titleStyle>${lvl(1, title, false, 0)}</p:titleStyle>` +
    `<p:bodyStyle>${lvl(1, body, true, 6)}${lvl(2, { ...body, size: 16 }, true, 4)}</p:bodyStyle>` +
    `<p:otherStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>${lvl(1, other, false, 0)}</p:otherStyle>` +
    `</p:txStyles>`;
  return `${XML_DECL}<p:sldMaster ${PML_NS}><p:cSld>${background(x.col(x.t.background))}${spTree(shapes)}</p:cSld><p:clrMap ${CLR_MAP}/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/><p:sldLayoutId id="2147483650" r:id="rId2"/></p:sldLayoutIdLst>${txStyles}</p:sldMaster>`;
}

// ---------------------------------------------------------------------------------------------------------------
// Layouts

/** Title slide geometry (inches). The content block starts right of consulting's strip. */
export function coverGeometry(x: Ctx) {
  const left = x.t.title.strip?.side === "left" ? x.t.title.strip.size + 0.75 : x.t.title.panel === "rounded" ? 1.0 : 0.9;
  const width = SLIDE.w - left - 0.9;
  return { left, width, kickerY: 1.75, titleY: 2.15, titleH: 1.3, subtitleY: 3.45, lineY: 3.95, ruleY: 4.55, entriesY: 4.7, agencyY: 6.15, logo: { x: SLIDE.w - 0.9 - 2.0, y: 0.75, w: 2.0, h: 0.8 } };
}

/** The cover look: the band, panel and strip, and minimal's rule under the cover block. */
export function coverDecorations(x: Ctx, nextId: () => number): string[] {
  const out: string[] = [];
  const fill = coverFill(x);
  const g = coverGeometry(x);
  if (fill && x.t.title.panel === "rounded") out.push(shape({ id: nextId(), name: "Cover panel", box: { x: 0.4, y: 0.4, w: SLIDE.w - 0.8, h: SLIDE.h - 0.8 }, geom: "roundRect", radius: 6000, fill, line: null }));
  const s = x.t.title.strip;
  if (s) {
    const color = x.col(s.color);
    const box: Box = s.side === "top" ? { x: 0, y: 0, w: SLIDE.w, h: s.size } : s.side === "bottom" ? { x: 0, y: SLIDE.h - s.size, w: SLIDE.w, h: s.size } : { x: 0, y: 0, w: s.size, h: SLIDE.h };
    out.push(rect(nextId(), "Cover strip", box, color));
  }
  if (x.id === "minimal") out.push(rect(nextId(), "Cover rule", { x: g.left, y: g.ruleY, w: g.width, h: 0.75 / 72 }, NEUTRAL.ink));
  return out;
}

/** The colour behind the title slide's text. */
export const coverBackground = (x: Ctx) => (x.t.title.panel === "full" ? coverFill(x)! : x.col(x.t.background));

function layoutXml(x: Ctx, kind: "title" | "body"): string {
  let id = 1;
  const nextId = () => ++id;
  if (kind === "title") {
    const g = coverGeometry(x);
    const ts: RunStyle = { size: x.t.title.titleSize, bold: x.t.title.titleBold, color: x.col(x.t.title.titleColor), font: x.fonts.heading };
    const ks: RunStyle = { size: 14, bold: true, caps: true, color: x.col(x.t.title.kickerColor), font: x.fonts.body, spacing: 1.5 };
    const shapes = [
      ...coverDecorations(x, nextId),
      shape({ id: nextId(), name: "Title", box: { x: g.left, y: g.titleY, w: g.width, h: g.titleH }, ph: { type: "ctrTitle" }, text: txBody([para([], ts)], { anchor: "b", autofit: true, inset: [0, 0.05, 0, 0.05] }) }),
      shape({ id: nextId(), name: "Subtitle", box: { x: g.left, y: g.kickerY, w: g.width, h: 0.4 }, ph: { type: "subTitle", idx: PH.body }, text: txBody([para([], ks)], { anchor: "b", inset: [0, 0, 0, 0] }) }),
    ];
    return `${XML_DECL}<p:sldLayout ${PML_NS} type="title" preserve="1" showMasterSp="0"><p:cSld name="Title">${background(coverBackground(x))}${spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  }
  const fs = footerStyle(x);
  const shapes = [
    shape({ id: nextId(), name: "Title", box: titleBox(x), ph: { type: "title" }, text: txBody([para([], headingStyle(x))], { anchor: titleAnchor(x), autofit: true }) }),
    shape({ id: nextId(), name: "Footer", box: FOOTER_BOX, ph: { type: "ftr", sz: "quarter", idx: PH.footer }, text: txBody([para([], fs)], { anchor: "ctr" }) }),
    shape({ id: nextId(), name: "Slide Number", box: NUMBER_BOX, ph: { type: "sldNum", sz: "quarter", idx: PH.slideNum }, text: txBody([para([slideNumField(1, fs).replace("<a:t>1</a:t>", "<a:t>&#8249;#&#8250;</a:t>")], fs, { align: "r" })], { anchor: "ctr" }) }),
  ];
  return `${XML_DECL}<p:sldLayout ${PML_NS} type="titleOnly" preserve="1"><p:cSld name="Body">${spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

export const titleLayoutXml = (x: Ctx) => layoutXml(x, "title");
export const bodyLayoutXml = (x: Ctx) => layoutXml(x, "body");

// ---------------------------------------------------------------------------------------------------------------
// Notes master and notes slides (portrait 7.5 × 10 in)

const NOTES_IMAGE: Box = { x: 0.375, y: 0.75, w: 6.75, h: 3.797 };
const NOTES_BODY: Box = { x: 0.75, y: 4.8, w: 6.0, h: 4.45 };

function slideImage(id: number): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(NOTES_IMAGE.x)}" y="${emu(NOTES_IMAGE.y)}"/><a:ext cx="${emu(NOTES_IMAGE.w)}" cy="${emu(NOTES_IMAGE.h)}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:srgbClr val="000000"/></a:solidFill></a:ln></p:spPr></p:sp>`;
}

export function notesMasterXml(x: Ctx): string {
  const st = bodyStyle(x, 12);
  const shapes = [slideImage(2), shape({ id: 3, name: "Notes Placeholder", box: NOTES_BODY, ph: { type: "body", sz: "quarter", idx: 3 }, text: txBody([para([], st)]) })];
  return `${XML_DECL}<p:notesMaster ${PML_NS}><p:cSld>${background("#ffffff")}${spTree(shapes)}</p:cSld><p:clrMap ${CLR_MAP}/><p:notesStyle>${lvl(1, st, false, 0)}</p:notesStyle></p:notesMaster>`;
}

/** A notes slide: the slide image, then the notes text (one paragraph per line). */
export function notesSlideXml(x: Ctx, text: string): string {
  const st = bodyStyle(x, 12);
  const paras = text.split(/\r?\n/).map((l) => para(l ? [`<a:r>${`<a:rPr lang="en-US" sz="${sz(st.size)}" dirty="0"/>`}<a:t>${esc(l)}</a:t></a:r>`] : [], st));
  const shapes = [slideImage(2), shape({ id: 3, name: "Notes", box: NOTES_BODY, ph: { type: "body", idx: 1 }, text: txBody(paras) })];
  return `${XML_DECL}<p:notes ${PML_NS}><p:cSld>${spTree(shapes)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}
