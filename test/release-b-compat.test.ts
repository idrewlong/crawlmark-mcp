/**
 * Release B compatibility: everything written by 0.2.0 must load, validate and render unchanged.
 * The goldens in test/fixtures/reports/compat-0.2.0/ were captured from the 0.2.0 code before any Release B
 * change. Never regenerate them for a Release B change (UPDATE_COMPAT=1 exists only to re-capture on 0.2.0).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { BUILTIN_TEMPLATES, STARTER_YAML } from "../src/reports/templates/builtin.js";
import { getStoredReport, storeReport } from "../src/reports/templates/run.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import type { TemplateReport } from "../src/reports/report-types.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const DIR = join(import.meta.dirname, "fixtures", "reports", "compat-0.2.0");
const UPDATE = process.env.UPDATE_COMPAT === "1";
const NARRATIVE = {
  summary: "Clicks grew **12%** in September.\n\n- Blog pages led the gain\n- Branded searches held steady\n\nNext month we will look at the services pages.",
  sections: {} as Record<string, string>,
};
const BRANDING = { agencyName: "Example Agency", primaryColor: "#224466", accentColor: "#cc6600", footer: "Example Agency, example.com", paper: "A4" as const, hideCrawlmark: true };

function golden(name: string, actual: string): void {
  const file = join(DIR, name);
  if (UPDATE) {
    mkdirSync(DIR, { recursive: true });
    writeFileSync(file, actual);
    return;
  }
  expect(existsSync(file), `missing golden ${name}`).toBe(true);
  expect(actual === readFileSync(file, "utf8"), `${name} differs from the 0.2.0 output`).toBe(true);
}

const ids = Object.keys(BUILTIN_TEMPLATES);

describe("0.2.0 templates still validate", () => {
  it("accepts the starter file", () => {
    const r = validateTemplateText(STARTER_YAML);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it("accepts a 0.2.0-style file with every old section field, branding and period", () => {
    const yaml = `
version: 1
branding: { agencyName: Example Agency, primaryColor: "#224466", hideCrawlmark: true, paper: A4 }
defaults: { template: mine, formats: [md, html] }
templates:
  mine:
    title: Mine
    layout: standard
    period: { range: last_n_days, days: 30 }
    compare: [previous_period]
    sections:
      - { id: search, type: search_overview }
      - { id: note, type: text, text: "Hello" }
`;
    const r = validateTemplateText(yaml);
    expect(r.errors).toEqual([]);
    expect(r.valid).toBe(true);
  });

  it.each(ids)("builtin %s has a title and sections", (id) => {
    expect(BUILTIN_TEMPLATES[id]!.sections.length).toBeGreaterThan(0);
  });
});

describe("0.2.0 reports render byte-identically", () => {
  for (const id of ids) {
    it(`${id}: plain and with commentary + branding`, async () => {
      const report = await fixtureReport(id === "monthly" ? {} : { template: id, include: [] });
      const narrative = id === "monthly" ? { ...NARRATIVE, sections: { search: "Search is **up**.\n\n- Clicks rose\n- CTR flat" } } : NARRATIVE;
      for (const [tag, opts] of [
        ["plain", { version: "0.2.0" }],
        ["brand", { version: "0.2.0", narrative, branding: BRANDING }],
      ] as const) {
        const doc = buildReportDoc(report, opts as never);
        golden(`${id}-${tag}.md`, toMarkdown(doc));
        golden(`${id}-${tag}.html`, toHtml(doc));
        golden(`${id}-${tag}.docs.html`, toHtml(doc, { variant: "docs" }));
      }
    });
  }

  it("monthly DOCX document.xml and styles.xml", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.2.0", narrative: NARRATIVE });
    const zip = await JSZip.loadAsync(await toDocx(doc));
    // docx numbers drawings with a process-wide counter, so docPr ids depend on what rendered earlier, and chart relationship ids are random.
    const norm = (s: string) => s.replace(/ w:rsid\w*="[^"]*"/g, "").replace(/<wp:docPr id="\d+"/g, '<wp:docPr id="0"').replace(/r:id="rId[\w-]{20,}"/g, 'r:id="rIdX"');
    golden("monthly.document.xml", norm(await zip.file("word/document.xml")!.async("string")));
    golden("monthly.styles.xml", norm(await zip.file("word/styles.xml")!.async("string")));
  });
});

describe("a stored 0.2.0-shaped report", () => {
  const FILE = "stored-report.json";
  it("has none of the Release B fields and renders to every format", async () => {
    if (UPDATE) golden(FILE, JSON.stringify(await fixtureReport(), null, 1));
    const raw = readFileSync(join(DIR, FILE), "utf8");
    const report = JSON.parse(raw) as TemplateReport;
    expect(report.template).not.toHaveProperty("cover");
    expect(report.template).not.toHaveProperty("contents");
    expect(report.sections.some((s) => "pageBreakBefore" in s)).toBe(false);
    const doc = buildReportDoc(report, { version: "0.2.0" });
    expect(toMarkdown(doc)).toContain("# ");
    expect(toHtml(doc)).toContain("<html");
    expect((await toDocx(doc)).subarray(0, 2).toString()).toBe("PK");
    // The same output as rendering the live report: the stored JSON round trip loses nothing.
    expect(toMarkdown(doc)).toBe(toMarkdown(buildReportDoc(await fixtureReport(), { version: "0.2.0" })));
  });

  it("survives the report store round trip", async () => {
    const report = await fixtureReport();
    storeReport(report);
    expect(getStoredReport(report.reportId).template).toEqual(report.template);
  });
});
