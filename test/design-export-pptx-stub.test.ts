/**
 * Release 0.4.0 T0: the pptx branch is wired into export_report's pipeline but the writer is a stub. Asking for pptx
 * reports `PPTX not written: not built yet` in warnings and still writes the other formats. T3a replaces this file
 * with test/design-pptx-export.test.ts (delete this one when the writer lands).
 */
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { exportReport } from "../src/reports/export.js";
import { reportRelPath } from "../src/reports/paths.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const fakePdf = vi.fn(async () => Buffer.from("%PDF-1.7 fake"));

describe("exportReport with pptx while the writer is a stub", () => {
  it("warns and writes the other formats", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-pptx-stub-")), "reports");
    const out = await exportReport(await fixtureReport(), { formats: ["md", "pptx"], reportsDir: dir, branding: {}, version: "0.4.0", printer: fakePdf });
    expect(out.files.map((f) => f.format)).toEqual(["md"]);
    expect(out.warnings.some((w) => /^PPTX not written: .*not built yet/.test(w))).toBe(true);
  });

  it("only pptx: nothing is written and the error names the failure", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-pptx-stub-")), "reports");
    await expect(exportReport(await fixtureReport(), { formats: ["pptx"], reportsDir: dir, branding: {}, version: "0.4.0", printer: fakePdf })).rejects.toThrow(/PPTX not written: .*not built yet/);
    expect(existsSync(dir) ? readdirSync(dir, { recursive: true }) : []).toEqual([]);
  });

  it("the file extension is .pptx", () => {
    expect(reportRelPath("example.com", "2026-09", "monthly", { startDate: "2026-09-01", endDate: "2026-09-30" }, "pptx").file).toBe("monthly-2026-09.pptx");
  });

  it("the theme option reaches the PDF printer's footer font call without error", async () => {
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-pptx-stub-")), "reports");
    const out = await exportReport(await fixtureReport(), { formats: ["pdf"], reportsDir: dir, branding: {}, version: "0.4.0", printer: fakePdf, theme: "bold" });
    expect(out.files.map((f) => f.format)).toEqual(["pdf"]);
  });
});
