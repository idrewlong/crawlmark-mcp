/**
 * Phase 12 C1: the site_crawl template section (free, local: summarises the newest saved crawl,
 * never starts one): schema, runTemplate, and rendering in all four formats with Stage A's escaping.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { CrawlPage } from "../src/analysis/crawl.js";
import type { StoredCrawl } from "../src/lib/crawls.js";
import { exportReport } from "../src/reports/export.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const today = new Date("2026-10-13T12:00:00Z");
const TEMPLATE = `version: 1
templates:
  crawl:
    title: Site health
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: site, type: site_crawl, limit: 5 }
`;
function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-c1-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}
const page = (url: string, o: Partial<CrawlPage> = {}): CrawlPage => ({ url, depth: 1, status: 200, finalUrl: url, finalStatus: 200, redirectChain: [], contentType: "text/html", title: "T", description: "D", canonical: null, robots: null, noindex: false, h1Count: 1, inlinks: 1, outlinks: 1, firstLinkedFrom: "https://example.com/", parsed: true, issues: [], ...o });
const CRAWL: StoredCrawl = {
  id: "crawl_fixture",
  client: "example.com",
  ranAt: Date.UTC(2026, 9, 2),
  settings: {},
  summary: { orphans: { available: true, count: 3, urls: [] } },
  exhaustive: true,
  pages: [
    page("https://example.com/", { depth: 0, title: "Home" }),
    page("https://example.com/a|b*c_[x]", { title: null }),
    page("https://example.com/gone", { status: 404, finalStatus: 404, title: null, description: null, parsed: false }),
  ],
};

describe("site_crawl section", () => {
  it("validates; unknown fields and a too-large limit are errors", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "limit: 51"), { today }).valid).toBe(false);
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "start: true"), { today }).errors.map((e) => e.path)).toContain("templates.crawl.sections[1].start");
  });

  it("is unavailable, with the free CLI hint, when no crawl is saved", async () => {
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "crawl", include: [] });
    expect(r.sections.find((s) => s.id === "site")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/run crawlmark-cli crawl, free/) });
  });

  it("summarises the newest saved crawl and renders it inertly in every format", async () => {
    const latest = vi.fn(() => CRAWL);
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "crawl", include: [] }, fakeDeps({ latestLocalCrawl: latest }));
    expect(latest).toHaveBeenCalledWith("example.com");
    const s = report.sections.find((x) => x.id === "site")!;
    expect(s).toMatchObject({ status: "ok", title: "Site crawl", data: { crawlId: "crawl_fixture", pages: 3, exhaustive: true, limit: 5, summary: { brokenLinks: 1, missingTitles: 1, orphans: { available: true, count: 3 } } } });

    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c1-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("Broken internal links");
      expect(text).toContain("Orphan pages (in a sitemap, not linked)");
      expect(text).toContain("own crawl of the site on 2026-10-02");
    }
    expect(md).toContain("Site crawl: crawlmark's own crawl of the site");
    // URLs from the crawl are code, never links; the | is escaped in the Markdown table.
    expect(md).toContain("`https://example.com/a\\|b*c_[x]`");
    expect(html).not.toContain('href="https://example.com/a');
  });

  it("passes the crawl's own orphan reason through, without error detail (R-4)", async () => {
    const crawl = { ...CRAWL, summary: { orphans: { available: false, reason: "not available: the sitemaps could not be read (HTTP 500 at /private/path)" } } };
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "crawl", include: [] }, fakeDeps({ latestLocalCrawl: () => crawl }));
    expect(report.sections.find((x) => x.id === "site")).toMatchObject({ data: { summary: { orphans: { available: false, reason: "the sitemaps could not be read" } } } });
  });
});
