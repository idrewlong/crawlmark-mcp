/**
 * Phase 12 B-5: the rank_trend (free, local) and keyword_gap (paid) template sections: schema rules,
 * runTemplate (optional, skipped without allowPaid, one pre-flight estimate before any paid request),
 * and rendering in all four formats with Stage A's escaping (stripControl, Markdown block markers,
 * HTML entities, valid DOCX XML). Fixture sources only; no network, no Chrome.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { summarizeRanks } from "../src/analysis/ranks.js";
import { BudgetExceededError } from "../src/lib/budget.js";
import type { EstimateResult, KeywordGapRouted } from "../src/providers/seo-data.js";
import { exportReport } from "../src/reports/export.js";
import { BUILTIN_MONTHLY } from "../src/reports/templates/builtin.js";
import { validateTemplateText } from "../src/reports/templates/schema.js";
import type { RunDeps } from "../src/reports/templates/run.js";
import { fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const today = new Date("2026-10-13T12:00:00Z");
const XSS = "<img src=x onerror=alert(1)>";
const BIDI = "\u202e";

function homeWith(yaml: string): string {
  const home = mkdtempSync(join(tmpdir(), "crawlmark-b5-"));
  mkdirSync(join(home, "config"), { recursive: true });
  writeFileSync(join(home, "config", "report-templates.yaml"), yaml);
  return home;
}
const TEMPLATE = `version: 1
templates:
  ranks:
    title: Rank review
    period: { range: last_month }
    sections:
      - { id: search, type: search_overview }
      - { id: trend, type: rank_trend, since: 90d }
      - { id: gap, type: keyword_gap, paid: true, limit: 25, competitors: [competitor-a.example] }
`;

const GAP: KeywordGapRouted = {
  provider: "semrush",
  gaps: [
    { keyword: `# ${XSS} | pipes`, volume: 1900, difficulty: { metric: "semrush_kd", value: 41 }, competitors: [{ domain: "competitor-a.example", position: 3, url: null }], clientPosition: null, clientCheck: "provider" },
    { keyword: `drain ${BIDI}cleaning`, volume: 880, difficulty: { metric: "semrush_kd", value: null }, competitors: [{ domain: "competitor-a.example", position: 8, url: null }], clientPosition: null, clientCheck: "provider" },
  ],
  perCompetitor: [{ domain: "competitor-a.example", returned: 2 }],
  costUsd: 0,
  units: 160,
  fromCache: false,
};
const estimate = (o: Partial<EstimateResult> = {}): EstimateResult => ({
  estimateOnly: true,
  provider: "semrush",
  estimate: { provider: "semrush", requests: 1, usd: 0, units: 2000, breakdown: "1 competitor(s) × domain_domains 25 lines × 80 units", cached: false },
  remaining: { unit: "units", client: 5000, global: 20000 },
  wouldExceed: false,
  message: "ok",
  ...o,
});

function rankDeps(over: Partial<RunDeps> = {}, log: string[] = []): RunDeps {
  return fakeDeps({
    rankHistory: (c, o) => {
      log.push(`history:${o.since}..${o.until}:${o.source}`);
      return {
        client: c.slug, since: o.since!, until: o.until!, source: o.source ?? "both", note: "",
        keywords: [
          { keyword: "emergency plumber", tracked: true, series: {}, summary: { gsc: summarizeRanks([{ day: "2026-07-05", rank: 8.4 }, { day: "2026-09-27", rank: 5.1 }]), serp: summarizeRanks([{ day: "2026-09-28", rank: null }]) } },
          { keyword: `${XSS} ${BIDI}`, tracked: true, series: {}, summary: { gsc: summarizeRanks([{ day: "2026-09-27", rank: 12 }]), serp: summarizeRanks([]) } },
        ],
      };
    },
    keywordGap: async (_c, req, o) => {
      log.push(o.estimateOnly ? `estimate:${req.limit}` : `gap:${req.competitors.join(",")}:${req.limit}`);
      return o.estimateOnly ? estimate() : GAP;
    },
    ...over,
  });
}

describe("template schema", () => {
  it("accepts rank_trend and a paid keyword_gap; keyword_gap without paid: true and unknown fields are errors", () => {
    expect(validateTemplateText(TEMPLATE, { today })).toMatchObject({ valid: true });
    const noPaid = validateTemplateText(TEMPLATE.replace("paid: true, ", ""), { today });
    expect(noPaid.errors).toContainEqual({ path: "templates.ranks.sections[2].paid", message: "keyword_gap is paid, so the section must set paid: true" });
    const bad = validateTemplateText(TEMPLATE.replace("since: 90d", "since: 30d, depth: 3"), { today });
    expect(bad.valid).toBe(false);
    expect(bad.errors.map((e) => e.path)).toEqual(expect.arrayContaining(["templates.ranks.sections[1].depth"]));
  });

  it("the builtin monthly has rank trends as an optional section only", () => {
    expect(BUILTIN_MONTHLY.sections.find((s) => s.type === "rank_trend")).toEqual({ id: "ranks", type: "rank_trend", optional: true, since: "180d" });
    expect(BUILTIN_MONTHLY.sections.some((s) => s.type === "keyword_gap")).toBe(false);
  });
});

describe("runTemplate with rank sections", () => {
  it("rank_trend is optional in the builtin monthly and reads the store up to the period end", async () => {
    const log: string[] = [];
    const plain = await fixtureReport({}, rankDeps({}, log));
    expect(plain.sections.some((s) => s.type === "rank_trend")).toBe(false);
    const r = await fixtureReport({ include: ["ranks"] }, rankDeps({}, log));
    expect(log).toEqual(["history:2026-04-03..2026-09-30:both"]);
    expect(r.sections.find((s) => s.id === "ranks")).toMatchObject({ status: "ok", data: { since: "2026-04-03", until: "2026-09-30", keywords: [{ keyword: "emergency plumber", gsc: { first: 8.4, latest: 5.1, change: -3.3 } }, expect.anything()] } });
  });

  it("rank_trend without stored rows is unavailable with the check-ranks hint", async () => {
    const r = await fixtureReport({ include: ["ranks"] });
    expect(r.sections.find((s) => s.id === "ranks")).toMatchObject({ status: "unavailable", reason: expect.stringMatching(/run crawlmark-cli check-ranks/) });
  });

  it("keyword_gap is skipped without allowPaid and makes no call", async () => {
    const log: string[] = [];
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ranks", include: [] }, rankDeps({}, log));
    expect(r.sections.find((s) => s.id === "gap")).toMatchObject({ status: "skipped" });
    expect(log.some((l) => l.startsWith("estimate") || l.startsWith("gap"))).toBe(false);
  });

  it("with allowPaid: one estimate before the paid request; refused before any request when it doesn't fit", async () => {
    const log: string[] = [];
    const r = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ranks", include: [], allowPaid: true }, rankDeps({}, log));
    expect(log.filter((l) => !l.startsWith("history"))).toEqual(["estimate:25", "gap:competitor-a.example:25"]);
    expect(r.sections.find((s) => s.id === "gap")).toMatchObject({ status: "ok", data: { provider: "semrush", limit: 25, competitors: ["competitor-a.example"] } });

    const log2: string[] = [];
    const over = rankDeps({ keywordGap: async (_c, _r, o) => (log2.push(o.estimateOnly ? "estimate" : "gap"), estimate({ wouldExceed: true, message: "That needs 2,000 units of Semrush but example.com has 100 units left this month. Use limit 1 (80 units), or raise monthlyUnits.semrush." })) });
    await expect(fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ranks", include: [], allowPaid: true }, over)).rejects.toBeInstanceOf(BudgetExceededError);
    expect(log2).toEqual(["estimate"]);
  });
});

describe("rendering the rank sections", () => {
  it("md, html, docx and the PDF's HTML show the trend and the gap with untrusted text made inert", async () => {
    const report = await fixtureReport({ homeDir: homeWith(TEMPLATE), template: "ranks", include: [], allowPaid: true }, rankDeps());
    const printer = vi.fn(async () => Buffer.from("%PDF-1.7"));
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-b5-out-")), "reports");
    const out = await exportReport(report, { formats: ["md", "html", "docx", "pdf"], reportsDir: dir, branding: {}, version: "0.1.0", printer });
    expect(out.files.map((f) => f.format)).toEqual(["md", "html", "docx", "pdf"]);
    const md = readFileSync(out.files[0]!.path, "utf8");
    const html = readFileSync(out.files[1]!.path, "utf8");
    const docXml = await (await JSZip.loadAsync(readFileSync(out.files[2]!.path))).file("word/document.xml")!.async("string");
    const pdfHtml = String((printer.mock.calls[0] as unknown as [string])[0]);

    // Content: the trend first → latest with "lower is better", the gap with the provider's labelled difficulty.
    for (const text of [md, html, docXml, pdfHtml]) {
      expect(text).toContain("8.4 → 5.1");
      expect(text).toContain("Semrush KD");
      expect(text).toContain("competitor-a.example (3)");
      expect(text).not.toContain(BIDI);
    }
    expect(md).toContain("Tracked keyword rank trends");
    expect(md).toContain("Rank trends: crawlmark's stored rank checks");
    // Markdown: no raw HTML, and the | escaped inside the table cell (a # inside a cell can't start a heading).
    expect(md).not.toMatch(/(?<!\\)<img/);
    expect(md).toContain("| # \\<img src=x onerror=alert(1)\\> \\| pipes | 1,900 | 41 | competitor-a.example (3) |");
    // HTML: entities, no live tag.
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(pdfHtml).not.toContain("<img src=x");
    // DOCX: the XML parses and the text is escaped.
    expect(docXml).not.toContain("<img");
    expect(docXml).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });
});
