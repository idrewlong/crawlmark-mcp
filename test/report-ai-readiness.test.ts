/**
 * The ai_readiness template section (free, local: reads the newest saved audit's site hygiene, never
 * fetches): schema, runTemplate (unavailable cases), and rendering in all four formats with Stage A's
 * escaping. llms.txt content is untrusted: no link or raw Markdown from it reaches a file.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { analyzeAiCrawlers } from "../src/analysis/ai-crawlers.js";
import type { StoredAudit } from "../src/analysis/diff.js";
import { analyzeRobots, type SiteHygiene } from "../src/analysis/hygiene.js";
import { exportReport } from "../src/reports/export.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const today = new Date("2026-10-13T12:00:00Z");
const TEMPLATE = `version: 1
templates:
  ai:
    title: AI readiness
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: ai, type: ai_readiness }
`;
function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-ai-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}

const robotsText = "User-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nDisallow: /pricing\n";
const fetched = { status: 200, contentType: "text/plain", text: robotsText };
const robots = analyzeRobots("https://example.com/robots.txt", fetched, ["https://example.com/pricing"]);
const ai = analyzeAiCrawlers("https://example.com/robots.txt", robots.file, robots.robots, "https://example.com/", ["https://example.com/pricing"]);
const HOSTILE_TITLE = "Evil <script>alert(1)</script> [click](https://evil.example/x) \u202Egnp";

const hygiene = (over: Partial<SiteHygiene> = {}): SiteHygiene =>
  ({
    origin: "https://example.com",
    robots: robots.robots,
    flags: [...ai.flags, { rule: "llms-txt-broken-link", url: "https://example.com/gone|x", severity: "low", title: "t", evidence: "HTTP 404" }],
    checked: [],
    notes: [],
    llmsTxt: {
      llmsTxt: {
        url: "https://example.com/llms.txt",
        present: true,
        status: 200,
        contentType: "text/markdown",
        bytes: 2048,
        truncated: false,
        format: { title: HOSTILE_TITLE, hasSummary: true, sections: [{ name: "Docs", links: 2 }], sectionCount: 1, hasOptionalSection: false, linkCount: 2, nonLinkItems: 1, notesStyle: { colon: 1, dash: 1, none: 0, other: 0 }, issues: ["There are 2 H1 headings; the proposal has one title."] },
      },
      llmsFullTxt: { url: "https://example.com/llms-full.txt", present: false, status: 404, contentType: "text/html", bytes: 10, truncated: false },
      links: { total: 2, sameHost: 2, sampled: [{ url: "https://example.com/ok", status: 200, finalUrl: "https://example.com/ok" }, { url: "https://example.com/gone|x", status: 404, finalUrl: "https://example.com/gone|x" }], errors: [] },
    },
    aiCrawlers: ai.aiCrawlers,
    ...over,
  }) as SiteHygiene;

const auditWith = (h: SiteHygiene | null): StoredAudit => ({
  id: "aud_fixture",
  client: "example.com",
  ranAt: Date.UTC(2026, 9, 1),
  settings: {},
  summary: {},
  findings: [],
  checked: [],
  result: { site: { hygiene: h ? { ok: true, data: h } : { ok: false, error: "x" } } },
});

describe("ai_readiness section", () => {
  it("validates; unknown fields are errors", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    expect(validateTemplateText(TEMPLATE.replace("type: ai_readiness }", "type: ai_readiness, fetch: true }"), { today }).valid).toBe(false);
  });

  it("is unavailable without a saved audit, without hygiene, or for an audit from before these checks", async () => {
    const reason = async (latest: StoredAudit | undefined) =>
      (await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [] }, fakeDeps({ latestAudit: () => latest }))).sections.find((s) => s.id === "ai");
    expect(await reason(undefined)).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no saved audit/) });
    expect(await reason(auditWith(null))).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/no site hygiene/) });
    const old = hygiene();
    delete old.llmsTxt;
    delete old.aiCrawlers;
    expect(await reason(auditWith(old))).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/run run_audit again/) });
  });

  it("summarises the newest audit and renders it inertly in every format", async () => {
    const latest = vi.fn(() => auditWith(hygiene()));
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [] }, fakeDeps({ latestAudit: latest }));
    expect(latest).toHaveBeenCalledWith("example.com");
    const s = report.sections.find((x) => x.id === "ai")!;
    expect(s).toMatchObject({
      status: "ok",
      title: "AI readiness",
      data: {
        auditId: "aud_fixture",
        llmsTxt: { checked: true, present: true, links: 2, linksChecked: 2, brokenLinks: [{ url: "https://example.com/gone|x", status: 404 }], full: { present: false, status: 404 } },
        crawlers: { checked: true, robotsFound: true, keyPages: 1 },
      },
    });
    // Control characters are gone from the stored title.
    expect(JSON.stringify(s)).not.toContain("\u202E");

    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-ai-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("Training only");
      expect(text).toContain("Blocked (whole site)");
      expect(text).toContain("Partly blocked");
      expect(text).toContain("OAI-SearchBot (OpenAI)");
      expect(text).toContain("Other key pages blocked");
      expect(text).toContain("Google says Google Search doesn");
      expect(text).toContain("llms-full.txt");
    }
    expect(md).toContain("AI readiness: robots.txt and llms.txt");
    // The untrusted title never becomes a link, a tag or raw Markdown.
    for (const text of [html, pdfHtml]) {
      expect(text).not.toContain("<script>alert(1)");
      expect(text).not.toContain('href="https://evil.example');
    }
    // Link-like data is a Markdown code span, so neither the tag nor the link is live.
    expect(md).toContain("| Title (H1) | `Evil <script>alert(1)</script> [click](https://evil.example/x) gnp` |");
    // URLs from the data are code, never links; the | is escaped in the Markdown table.
    expect(md).toContain("`https://example.com/gone\\|x`");
    expect(html).not.toContain('href="https://example.com/gone');
  });

  it("shows a missing llms.txt and an unreadable robots.txt plainly", async () => {
    const h = hygiene({
      llmsTxt: { llmsTxt: { url: "https://example.com/llms.txt", present: false, status: 404, contentType: null, bytes: 0, truncated: false }, llmsFullTxt: { url: "https://example.com/llms-full.txt", error: "HTTP 500" } },
      aiCrawlers: { error: "robots.txt returned HTTP 503" },
    });
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ai", include: [] }, fakeDeps({ latestAudit: () => auditWith(h) }));
    const out = await exportReport(report, { formats: ["md"], reportsDir: join(mkdtempSync(join(tmpdir(), "crawlmark-ai-out-")), "reports"), branding: {}, version: "0.1.0", printer: vi.fn() });
    const md = readFileSync(out.files[0]!.path, "utf8");
    expect(md).toContain("No llms.txt at `https://example.com/llms.txt` (HTTP 404).");
    expect(md).toContain("AI crawler access couldn't be checked in that audit");
  });
});
