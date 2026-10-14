/**
 * Phase 12 C3: the bing_overview template section (free with the user's Bing key): schema, runTemplate through
 * the real provider (stubbed fetch, fixtures), and rendering in all four formats with Stage A's escaping.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { bingOverview } from "../src/providers/bing.js";
import { exportReport } from "../src/reports/export.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const KEY = "SENTINEL-bing-report-key-55555";
const today = new Date("2026-10-13T12:00:00Z");
const TEMPLATE = `version: 1
templates:
  bing:
    title: Bing
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: bing, type: bing_overview, limit: 5 }
`;
function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-c3-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}
const FIX = join(import.meta.dirname, "fixtures", "bing");
const FILES: Record<string, string> = {
  GetUserSites: "user-sites.json",
  GetRankAndTrafficStats: "traffic.json",
  GetQueryStats: "query-stats.json",
  GetPageStats: "page-stats.json",
  GetCrawlStats: "crawl-stats.json",
  GetCrawlIssues: "crawl-issues.json",
};
const fetchImpl = (async (u: string) => new Response(readFileSync(join(FIX, FILES[new URL(u).pathname.split("/").pop()!]!), "utf8"))) as unknown as typeof fetch;

describe("bing_overview section", () => {
  it("validates; unknown fields and a too-large limit are errors; it is free", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "limit: 26"), { today }).valid).toBe(false);
    expect(validateTemplateText(TEMPLATE.replace("limit: 5", "submit: true"), { today }).errors.map((e) => e.path)).toContain("templates.bing.sections[1].submit");
  });

  it("is unavailable with the setup step when there is no key", async () => {
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "bing", include: [] });
    expect(r.sections.find((s) => s.id === "bing")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/BING_WEBMASTER_API_KEY.*setup --step bing/) });
  });

  it("a client without a verified site is unavailable, and the reason doesn't list the key's other sites", async () => {
    const deps = fakeDeps({ bingOverview: (_c, req) => bingOverview({ domain: "example.edu" }, req, { key: KEY, fetchImpl, refresh: true }) });
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "bing", include: [] }, deps);
    const s = r.sections.find((x) => x.id === "bing")!;
    expect(s).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no verified Bing Webmaster Tools site for example\.com.*--bing-site/) });
    expect(JSON.stringify(s)).not.toMatch(/example\.net|example\.org/);
  });

  it("reads the report period and its comparison, and renders inertly in every format without the key", async () => {
    const spy = vi.fn((c: { domain: string }, req: Parameters<typeof bingOverview>[1]) => bingOverview(c, req, { key: KEY, fetchImpl, refresh: true }));
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "bing", include: [] }, fakeDeps({ bingOverview: spy }));
    expect(spy.mock.calls[0]![1]).toEqual({ window: { startDate: "2026-09-01", endDate: "2026-09-30" }, compare: { which: "previous_period", range: { startDate: "2026-08-01", endDate: "2026-08-31" } }, limit: 5 });
    const s = report.sections.find((x) => x.id === "bing")!;
    expect(s).toMatchObject({
      status: "ok",
      title: "Bing search performance",
      data: { site: "https://www.example.com/", totals: { clicks: 390, impressions: 3360 }, previous: { clicks: 200, impressions: 2000 }, crawl: { issueCount: 3 } },
    });
    const data = (s as { data: { topQueries: { query: string }[]; notes: string[] } }).data;
    expect(data.topQueries.map((q) => q.query)).toEqual(["emergency plumber", "drain cleaning"]);
    expect(data.notes.join(" ")).toMatch(/previous period .* is partly missing/);

    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c3-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("Bing Webmaster Tools data for");
      expect(text).toContain("emergency plumber");
      expect(text).toContain("pages in Bing");
      expect(text).not.toContain(KEY);
    }
    expect(md).toContain("Bing: Bing Webmaster Tools (free, read-only)");
    expect(md).toContain("`https://www.example.com/`");
    expect(html).not.toContain('href="https://www.example.com/');
  });

  it("a comparison Bing has no data for is left out (no zeros, no n/a column), with the note (R-1)", async () => {
    const yearly = TEMPLATE.replace("period: { range: last_month }", "period: { range: last_month }\n    compare: [previous_year]");
    const report = await fixtureReport({ homeDir: homeWith(yearly), template: "bing", include: [] }, fakeDeps({ bingOverview: (c, req) => bingOverview(c, req, { key: KEY, fetchImpl, refresh: true }) }));
    const s = report.sections.find((x) => x.id === "bing") as { status: string; data: { previous: unknown; comparedWith: { which: string }; totals: { change: unknown } } };
    expect(s.status).toBe("ok");
    expect(s.data.comparedWith.which).toBe("previous_year");
    expect(s.data.previous).toBeNull();
    expect(s.data.totals.change).toEqual({ clicks: null, impressions: null, ctr: null });
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c3-na-")), "reports");
    const out = await exportReport(report, { formats: ["md"], reportsDir: dir, branding: {}, version: "0.1.0", printer: async () => Buffer.from("") });
    const md = readFileSync(out.files[0]!.path, "utf8");
    // Redesign: a comparison column without data is dropped; Bing's own note says why.
    expect(md).toContain("| Metric | This period |");
    expect(md).toContain("| Clicks | 390 |");
    expect(md).toContain("| CTR | 11.61% |");
    expect(md).not.toContain("| Clicks | 390 | n/a");
    expect(md).not.toMatch(/\| Clicks \| 390 \| 0 \|/);
    expect(md).toMatch(/Bing returned no traffic for the previous year/);
  });

  it("untrusted query text is escaped in HTML and Markdown", async () => {
    const evil = { site: "https://www.example.com/", window: { startDate: "2026-09-01", endDate: "2026-09-30" }, comparedWith: null, totals: { clicks: 1, impressions: 2, ctr: 50, change: { clicks: null, impressions: null, ctr: null } }, previous: null, topQueries: [{ query: "<script>alert(1)</script> | [x](https://evil.example)", clicks: 1, impressions: 2, avgPosition: 1 }], topPages: [{ page: "https://www.example.com/a|b", clicks: 1, impressions: 2, avgPosition: null }], crawl: { latest: null, issueCount: 0 }, limit: 5, notes: [] };
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "bing", include: [] }, fakeDeps({ bingOverview: async () => evil }));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-c3-esc-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html"], reportsDir: dir, branding: {}, version: "0.1.0", printer: async () => Buffer.from("") });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain('href="https://evil.example');
    // Link-like text is a code span in Markdown (never a link), with the table pipe escaped.
    expect(md).toContain("| `<script>alert(1)</script> \\| [x](https://evil.example)` |");
    expect(md).toContain("`https://www.example.com/a\\|b`");
  });
});
