/**
 * Release B QA: white label in every part of the DOCX package, not just word/document.xml. The header, footer,
 * document properties and chart parts must not name crawlmark, Claude or DataForSEO either (a file's properties
 * show in Word's "Info" pane). Fixture data only (example.com); no network.
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { p13bReport, p13Report } from "./fixtures/reports/p13-data.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";

const LEAK = /crawlmark|claude|dataforseo/i;

async function allParts(buf: Buffer): Promise<Record<string, string>> {
  const zip = await JSZip.loadAsync(buf);
  const out: Record<string, string> = {};
  for (const [name, f] of Object.entries(zip.files)) if (!f.dir && /\.(xml|rels)$/.test(name)) out[name] = await f.async("string");
  return out;
}

describe("white label, whole DOCX package", () => {
  it("no part of the file names crawlmark, Claude or DataForSEO with hideCrawlmark", async () => {
    const r = p13bReport();
    r.sections.push(...p13Report().sections);
    const doc = buildReportDoc(r, { version: "0.3.0", branding: { hideCrawlmark: true, footer: "Example Agency" }, narrative: { summary: "Clicks grew." } });
    const parts = await allParts(await toDocx(doc));
    expect(Object.keys(parts)).toEqual(expect.arrayContaining(["word/document.xml", "word/styles.xml", "docProps/core.xml"]));
    for (const [name, xml] of Object.entries(parts)) expect(xml, name).not.toMatch(LEAK);
  });

  it("the layout report (cover, contents, page breaks) is clean too", async () => {
    const doc = buildReportDoc(await layoutReport(), { version: "0.3.0", branding: { hideCrawlmark: true } });
    for (const [name, xml] of Object.entries(await allParts(await toDocx(doc)))) expect(xml, name).not.toMatch(LEAK);
  });
});
