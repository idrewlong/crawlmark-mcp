/**
 * Writes the Google Docs variant of the Word file (fixture data) to DOCX_SAMPLES_DIR, so CI opens each with
 * LibreOffice next to the normal samples: gdocs-monthly-<theme>.docx for the six themes and gdocs-yearly-cards.docx.
 * Skipped unless DOCX_SAMPLES_DIR is set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const out = process.env.DOCX_SAMPLES_DIR;
const narrative = { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: { search: "Search is **up**.\n\n- Clicks rose" } };

async function check(buf: Buffer) {
  expect(buf.subarray(0, 2).toString()).toBe("PK");
  const zip = await JSZip.loadAsync(buf);
  const names = Object.keys(zip.files);
  expect(names.filter((n) => n.startsWith("word/charts/") || n.startsWith("word/embeddings/"))).toEqual([]);
  const document = await zip.file("word/document.xml")!.async("string");
  expect(document).toContain("w:anchor=");
  expect(document).toContain("<w:tbl>");
}

describe.skipIf(!out)("Google Docs variant samples for CI", () => {
  for (const theme of THEME_IDS) {
    it(`writes gdocs-monthly-${theme}.docx`, async () => {
      const report = await fixtureReport();
      report.template = { ...report.template, contents: true };
      const doc = buildReportDoc(report, {
        version: "0.5.0",
        theme,
        logo: { mime: "image/png", data: TINY_PNG },
        branding: { primaryColor: "#224466", accentColor: "#cc6600", hideCrawlmark: true, agencyName: "Example Agency" },
        narrative,
      });
      const buf = await toDocx(doc, { variant: "docs" });
      await check(buf);
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, `gdocs-monthly-${theme}.docx`), buf);
    });
  }

  it("writes gdocs-yearly-cards.docx", async () => {
    const report = yearlyReport();
    report.template = { ...report.template, contents: true };
    const doc = buildReportDoc(report, { version: "0.5.0", narrative: { summary: "Clicks grew **12%**.", sections: {} } });
    const buf = await toDocx(doc, { variant: "docs" });
    await check(buf);
    mkdirSync(out!, { recursive: true });
    writeFileSync(join(out!, "gdocs-yearly-cards.docx"), buf);
  });
});
