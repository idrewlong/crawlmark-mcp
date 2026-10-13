/**
 * DOCX renderer (D6): WordprocessingML built from the ReportDoc with the docx
 * library, not converted from HTML, so headings, lists and tables come out as
 * real Word structures in Word, Google Docs and LibreOffice. All text passes
 * docxText (control and XML-invalid characters removed); docx XML-escapes it.
 */
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  ImageRun,
  Packer,
  PageNumber,
  Paragraph,
  ShadingType,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
  type ParagraphChild,
} from "docx";
import type { Block, ReportDoc, Text } from "./doc.js";
import { docxText, safeColor } from "./escape.js";
import { fit, imageSize } from "./image.js";
import type { NarrativeBlock } from "./narrative.js";

const PAGE = { Letter: { width: 12240, height: 15840 }, A4: { width: 11906, height: 16838 } } as const;
/** 15 mm in twips. */
const MARGIN = 850;
const FONT = "Calibri";
const MONO = "Consolas";
const hex = (c: string) => c.replace("#", "").toUpperCase();

function runs(t: Text, opts: { italics?: boolean; color?: string } = {}): TextRun[] {
  return t.map(
    (r) =>
      new TextRun({
        text: docxText(r.t),
        ...(r.b ? { bold: true } : {}),
        ...(r.c ? { font: MONO, size: 18 } : {}),
        ...(opts.italics ? { italics: true } : {}),
        ...(opts.color ? { color: opts.color } : {}),
      }),
  );
}

const plain = (s: string): Text => [{ t: s }];

function cellBorders(color = "BFBFBF") {
  const b = { style: BorderStyle.SINGLE, size: 4, color };
  return { top: b, bottom: b, left: b, right: b };
}

function table(header: string[], rows: Text[][], numeric: boolean[] | undefined, headFill: string): Table {
  const align = (i: number) => (numeric?.[i] ? AlignmentType.RIGHT : AlignmentType.LEFT);
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({
        tableHeader: true,
        children: header.map(
          (h, i) =>
            new TableCell({
              borders: cellBorders(),
              shading: { type: ShadingType.CLEAR, color: "auto", fill: headFill },
              children: [new Paragraph({ alignment: align(i), children: [new TextRun({ text: docxText(h), bold: true })] })],
            }),
        ),
      }),
      ...rows.map(
        (r) =>
          new TableRow({
            cantSplit: true,
            children: r.map((c, i) => new TableCell({ borders: cellBorders(), children: [new Paragraph({ alignment: align(i), children: runs(c) })] })),
          }),
      ),
    ],
  });
}

/** A shaded one-cell table: the banner and the commentary boxes. */
function box(paragraphs: Paragraph[], fill: string, border: string): Table {
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [new TableRow({ children: [new TableCell({ borders: cellBorders(border), shading: { type: ShadingType.CLEAR, color: "auto", fill }, children: paragraphs })] })],
  });
}

function narrative(blocks: NarrativeBlock[]): Paragraph[] {
  return blocks.flatMap((b) => (b.kind === "p" ? [new Paragraph({ children: runs(b.runs), spacing: { after: 80 } })] : b.items.map((i) => new Paragraph({ bullet: { level: 0 }, children: runs(i) }))));
}

function commentary(blocks: NarrativeBlock[], primary: string): Table {
  return box([new Paragraph({ children: [new TextRun({ text: "Commentary", bold: true, color: primary })] }), ...narrative(blocks)], "F5F8FC", primary);
}

const spacer = () => new Paragraph({ children: [], spacing: { after: 60 } });

function block(b: Block, primary: string): (Paragraph | Table)[] {
  switch (b.kind) {
    case "heading":
      return [new Paragraph({ heading: b.level === 1 ? HeadingLevel.HEADING_1 : b.level === 2 ? HeadingLevel.HEADING_2 : HeadingLevel.HEADING_3, children: [new TextRun({ text: docxText(b.text), color: b.level < 3 ? primary : undefined })] })];
    case "paragraph":
      return [new Paragraph({ children: runs(b.text), spacing: { after: 100 } })];
    case "note":
      return [new Paragraph({ children: runs(b.text, { italics: true, color: "555555" }), spacing: { after: 100 } })];
    case "list":
      return b.items.map((i) => new Paragraph({ bullet: { level: 0 }, children: runs(i) }));
    case "table":
      return [table(b.header, b.rows, b.numeric, "F1F4F8"), spacer()];
    case "kpiRow":
      return [table(b.items.map((k) => k.label), [b.items.map((k) => plain(k.value))], b.items.map(() => true), "F1F4F8"), spacer()];
    case "commentary":
      return [commentary(b.blocks, primary), spacer()];
  }
}

export async function toDocx(doc: ReportDoc): Promise<Buffer> {
  const primary = hex(safeColor(doc.branding.primaryColor, "#1f4e79"));
  const accent = hex(safeColor(doc.branding.accentColor, "#2e8540"));
  const children: (Paragraph | Table)[] = [];

  const logo = doc.branding.logo;
  const size = logo ? imageSize(logo.data) : undefined;
  if (logo && size) {
    children.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: logo.mime === "image/png" ? "png" : "jpg",
            data: logo.data,
            transformation: fit(size, 200, 56),
            altText: { name: "logo", description: docxText(doc.branding.agencyName ?? "Logo"), title: "Logo" },
          }),
        ],
      }),
    );
  }
  if (doc.branding.agencyName) children.push(new Paragraph({ children: [new TextRun({ text: docxText(doc.branding.agencyName), bold: true, color: primary })] }));
  children.push(new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun({ text: docxText(doc.meta.clientLine), color: primary })] }));
  children.push(new Paragraph({ children: [new TextRun(docxText(doc.meta.reportLine))] }));
  children.push(new Paragraph({ children: [new TextRun({ text: docxText(doc.meta.compareLine), color: "444444" })], spacing: { after: 160 } }));
  children.push(box([new Paragraph({ children: [new TextRun({ text: `${docxText(doc.banner.title)}. `, bold: true }), new TextRun(docxText(doc.banner.text))] })], "F6FAF6", accent), spacer());

  if (doc.kpis.length) {
    children.push(...block({ kind: "heading", level: 2, text: "Key figures" }, primary));
    children.push(table(["Metric", "Value", "Change"], doc.kpis.map((k) => [plain(k.label), plain(k.value), plain(k.detail ?? "")]), [false, true, false], "F1F4F8"), spacer());
  }
  if (doc.highlights.length) {
    children.push(...block({ kind: "heading", level: 2, text: "Highlights (computed automatically)" }, primary));
    children.push(...doc.highlights.map((h) => new Paragraph({ bullet: { level: 0 }, children: runs(h) })));
  }
  if (doc.summary) {
    children.push(...block({ kind: "heading", level: 2, text: "Summary" }, primary));
    children.push(commentary(doc.summary, primary), spacer());
  }
  for (const b of [...doc.blocks, ...doc.sourcesAndNotes]) children.push(...block(b, primary));

  const footerRuns: ParagraphChild[] = [new TextRun({ text: `${docxText(doc.footer)} · page `, color: "555555", size: 16 }), new TextRun({ children: [PageNumber.CURRENT], color: "555555", size: 16 }), new TextRun({ text: " of ", color: "555555", size: 16 }), new TextRun({ children: [PageNumber.TOTAL_PAGES], color: "555555", size: 16 })];
  const document = new Document({
    title: docxText(doc.meta.title),
    creator: "crawlmark",
    description: doc.meta.dataOnly ? "Data-only report" : "Report with commentary",
    styles: { default: { document: { run: { font: FONT, size: 21 } } } },
    sections: [
      {
        properties: { page: { size: PAGE[doc.branding.paper], margin: { top: MARGIN, bottom: MARGIN, left: MARGIN, right: MARGIN } } },
        footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.CENTER, children: footerRuns })] }) },
        children,
      },
    ],
  });
  return Packer.toBuffer(document);
}
