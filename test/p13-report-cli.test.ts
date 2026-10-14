/**
 * Phase 13 A Done-when: `crawlmark-cli report --client example.com --template technical --include issues,indexing
 * --format html,docx` writes both new sections, and the HTML carries no operator-only detail (units, quota, spend,
 * the Search Console property, snapshot IDs, provider error text). Fixture data; no network, no Chrome.
 */
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { reportCommand } from "../src/report-cli.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { INDEXING, TECH_ISSUES } from "./fixtures/reports/p13-data.js";

describe("report --template technical --include issues,indexing", () => {
  it("writes HTML and DOCX with both sections and nothing operator-only", async () => {
    const home = mkdtempSync(join(tmpdir(), "crawlmark-p13-cli-"));
    const lines: string[] = [];
    const deps = fakeDeps({
      technicalIssues: async () => ({ ...TECH_ISSUES, unavailable: [{ source: "dataforseo_crawl", reason: "DataForSEO said: 40100 Not Authorized (raw provider error)" }], snapshotId: "iss_01JSNAPSHOT000000000000000" }),
      indexingSection: async () => ({ ...INDEXING, notes: ["Google's daily URL Inspection quota for this property is used up; stored results were used."] }),
    });
    const code = await reportCommand(
      [],
      { client: "example.com", template: "technical", include: "issues,indexing", format: "html,docx", month: "2026-09", paid: false, all: false, "dry-run": false },
      { out: (l = "") => void lines.push(l), warn: () => undefined, homeDir: home, cwd: home, today: new Date("2026-10-13T12:00:00Z") },
      { loadClients: async () => ({ clients: [client], skipped: [] }), runDeps: async () => deps, printer: vi.fn() as never, reportsDir: join(home, "reports"), version: "0.1.0" },
    );
    expect(code).toBe(0);
    const out = JSON.parse(lines.join("\n"));
    const files = out.results[0].files as { format: string; path: string }[];
    expect(files.map((f) => f.format)).toEqual(["html", "docx"]);
    const html = readFileSync(files[0]!.path, "utf8");
    expect(html).toContain("<h2>Technical SEO issues</h2>");
    expect(html).toContain("<h2>Google indexing</h2>");
    for (const bad of ["units", "quota", "$", "sc-domain:", "iss_", "40100", "Not Authorized", "raw provider error"]) expect(html, bad).not.toContain(bad);
    const xml = await (await JSZip.loadAsync(readFileSync(files[1]!.path))).file("word/document.xml")!.async("string");
    expect(xml).toContain("Technical SEO issues");
    expect(xml).toContain("Google indexing");
    for (const bad of ["quota", "$", "sc-domain:", "iss_", "40100"]) expect(xml, bad).not.toContain(bad);
  });
});
