/**
 * The .pptx package: [Content_Types].xml generated from the part list, the root and document-level parts
 * (docProps, presentation, presProps, viewProps, tableStyles), the guards, and the zip. Byte-deterministic:
 * entries in a fixed order, every entry dated `generatedAt`, DEFLATE, no folder entries.
 */
import { posix } from "node:path";
import JSZip from "jszip";
import { esc, PML_NS, REL, Rels, XML_DECL } from "./xml.js";

export interface Part {
  name: string;
  data: string | Buffer;
  /** An Override content type; parts without one need a Default for their extension. */
  contentType?: string;
}

const OOXML = "application/vnd.openxmlformats-officedocument";
export const CT = {
  presentation: `${OOXML}.presentationml.presentation.main+xml`,
  slide: `${OOXML}.presentationml.slide+xml`,
  slideLayout: `${OOXML}.presentationml.slideLayout+xml`,
  slideMaster: `${OOXML}.presentationml.slideMaster+xml`,
  notesMaster: `${OOXML}.presentationml.notesMaster+xml`,
  notesSlide: `${OOXML}.presentationml.notesSlide+xml`,
  presProps: `${OOXML}.presentationml.presProps+xml`,
  viewProps: `${OOXML}.presentationml.viewProps+xml`,
  tableStyles: `${OOXML}.presentationml.tableStyles+xml`,
  theme: `${OOXML}.theme+xml`,
  chart: `${OOXML}.drawingml.chart+xml`,
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: `${OOXML}.extended-properties+xml`,
} as const;

/** Extension defaults. There is deliberately no `xml` default: every XML part needs its own Override. */
const DEFAULTS: Record<string, string> = {
  rels: "application/vnd.openxmlformats-package.relationships+xml",
  xlsx: `${OOXML}.spreadsheetml.sheet`,
  png: "image/png",
  jpeg: "image/jpeg",
};

export interface Meta {
  title: string;
  subject: string;
  author: string;
  company: string;
  /** The report's generation date: created, modified and every zip entry date. */
  date: Date;
}

/** A valid zip date for any input (zip dates start in 1980): the report date, else 1980-01-01. */
export function packageDate(iso: string): Date {
  const d = new Date(iso);
  return Number.isFinite(d.getTime()) && d.getUTCFullYear() >= 1980 ? d : new Date(Date.UTC(1980, 0, 1));
}

const w3c = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");

export function coreXml(m: Meta): string {
  const date = w3c(m.date);
  return `${XML_DECL}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(m.title)}</dc:title><dc:subject>${esc(m.subject)}</dc:subject><dc:creator>${esc(m.author)}</dc:creator><cp:lastModifiedBy>${esc(m.author)}</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${date}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${date}</dcterms:modified></cp:coreProperties>`;
}

/** Extended properties: Application is the author ("crawlmark", the agency, or left out under white label). */
export function appXml(m: Meta, slides: number, notes: number): string {
  const app = m.author ? `<Application>${esc(m.author)}</Application>` : "";
  const company = m.company ? `<Company>${esc(m.company)}</Company>` : "";
  return `${XML_DECL}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">${app}<PresentationFormat>Widescreen</PresentationFormat><Slides>${slides}</Slides><Notes>${notes}</Notes>${company}</Properties>`;
}

const DEFAULT_TEXT_STYLE =
  `<p:defaultTextStyle><a:defPPr><a:defRPr lang="en-US"/></a:defPPr>` +
  `<a:lvl1pPr marL="0" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl1pPr>` +
  `</p:defaultTextStyle>`;

/**
 * presentation.xml and its relationships (master, slides, notes master, theme1, presProps, viewProps, tableStyles).
 * Children in schema order: sldMasterIdLst, notesMasterIdLst, sldIdLst, sldSz, notesSz, defaultTextStyle.
 */
export function presentationParts(slideCount: number): { xml: string; rels: Rels } {
  const rels = new Rels();
  const master = rels.add(REL.slideMaster, "slideMasters/slideMaster1.xml");
  const slides = Array.from({ length: slideCount }, (_, i) => rels.add(REL.slide, `slides/slide${i + 1}.xml`));
  const notesMaster = rels.add(REL.notesMaster, "notesMasters/notesMaster1.xml");
  rels.add(REL.theme, "theme/theme1.xml");
  rels.add(REL.presProps, "presProps.xml");
  rels.add(REL.viewProps, "viewProps.xml");
  rels.add(REL.tableStyles, "tableStyles.xml");
  const xml =
    `${XML_DECL}<p:presentation ${PML_NS} saveSubsetFonts="1">` +
    `<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="${master}"/></p:sldMasterIdLst>` +
    `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMaster}"/></p:notesMasterIdLst>` +
    `<p:sldIdLst>${slides.map((r, i) => `<p:sldId id="${256 + i}" r:id="${r}"/>`).join("")}</p:sldIdLst>` +
    `<p:sldSz cx="12192000" cy="6858000"/><p:notesSz cx="6858000" cy="9144000"/>` +
    DEFAULT_TEXT_STYLE +
    `</p:presentation>`;
  return { xml, rels };
}

export const PRES_PROPS = `${XML_DECL}<p:presentationPr ${PML_NS}/>`;
export const VIEW_PROPS = `${XML_DECL}<p:viewPr ${PML_NS}><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>`;
export const TABLE_STYLES = `${XML_DECL}<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`;

export function rootRels(): Rels {
  const r = new Rels();
  r.add(REL.officeDocument, "ppt/presentation.xml");
  r.add(REL.coreProps, "docProps/core.xml");
  r.add(REL.extendedProps, "docProps/app.xml");
  return r;
}

/** The `.rels` part name for a part: `ppt/slides/slide1.xml` → `ppt/slides/_rels/slide1.xml.rels`. */
export const relsName = (part: string) => (part === "" ? "_rels/.rels" : `${posix.dirname(part)}/_rels/${posix.basename(part)}.rels`);

/** The extension after the last dot (`_rels/.rels` → `rels`; path.extname gives "" for a dotfile). */
const ext = (name: string) => name.slice(name.lastIndexOf(".") + 1);

function contentTypes(parts: Part[]): string {
  const exts = new Set(parts.filter((p) => !p.contentType).map((p) => ext(p.name)));
  const defaults = Object.keys(DEFAULTS)
    .filter((e) => exts.has(e))
    .map((e) => `<Default Extension="${e}" ContentType="${DEFAULTS[e]}"/>`)
    .join("");
  const overrides = parts
    .filter((p) => p.contentType)
    .map((p) => `<Override PartName="/${esc(p.name)}" ContentType="${p.contentType}"/>`)
    .join("");
  return `${XML_DECL}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides}</Types>`;
}

/**
 * The guards (P-C4): every part has a content type; every relationship Target resolves to a part in the package;
 * no relationship is external. Throws, so exportReport reports `PPTX not written: …`.
 */
export function checkPackage(parts: Part[]): void {
  const names = new Set(parts.map((p) => p.name));
  for (const p of parts) {
    if (!p.contentType && !DEFAULTS[ext(p.name)]) throw new Error(`no content type for ${p.name}`);
    if (!p.name.endsWith(".rels")) continue;
    const xml = String(p.data);
    if (/TargetMode\s*=\s*"External"/i.test(xml)) throw new Error(`external relationship in ${p.name}`);
    // _rels/.rels belongs to the package root; x/_rels/y.rels to x/y, whose targets resolve from x/.
    const base = p.name === "_rels/.rels" ? "" : posix.dirname(posix.dirname(p.name));
    for (const m of xml.matchAll(/Target="([^"]*)"/g)) {
      const target = posix.normalize(posix.join(base, m[1]!.replace(/&amp;/g, "&")));
      if (!names.has(target)) throw new Error(`relationship in ${p.name} points to a missing part: ${m[1]}`);
    }
  }
}

/** The zip: [Content_Types].xml first, then the parts in the order given; fixed dates; DEFLATE. */
export async function writePackage(parts: Part[], date: Date): Promise<Buffer> {
  checkPackage(parts);
  const zip = new JSZip();
  const opts = { date, createFolders: false } as const;
  zip.file("[Content_Types].xml", contentTypes(parts), opts);
  for (const p of parts) zip.file(p.name, p.data, opts);
  return zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE", compressionOptions: { level: 6 }, platform: "DOS" });
}
