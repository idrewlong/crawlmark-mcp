/**
 * Native charts for the deck, harvested from the Word export's chart generation (T3b). A throwaway one-chart
 * document is built with docx (the options come from chart-options.ts, the same function toDocx uses), then the
 * finished DrawingML chart part and its embedded data workbook are copied out. The deck writer places them under
 * ppt/charts/ and ppt/embeddings/, so "Edit Data" works in PowerPoint as it does in Word.
 *
 * This relies on docx's internal zip layout (word/charts/chart*.xml, one package relationship, one embedded
 * workbook). When that layout is not what we expect, chartPart returns null and the slide shows the table.
 */
import { posix } from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { ChartRun } from "docx/charts";
import JSZip from "jszip";
import type { Chart } from "../doc.js";
import { chartRunOptions } from "../chart-options.js";

/** A c:chartSpace whose c:externalData r:id is "rId1", and its data workbook. */
export interface ChartPart {
  xml: string;
  workbook: Buffer;
}

/** The chart width the deck draws at (px at 96 dpi); the writer sizes the graphic frame itself. */
const WIDTH_PX = 960;
const CHART_PART = /^word\/charts\/chart[^/]*\.xml$/;
const PACKAGE_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/package";
/** Fixed zip date so the re-packed workbook is byte-identical between runs. */
const FIXED_DATE = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));

/** null (never a throw) only when the docx chart layout check fails. */
export async function chartPart(c: Chart, o: { primary: string; font: string }): Promise<ChartPart | null> {
  try {
    const opts = chartRunOptions(c, { primary: o.primary, font: o.font, widthPx: WIDTH_PX, half: false });
    const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new ChartRun(opts)] })] }] });
    const zip = await JSZip.loadAsync(await Packer.toBuffer(doc));

    const chartNames = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir && CHART_PART.test(n));
    if (chartNames.length !== 1) return null;
    const chartName = chartNames[0]!;

    const relsFile = zip.file(`${posix.dirname(chartName)}/_rels/${posix.basename(chartName)}.rels`);
    if (!relsFile) return null;
    const rels = [...(await relsFile.async("string")).matchAll(/<Relationship\b[^>]*>/g)].map((m) => m[0]);
    const packages = rels.filter((r) => attr(r, "Type") === PACKAGE_REL);
    if (packages.length !== 1) return null;
    const rel = packages[0]!;
    if (attr(rel, "TargetMode") === "External") return null;
    const target = attr(rel, "Target");
    if (!target) return null;
    const workbookName = posix.normalize(posix.join(posix.dirname(chartName), target));
    if (!/^word\/embeddings\/[^/]+\.xlsx$/.test(workbookName)) return null;
    const workbookFile = zip.file(workbookName);
    if (!workbookFile) return null;

    const xml = (await zip.file(chartName)!.async("string")).replace(/(<c:externalData\b[^>]*?\br:id=")[^"]*(")/, "$1rId1$2");
    if (!xml.includes('<c:externalData r:id="rId1"')) return null;

    const workbook = await repack(await workbookFile.async("nodebuffer"));
    if (!workbook) return null;
    return { xml, workbook };
  } catch {
    return null;
  }
}

function attr(tag: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(tag)?.[1];
}

/** The workbook with fixed zip dates and entry order (docx stamps the current time), and no directory entries. */
async function repack(bytes: Buffer): Promise<Buffer | null> {
  const src = await JSZip.loadAsync(bytes);
  if (!src.file("xl/workbook.xml")) return null;
  const out = new JSZip();
  const names = Object.keys(src.files)
    .filter((n) => !src.files[n]!.dir)
    .sort((a, b) => (a === "[Content_Types].xml" ? -1 : b === "[Content_Types].xml" ? 1 : a < b ? -1 : a > b ? 1 : 0));
  for (const n of names) out.file(n, await src.file(n)!.async("nodebuffer"), { date: FIXED_DATE, createFolders: false });
  return out.generateAsync({ type: "nodebuffer", compression: "DEFLATE", platform: "UNIX" });
}
