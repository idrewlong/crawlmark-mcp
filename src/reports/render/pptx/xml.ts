/**
 * PresentationML building blocks (pure strings). Every text and attribute value from data goes through `esc`
 * (docxText removes control and XML-invalid characters, then & < > " ' are escaped). Element order follows
 * ECMA-376 exactly (PowerPoint rejects out-of-order XML that LibreOffice accepts): see P-C4 in the 0.4.0 spec.
 */
import { docxText } from "../escape.js";

export const NS = {
  a: "http://schemas.openxmlformats.org/drawingml/2006/main",
  r: "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  p: "http://schemas.openxmlformats.org/presentationml/2006/main",
  c: "http://schemas.openxmlformats.org/drawingml/2006/chart",
} as const;

/** The three namespaces every slide-like part declares. */
export const PML_NS = `xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"`;
export const XML_DECL = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n`;

/** Text and attribute values: control and XML-invalid characters removed, then & < > " ' escaped. */
export function esc(s: string): string {
  return docxText(String(s)).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);
}

/** Inches to EMU. */
export const emu = (inches: number) => Math.round(inches * 914_400);
/** Points to EMU (line widths). */
export const ptEmu = (pt: number) => Math.round(pt * 12_700);
/** Font size in hundredths of a point. */
export const sz = (pt: number) => Math.round(pt * 100);

/** `#rrggbb` → `RRGGBB`. Throws on anything else, so no unchecked value reaches an attribute. */
export function hex(color: string): string {
  const h = color.replace(/^#/, "").toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(h)) throw new Error(`not a #rrggbb colour: ${color}`);
  return h;
}

export const solidFill = (color: string) => `<a:solidFill><a:srgbClr val="${hex(color)}"/></a:solidFill>`;
export const noFill = "<a:noFill/>";
/** An outline: `weight` in points, or no line. */
export const line = (color: string | null, weight = 0.75) => (color ? `<a:ln w="${ptEmu(weight)}">${solidFill(color)}</a:ln>` : `<a:ln>${noFill}</a:ln>`);

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const xfrm = (b: Box, tag = "a:xfrm") => `<${tag}><a:off x="${emu(b.x)}" y="${emu(b.y)}"/><a:ext cx="${emu(b.w)}" cy="${emu(b.h)}"/></${tag}>`;

export interface RunStyle {
  size: number;
  font: string;
  color: string;
  bold?: boolean;
  italic?: boolean;
  caps?: boolean;
  /** Letter spacing in points. */
  spacing?: number;
}

function rPrAttrs(st: RunStyle): string {
  return `lang="en-US" sz="${sz(st.size)}"${st.bold ? ` b="1"` : ` b="0"`}${st.italic ? ` i="1"` : ""}${st.caps ? ` cap="all"` : ""}${st.spacing ? ` spc="${Math.round(st.spacing * 100)}"` : ""} dirty="0"`;
}

/** `a:rPr` children in schema order: fill, then `a:latin` (plus `a:ea`/`a:cs` so every script uses the font). */
function rPrBody(st: RunStyle): string {
  const f = esc(st.font);
  return `${solidFill(st.color)}<a:latin typeface="${f}"/><a:ea typeface="${f}"/><a:cs typeface="${f}"/>`;
}

export const rPr = (st: RunStyle, tag = "a:rPr") => `<${tag} ${rPrAttrs(st)}>${rPrBody(st)}</${tag}>`;

export const run = (text: string, st: RunStyle) => `<a:r>${rPr(st)}<a:t>${esc(text)}</a:t></a:r>`;

/** A tab character (esc drops control characters, so the tab is written here). */
export const tabRun = (st: RunStyle) => `<a:r>${rPr(st)}<a:t>\t</a:t></a:r>`;

/** A slide-number field: renders the current slide's number. */
export const slideNumField = (n: number, st: RunStyle) => `<a:fld id="{B6F15528-21DE-4FAA-801E-634DDDAF4B2B}" type="slidenum">${rPr(st)}<a:t>${n}</a:t></a:fld>`;

export interface ParaStyle {
  align?: "l" | "ctr" | "r";
  /** A bullet character (a:buChar). */
  bullet?: string;
  bulletColor?: string;
  /** Space before and after, in points. */
  before?: number;
  after?: number;
  /** Line spacing in percent (100 = single). */
  lineSpacing?: number;
  /** A hanging indent in inches (marL, with indent = -marL): a bullet's text column, or a number's tab column. Default 0.3 with a bullet, else none. */
  hang?: number;
  /** Left tab stops in inches. */
  tabs?: number[];
  /** A first-line indent in inches (Keynote ignores a table cell's margins and marL, but honours this). */
  firstLine?: number;
}

/** `a:pPr` children in schema order: lnSpc, spcBef, spcAft, buClr, buSzPct, buFont, buChar / buNone. */
function pPr(ps: ParaStyle): string {
  const hang = ps.hang ?? (ps.bullet ? 0.3 : 0);
  const attrs = `${hang ? ` marL="${emu(hang)}" indent="${-emu(hang)}"` : ps.firstLine ? ` marL="0" indent="${emu(ps.firstLine)}"` : ` marL="0" indent="0"`}${ps.align ? ` algn="${ps.align}"` : ""}`;
  let body = "";
  if (ps.lineSpacing) body += `<a:lnSpc><a:spcPct val="${Math.round(ps.lineSpacing * 1000)}"/></a:lnSpc>`;
  if (ps.before !== undefined) body += `<a:spcBef><a:spcPts val="${Math.round(ps.before * 100)}"/></a:spcBef>`;
  if (ps.after !== undefined) body += `<a:spcAft><a:spcPts val="${Math.round(ps.after * 100)}"/></a:spcAft>`;
  if (ps.bullet) {
    if (ps.bulletColor) body += `<a:buClr><a:srgbClr val="${hex(ps.bulletColor)}"/></a:buClr>`;
    body += `<a:buSzPct val="100000"/><a:buFont typeface="Arial"/><a:buChar char="${esc(ps.bullet)}"/>`;
  } else body += "<a:buNone/>";
  if (ps.tabs?.length) body += `<a:tabLst>${ps.tabs.map((t) => `<a:tab pos="${emu(t)}" algn="l"/>`).join("")}</a:tabLst>`;
  return `<a:pPr${attrs}>${body}</a:pPr>`;
}

/** A paragraph: `a:pPr`, the runs, then `a:endParaRPr` (its size keeps empty paragraphs the right height). */
export function para(runs: string[], end: RunStyle, ps: ParaStyle = {}): string {
  return `<a:p>${pPr(ps)}${runs.join("")}${rPr(end, "a:endParaRPr")}</a:p>`;
}

export interface BodyStyle {
  anchor?: "t" | "ctr" | "b";
  /** Insets in inches: left, top, right, bottom. */
  inset?: [number, number, number, number];
  /** Shrink text on overflow (normAutofit). */
  autofit?: boolean;
  wrap?: boolean;
}

/** A text body: `a:bodyPr`, `a:lstStyle`, then at least one `a:p`. */
export function txBody(paras: string[], b: BodyStyle = {}, tag = "p:txBody"): string {
  const [l, t, r, bo] = b.inset ?? [0.1, 0.05, 0.1, 0.05];
  const fit = b.autofit ? "<a:normAutofit/>" : "<a:noAutofit/>";
  const body = paras.length ? paras.join("") : `<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
  return `<${tag}><a:bodyPr wrap="${b.wrap === false ? "none" : "square"}" lIns="${emu(l)}" tIns="${emu(t)}" rIns="${emu(r)}" bIns="${emu(bo)}" rtlCol="0" anchor="${b.anchor ?? "t"}">${fit}</a:bodyPr><a:lstStyle/>${body}</${tag}>`;
}

export type Geom = "rect" | "roundRect" | "ellipse" | "line";

/** Preset geometry; `radius` (roundRect) is the corner adjust in 1/100000 of the short side. */
export const geom = (g: Geom, radius?: number) => `<a:prstGeom prst="${g}"><a:avLst>${g === "roundRect" && radius !== undefined ? `<a:gd name="adj" fmla="val ${Math.round(radius)}"/>` : ""}</a:avLst></a:prstGeom>`;

export interface ShapeOpts {
  id: number;
  name: string;
  /** Position; omitted on a placeholder that inherits its layout's position. */
  box?: Box;
  geom?: Geom;
  radius?: number;
  fill?: string | null;
  line?: { color: string; weight: number } | null;
  /** A placeholder (`p:ph`): type and index. */
  ph?: { type: string; idx?: number; sz?: "quarter" | "half" };
  /** The text body (`txBody(...)`); none for plain decoration. */
  text?: string;
  /** Alternative text. */
  descr?: string;
}

/** `p:sp`: nvSpPr, spPr, txBody. */
export function shape(o: ShapeOpts): string {
  const descr = o.descr !== undefined ? ` descr="${esc(o.descr)}"` : "";
  const cNvSpPr = o.ph ? `<p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr>` : o.text !== undefined ? `<p:cNvSpPr txBox="1"/>` : "<p:cNvSpPr/>";
  const ph = o.ph ? `<p:ph type="${o.ph.type}"${o.ph.sz ? ` sz="${o.ph.sz}"` : ""}${o.ph.idx !== undefined ? ` idx="${o.ph.idx}"` : ""}/>` : "";
  let spPr = "";
  if (o.box) spPr += xfrm(o.box);
  if (o.geom || o.box) spPr += geom(o.geom ?? "rect", o.radius);
  if (o.fill !== undefined) spPr += o.fill ? solidFill(o.fill) : noFill;
  if (o.line !== undefined) spPr += o.line ? line(o.line.color, o.line.weight) : line(null);
  return `<p:sp><p:nvSpPr><p:cNvPr id="${o.id}" name="${esc(o.name)}"${descr}/>${cNvSpPr}<p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${spPr}</p:spPr>${o.text ?? ""}</p:sp>`;
}

/** A straight line (`p:cxnSp`): nvCxnSpPr, spPr. Horizontal when `vertical` is false. */
export function hairline(id: number, name: string, x: number, y: number, length: number, weightPt: number, color: string, vertical = false): string {
  const ext = vertical ? `<a:ext cx="0" cy="${emu(length)}"/>` : `<a:ext cx="${emu(length)}" cy="0"/>`;
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm><a:off x="${emu(x)}" y="${emu(y)}"/>${ext}</a:xfrm>${geom("line")}${line(color, weightPt)}</p:spPr></p:cxnSp>`;
}

/**
 * A filled rectangle with no outline (rules, bars, strips). Rules thinner than 2 pt are drawn as lines instead:
 * some renderers drop filled shapes that are under a pixel high.
 */
export function rect(id: number, name: string, box: Box, color: string): string {
  const thin = 2 / 72;
  if (box.h < thin && box.w >= box.h) return hairline(id, name, box.x, box.y + box.h / 2, box.w, box.h * 72, color);
  if (box.w < thin) return hairline(id, name, box.x + box.w / 2, box.y, box.h, box.w * 72, color, true);
  return shape({ id, name, box, geom: "rect", fill: color, line: null });
}

/** The shape tree: nvGrpSpPr, grpSpPr, then the shapes. */
export function spTree(shapes: string[]): string {
  return `<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join("")}</p:spTree>`;
}

/** A background fill (`p:bg` inside `p:cSld`). */
export const background = (color: string) => `<p:bg><p:bgPr>${solidFill(color)}<a:effectLst/></p:bgPr></p:bg>`;

/** A picture: nvPicPr, blipFill, spPr. */
export function picture(id: number, name: string, descr: string, rId: string, box: Box): string {
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${esc(name)}" descr="${esc(descr)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(box)}${geom("rect")}</p:spPr></p:pic>`;
}

/** A native chart frame: nvGraphicFramePr, xfrm, a:graphic. */
export function chartFrame(id: number, name: string, descr: string, rId: string, box: Box): string {
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}" descr="${esc(descr)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm(box, "p:xfrm")}<a:graphic><a:graphicData uri="${NS.c}"><c:chart xmlns:c="${NS.c}" r:id="${rId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

export interface Cell {
  text: string;
  style: RunStyle;
  align: "l" | "r";
  fill: string | null;
  /** The bottom border; the other three sides have no line. */
  bottom: { color: string; weight: number } | null;
  /** Vertical alignment (default centre); header cells sit on the bottom so one- and two-line headers share a baseline. */
  anchor?: "t" | "ctr" | "b";
  /** Extra space in inches before the text: a text column that follows a right-aligned number column (written as a first-line indent; Keynote ignores cell margins). */
  padL?: number;
}

/** "No Style, No Grid": the explicit cell fills and borders below are the whole look. */
const NO_STYLE_TABLE = "{2D5ABB26-0587-4C30-8999-92F81FD0307C}";

/** `a:tc`: txBody, then tcPr (lnL, lnR, lnT, lnB, fill). */
function cell(c: Cell): string {
  const runs = c.text ? [run(c.text, c.style)] : [];
  const body = txBody([para(runs, c.style, { align: c.align, ...(c.padL ? { firstLine: c.padL } : {}) })], {}, "a:txBody");
  const noLn = (tag: string) => `<${tag} w="0"><a:noFill/></${tag}>`;
  const bottom = c.bottom ? `<a:lnB w="${ptEmu(c.bottom.weight)}" cap="flat" cmpd="sng" algn="ctr">${solidFill(c.bottom.color)}<a:prstDash val="solid"/></a:lnB>` : noLn("a:lnB");
  return `<a:tc>${body}<a:tcPr marL="${emu(0.08)}" marR="${emu(0.08)}" marT="${emu(0.04)}" marB="${emu(0.04)}" anchor="${c.anchor ?? "ctr"}">${noLn("a:lnL")}${noLn("a:lnR")}${noLn("a:lnT")}${bottom}${c.fill ? solidFill(c.fill) : noFill}</a:tcPr></a:tc>`;
}

/** A table frame: nvGraphicFramePr, xfrm, a:graphic > a:tbl (tblPr, tblGrid, tr+). `cols` are inch widths. */
export function tableFrame(id: number, name: string, box: Box, cols: number[], rowHeights: number[], rows: Cell[][]): string {
  const grid = cols.map((w) => `<a:gridCol w="${emu(w)}"/>`).join("");
  const trs = rows.map((r, i) => `<a:tr h="${emu(rowHeights[i]!)}">${r.map(cell).join("")}</a:tr>`).join("");
  const w = cols.reduce((s, c) => s + emu(c), 0);
  const h = rowHeights.reduce((s, c) => s + emu(c), 0);
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${esc(name)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(box.x)}" y="${emu(box.y)}"/><a:ext cx="${w}" cy="${h}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="1" bandRow="0"><a:tableStyleId>${NO_STYLE_TABLE}</a:tableStyleId></a:tblPr><a:tblGrid>${grid}</a:tblGrid>${trs}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

/** Relationship type URIs. */
export const REL = {
  officeDocument: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument",
  coreProps: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties",
  extendedProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties",
  slideMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster",
  slideLayout: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout",
  slide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide",
  notesMaster: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster",
  notesSlide: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide",
  theme: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme",
  presProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/presProps",
  viewProps: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/viewProps",
  tableStyles: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/tableStyles",
  chart: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart",
  package: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package",
  image: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
} as const;

export interface Rel {
  id: string;
  type: string;
  target: string;
}

/** Relationships of one part, numbered rId1… in the order they're added. */
export class Rels {
  readonly list: Rel[] = [];
  add(type: string, target: string): string {
    const id = `rId${this.list.length + 1}`;
    this.list.push({ id, type, target });
    return id;
  }
  xml(): string {
    return `${XML_DECL}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${this.list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join("")}</Relationships>`;
  }
}
