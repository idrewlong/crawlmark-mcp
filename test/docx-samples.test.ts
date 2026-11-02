/**
 * Writes one DOCX per builtin template (fixture data) to DOCX_SAMPLES_DIR, so CI can open each
 * file with LibreOffice. Skipped unless DOCX_SAMPLES_DIR is set. The yearly builtin runs for the year 2025 (0.5.0 Y3.4),
 * and the yearly report with all four yearly sections is written once per non-cards theme.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { BUILTIN_TEMPLATES } from "../src/reports/templates/builtin.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";
import { yearlyReport } from "./fixtures/reports/yearly-data.js";

const out = process.env.DOCX_SAMPLES_DIR;

describe.skipIf(!out)("DOCX samples for CI", () => {
  for (const id of Object.keys(BUILTIN_TEMPLATES)) {
    it(`writes ${id}.docx`, async () => {
      const run = id === "monthly" ? {} : id === "yearly" ? { template: id, month: undefined, year: "2025", include: [] } : { template: id, include: [] };
      const doc = buildReportDoc(await fixtureReport(run), {
        version: "0.1.0",
        narrative: { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: {} },
      });
      const buf = await toDocx(doc);
      expect(buf.subarray(0, 2).toString()).toBe("PK");
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, `${id}.docx`), buf);
    });
  }

  // One file per non-cards theme (monthly fixture, linked contents), so CI's LibreOffice job opens each Word theme.
  for (const theme of ["minimal", "editorial", "bold", "consulting", "friendly"] as const) {
    it(`writes theme-${theme}.docx`, async () => {
      const report = await fixtureReport();
      report.template = { ...report.template, contents: true };
      const doc = buildReportDoc(report, {
        version: "0.4.0",
        theme,
        branding: { primaryColor: "#224466", accentColor: "#cc6600", hideCrawlmark: true },
        narrative: { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: { search: "Search is **up**.\n\n- Clicks rose" } },
      });
      const buf = await toDocx(doc);
      expect(buf.subarray(0, 2).toString()).toBe("PK");
      const document = await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string");
      expect(document).toContain("w:anchor=");
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, `theme-${theme}.docx`), buf);
    });
  }

  // 0.5.0: the yearly report (all four yearly sections, two native share charts, monthly fallback tables) per non-cards theme.
  for (const theme of ["minimal", "editorial", "bold", "consulting", "friendly"] as const) {
    it(`writes theme-yearly-${theme}.docx`, async () => {
      const doc = buildReportDoc(yearlyReport(), {
        version: "0.5.0",
        theme,
        branding: { primaryColor: "#224466", accentColor: "#cc6600", hideCrawlmark: true },
        narrative: { summary: "Clicks grew **a third** on 2024.\n\n- Search led\n- Direct followed", sections: { channels: "Search brought **40%** of sessions." } },
      });
      const buf = await toDocx(doc);
      expect(buf.subarray(0, 2).toString()).toBe("PK");
      const zip = await JSZip.loadAsync(buf);
      const document = await zip.file("word/document.xml")!.async("string");
      expect(document).toContain("Traffic by channel, year over year");
      expect(document).toContain("Wins and misses");
      expect(Object.keys(zip.files).some((f) => /^word\/charts\/chart\d+\.xml$/.test(f))).toBe(true);
      mkdirSync(out!, { recursive: true });
      writeFileSync(join(out!, `theme-yearly-${theme}.docx`), buf);
    });
  }

  // Release B features the builtin samples don't touch: cover fields, linked contents, page breaks, fonts, and
  // commentary with a sub-heading, numbered list, table (nested in the callout) and a repeated chart. CI converts this
  // file with LibreOffice like the others, so a structure Word-compatible readers reject fails there.
  it("writes release-b-layout.docx", async () => {
    const commentary = [
      "#### What changed",
      "",
      "1. Update the services pages",
      "2. Fix the broken links",
      "",
      "| Page | Clicks |",
      "| --- | ---: |",
      "| /services | **120** |",
      "",
      "{{chart search 1}}",
      "",
      "Closing paragraph after the table and the chart.",
    ].join("\n");
    const doc = buildReportDoc(await layoutReport(), {
      version: "0.3.0",
      branding: { bodyFont: "Inter", headingFont: "Merriweather", hideCrawlmark: true },
      narrative: { summary: "Clicks grew **12%**.", sections: { search: commentary } },
    });
    const buf = await toDocx(doc);
    expect(buf.subarray(0, 2).toString()).toBe("PK");
    const document = await (await JSZip.loadAsync(buf)).file("word/document.xml")!.async("string");
    expect(document).toContain("w:pageBreakBefore");
    expect(document).toContain('w:val="Heading4"');
    expect(document).toContain("w:anchor=");
    expect(document).toContain("<w:tbl>");
    mkdirSync(out!, { recursive: true });
    writeFileSync(join(out!, "release-b-layout.docx"), buf);
  });
});
