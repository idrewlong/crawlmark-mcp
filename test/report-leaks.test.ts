/** SEC-1: client-facing files never carry raw provider error text or absolute local paths. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { exportReport } from "../src/reports/export.js";
import { fakeDeps, GTM_OK } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const SECRET_PATH = "/Users/someone/.crawlmark/data/google-token.json";
const RAW = `invalid_grant: token has been expired or revoked (${SECRET_PATH})`;

describe("raw errors and local paths stay out of report files", () => {
  it("md, html, docx and the HTML sent to the PDF printer contain neither; the tool result keeps them", async () => {
    const boom = async () => {
      throw new Error(RAW);
    };
    const deps = fakeDeps({
      ga4OrganicSummary: boom,
      gscTotals: async (c, r) => (r.startDate === "2025-09-01" ? boom() : (await import("./fixtures/reports/data.js")).gscTotals(c, r)),
      runGtmAudit: async () => ({ ...GTM_OK, notes: [`Unpublished changes incomplete: workspace 3: ${RAW}`] }) as never,
    });
    const report = await fixtureReport({}, deps);
    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-leaks-")), "reports");
    const out = await exportReport(report, {
      formats: ["md", "html", "docx", "pdf"],
      reportsDir: dir,
      branding: { logo: { path: "/Users/someone/agency/brand/logo.png", resolved: "/Users/someone/agency/brand/logo.png", exists: false } },
      version: "0.1.0",
      printer,
    });
    const files = [
      readFileSync(out.files.find((f) => f.format === "md")!.path, "utf8"),
      readFileSync(out.files.find((f) => f.format === "html")!.path, "utf8"),
      await (await JSZip.loadAsync(readFileSync(out.files.find((f) => f.format === "docx")!.path))).file("word/document.xml")!.async("string"),
      String((printer.mock.calls[0] as unknown as [string])[0]),
    ];
    for (const text of files) {
      expect(text).not.toContain("/Users/someone");
      expect(text).not.toContain("invalid_grant");
    }
    expect(files[0]).toContain("Organic traffic (GA4): couldn't be fetched for this report.");
    expect(files[0]).toContain("the previous year comparison couldn't be fetched.");
    // The missing logo is an operator warning (export result), not a line in the client's file.
    expect(out.warnings.join(" ")).toMatch(/Logo .*logo\.png doesn't exist/);
    for (const text of files) expect(text).not.toContain("logo.png");
    expect(files[0]).toContain("Unpublished changes: some workspaces couldn't be read.");
    // The tool / CLI result keeps the detail.
    expect(out.sectionErrors).toContainEqual({ id: "traffic", error: RAW });
    const search = report.sections.find((s) => s.id === "search") as { data: { comparisonErrors?: Record<string, string> } };
    expect(search.data.comparisonErrors).toEqual({ previous_year: RAW });
  });

  it("the invalid-template-file warning reaches export warnings but no rendered format (R-3)", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-leaks-tpl-"));
    mkdirSync(join(home, "config"), { recursive: true });
    writeFileSync(join(home, "config", "report-templates.yaml"), "version: 1\ntemplates: { monthly: { title: M, sections: [{ id: a, type: bogus }] } }\n");
    const report = await fixtureReport({ homeDir: home });
    expect(report.warnings?.[0]).toMatch(/^Template file report-templates\.yaml/);
    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], inline: "html", reportsDir: join(home, "reports"), branding: {}, version: "0.1.0", printer });
    expect(out.warnings).toEqual(report.warnings);
    const rendered = [
      readFileSync(out.files.find((f) => f.format === "md")!.path, "utf8"),
      readFileSync(out.files.find((f) => f.format === "html")!.path, "utf8"),
      await (await JSZip.loadAsync(readFileSync(out.files.find((f) => f.format === "docx")!.path))).file("word/document.xml")!.async("string"),
      String((printer.mock.calls[0] as unknown as [string])[0]),
      out.inline!.content,
    ];
    for (const text of rendered) {
      expect(text).not.toContain("report-templates.yaml");
      expect(text).not.toContain("Template file");
      expect(text).not.toContain("validate_report_template");
    }
  });
});
