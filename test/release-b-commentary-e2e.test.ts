/**
 * Release B5.3: commentary end to end. The real parser and the real renderers (no mocks): a sub-heading, a numbered
 * list, a table and a `{{chart search 1}}` reference come out in md, html and docx; an unresolvable chart reference
 * is a warning in the result; client text that names an internal term is refused with nothing written, and passes
 * with allowTerms.
 */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { ClientTextLintError, exportReport } from "../src/reports/export.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const tmp = () => mkdtempSync(join(tmpdir(), "crawlmark-b5-"));
const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
const opts = (dir: string, extra = {}) => ({ formats: ["md", "html", "docx"] as ("md" | "html" | "docx")[], reportsDir: dir, branding: {}, version: "0.3.0", printer, ...extra });

const COMMENTARY = [
  "#### Where the gain came from",
  "",
  "1. Service pages gained the most clicks.",
  "2. Branded searches stayed flat.",
  "",
  "| Page | Change |",
  "| --- | ---: |",
  "| /services/emergency | +12% |",
  "",
  "{{chart search 1}}",
].join("\n");

const charts = (zip: JSZip) => Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).length;

describe("commentary, end to end", () => {
  it("renders a sub-heading, a numbered list, a table and a chart reference in md, html and docx", async () => {
    const report = await fixtureReport();
    const base = await exportReport(report, opts(join(tmp(), "base")));
    const baseZip = await JSZip.loadAsync(readFileSync(base.files.find((f) => f.format === "docx")!.path));

    const dir = join(tmp(), "reports");
    const res = await exportReport(report, opts(dir, { narrative: { sections: { search: COMMENTARY } } }));
    expect(res.warnings.filter((w) => /chart/.test(w))).toEqual([]);
    const file = (format: string) => res.files.find((f) => f.format === format)!.path;

    const md = readFileSync(file("md"), "utf8");
    expect(md).toContain("Where the gain came from");
    expect(md).toContain("1. Service pages gained the most clicks.");
    expect(md).toContain("2. Branded searches stayed flat.");
    expect(md).toMatch(/\| Page\s*\| Change\s*\|/);
    expect(md).toContain("/services/emergency");
    expect(md).not.toContain("{{chart");

    const html = readFileSync(file("html"), "utf8");
    expect(html).toMatch(/<h[345][^>]*>Where the gain came from<\/h[345]>/);
    expect(html).toMatch(/<ol[^>]*>\s*<li>Service pages gained the most clicks\./);
    expect(html).toContain("<th");
    expect(html).toContain("/services/emergency");
    expect(html).not.toContain("{{chart");

    const zip = await JSZip.loadAsync(readFileSync(file("docx")));
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("Where the gain came from");
    expect(document).toContain('w:val="Heading4"');
    expect(document).toContain("<w:numPr>");
    expect(document).toContain("/services/emergency");
    expect(document).not.toContain("{{chart");
    // The reference repeats the search chart: one more native chart than without commentary.
    expect(charts(zip)).toBe(charts(baseZip) + 1);
  });

  it("an unknown chart number is dropped with a warning in the result; an unknown section id is refused before anything is written", async () => {
    const report = await fixtureReport();
    const res = await exportReport(report, opts(join(tmp(), "reports"), { narrative: { sections: { search: "Intro.\n\n{{chart search 9}}" } } }));
    expect(res.warnings).toContain("narrative.sections.search: {{chart search 9}} has no chart to show; left out.");
    for (const f of res.files) expect(readFileSync(f.path).toString("latin1")).not.toContain("{{chart");

    const dir = join(tmp(), "reports");
    await expect(exportReport(report, opts(dir, { narrative: { summary: "{{chart nope}}" } }))).rejects.toThrow(/narrative\.summary.*nope/);
    expect(existsSync(dir)).toBe(false);
  });

  it("client text that names DataForSEO is refused with its hits and nothing written; allowTerms lets it through", async () => {
    const report = await fixtureReport();
    const narrative = { sections: { search: "Rankings came from DataForSEO this month." } };
    const dir = join(tmp(), "reports");
    const err = await exportReport(report, opts(dir, { narrative })).then(() => Promise.reject(new Error("expected a refusal")), (e: unknown) => e as ClientTextLintError);
    expect(err).toBeInstanceOf(ClientTextLintError);
    expect(err.hits).toEqual([expect.objectContaining({ where: "sections.search", term: "DataForSEO" })]);
    expect(err.hits[0]!.snippet).toContain("DataForSEO");
    expect(existsSync(dir)).toBe(false);

    const ok = await exportReport(report, opts(dir, { narrative, allowTerms: ["DataForSEO"] }));
    expect(ok.files.length).toBe(3);
    expect(readFileSync(ok.files.find((f) => f.format === "md")!.path, "utf8")).toContain("Rankings came from DataForSEO this month.");
  });
});
