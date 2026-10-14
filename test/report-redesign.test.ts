/**
 * The agency-dashboard report layout: four key-figure cards with coloured changes, a summary box,
 * inline SVG charts (HTML/PDF), native charts (DOCX), small tables (Markdown, Google Docs copy),
 * hidden empty sections, dropped empty comparison columns, page paths, no operator content in the
 * files, the one-page executive layout, and branding colours that keep their contrast.
 * Fixture data only (example.com); no network, no Chrome.
 */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import { summarizeRanks } from "../src/analysis/ranks.js";
import { exportReport } from "../src/reports/export.js";
import { contrast, inkOn, textOn } from "../src/reports/render/color.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { CSP, toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import * as data from "./fixtures/reports/data.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const v = { version: "0.1.0" };
const svgs = (html: string) => html.match(/<svg class="chart-svg"[\s\S]*?<\/svg>/g) ?? [];
const XSS = "<img src=x onerror=alert(1)>";

describe("dashboard layout", () => {
  it("four key-figure cards with coloured change chips (position: lower is better), a summary box and inline SVG charts", async () => {
    const doc = buildReportDoc(await fixtureReport(), v);
    expect(doc.kpis.map((k) => k.label)).toEqual(["Clicks", "Impressions", "CTR", "Average position"]);
    expect(doc.kpis.map((k) => k.delta?.tone)).toEqual(["good", "good", "neutral", "good"]);
    expect(doc.kpis[3]).toMatchObject({ value: "7.5", delta: { dir: "down", text: "0.7 better" } });
    expect(doc.kpiCaption).toBe("Change vs August 2026 (previous period)");
    const html = toHtml(doc);
    expect(html.match(/<div class="kpi">/g)).toHaveLength(4);
    expect(html).toContain('<section class="summary" aria-label="Highlights">');
    // Charts: clicks and impressions per day, organic sessions per day, CrUX small multiples.
    const charts = svgs(html);
    expect(charts.length).toBeGreaterThanOrEqual(4);
    for (const svg of charts) {
      expect(svg).toMatch(/role="img" aria-label="[^"]+"/);
      expect(svg).not.toMatch(/\son[a-z]+=|href|<script|<image|<foreignObject/i);
    }
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    // Headings carry no numbers; tables are styled, numbers right-aligned.
    expect(html).toContain("<h2>Search performance</h2>");
    expect(html).not.toMatch(/<h2>\d+ /);
    expect(html).toMatch(/<td class="num">1,120<\/td>/);
  });

  it("page paths instead of full URLs in traffic sections; full URLs stay code where the section is about URLs", async () => {
    const md = toMarkdown(buildReportDoc(await fixtureReport(), v));
    expect(md).toContain("| /services/emergency | 200 | 5,100 |");
    expect(md).not.toContain("`https://example.com/services/emergency`");
    // The Core Web Vitals origin is a URL the section is about.
    expect(md).toContain("`https://example.com`");
  });

  it("no placeholders, no tool hints, no spend, no internal names in client files", async () => {
    const deps = fakeDeps({ monthlyAuditSection: () => null, spentThisMonth: vi.fn(() => 0.42) });
    const report = await fixtureReport({}, deps, { ...client, trackedKeywords: [] } as typeof client);
    const doc = buildReportDoc(report, v);
    const md = toMarkdown(doc);
    const html = toHtml(doc);
    const docXml = await (await JSZip.loadAsync(await toDocx(doc))).file("word/document.xml")!.async("string");
    for (const text of [md, html, docXml]) {
      expect(text).not.toMatch(/None\.|No tracked keywords|No audit comparison|crawlmark-cli|striking_distance|Paid data|DataForSEO \$|no data<|Fixture method/);
      expect(text).toContain("Not included this time (no data for this period): Tracked keywords, Changes since the last audit.");
    }
    expect(md).not.toContain("## Tracked keywords");
    expect(md).not.toContain("## Changes since the last audit");
  });

  it("a comparison with no data loses its column, with one note; no comparison at all leaves the chips out", async () => {
    const deps = fakeDeps({ gscTotals: async (c, r) => (r.startDate === "2025-09-01" ? { keys: [], clicks: 0, impressions: 0, ctr: 0, position: 0 } : data.gscTotals(c, r)) });
    const md = toMarkdown(buildReportDoc(await fixtureReport({}, deps), v));
    expect(md).toContain("| Metric | September 2026 | August 2026 | Change |\n");
    expect(md).not.toContain("| September 2025 |");
    expect(md.match(/Search Console has no data for September 2025, so that comparison is left out\./g)).toHaveLength(1);

    const h = mkdtempSync(join(tmpdir(), "crawlmark-redesign-"));
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), "version: 1\ntemplates:\n  t:\n    title: T\n    compare: []\n    sections: [{ id: s, type: search_overview }]\n");
    const doc = buildReportDoc(await fixtureReport({ homeDir: h, template: "t", include: [] }), v);
    expect(doc.kpis).toHaveLength(4);
    expect(doc.kpis.every((k) => !k.delta)).toBe(true);
    expect(doc.kpiCaption).toBe("No comparison period in this report");
    expect(toHtml(doc)).not.toContain('class="chip');
  });

  it("chart text from data is escaped in the legend and never inside the SVG", async () => {
    const pts = (a: number, b: number) =>
      [
        { day: "2026-07-05", rank: a },
        { day: "2026-08-02", rank: (a + b) / 2 },
        { day: "2026-09-27", rank: b },
      ].map((p) => ({ ...p, clicks: null, impressions: null }));
    const deps = fakeDeps({
      rankHistory: (c, o) => ({
        client: c.slug, since: o.since!, until: o.until!, source: o.source ?? "both", note: "",
        keywords: [
          { keyword: `${XSS} \u202e`, tracked: true, series: { gsc: pts(12, 6) }, summary: { gsc: summarizeRanks(pts(12, 6)) } },
          { keyword: "emergency plumber", tracked: true, series: { gsc: pts(8.4, 5.1) }, summary: { gsc: summarizeRanks(pts(8.4, 5.1)) } },
        ],
      }),
    });
    const report = await fixtureReport({ include: ["ranks"] }, deps);
    const ranks = report.sections.find((s) => s.id === "ranks") as { data: { keywords: { series?: { gsc?: unknown[] } }[] } };
    expect(ranks.data.keywords[0]!.series?.gsc).toHaveLength(3);
    const doc = buildReportDoc(report, v);
    const html = toHtml(doc);
    expect(html).toContain("Average position over time");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain(XSS);
    expect(html).not.toMatch(/\u202e/);
    for (const svg of svgs(html)) expect(svg).not.toMatch(/img src|emergency plumber/);
    // DOCX: the series name goes into a native chart, escaped, and every chart part is well-formed.
    const zip = await JSZip.loadAsync(await toDocx(doc));
    const parts = Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f));
    expect(parts.length).toBeGreaterThanOrEqual(4);
    const chartXml = await Promise.all(parts.map((p) => zip.file(p)!.async("string")));
    expect(chartXml.join("")).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(chartXml.join("")).not.toContain(XSS);
    expect(Object.keys(zip.files).some((f) => f.startsWith("word/media/"))).toBe(false);
  });

  it("Markdown and the Google Docs copy show charts as small weekly tables, with no SVG or style", async () => {
    const doc = buildReportDoc(await fixtureReport(), v);
    const md = toMarkdown(doc);
    expect(md).toContain("**Clicks by week**");
    expect(md).toContain("| Days | September 2026 | August 2026 | Change |");
    expect(md).toMatch(/\| 29–30 Sep \| \d+ \| \d+ \| [+−]?\d/);
    const docs = toHtml(doc, { variant: "docs" });
    expect(docs).not.toMatch(/<svg|<style|class="/);
    expect(docs).toContain("<p><strong>Clicks by week</strong></p>");
    expect(docs).toContain('<table border="1"');
  });
});

describe("print layout and wording (round 2)", () => {
  it("position and timing changes read 'better' / 'worse' everywhere, never a bare minus", async () => {
    const md = toMarkdown(buildReportDoc(await fixtureReport(), v));
    expect(md).toContain("| Average position | 7.5 | 8.2 | 0.7 better | 8.2 | 0.7 better |");
    expect(md).toContain("| emergency plumber | 6.4 | 7.1 | 0.7 better | 180 | 4,200 |");
    expect(md).toContain("| Largest Contentful Paint | 2,900 ms | 2,300 ms | 600 ms better |");
    expect(md).not.toMatch(/\| −0\.7 \|/);
  });

  it("section cards flow across pages; only atomic units stay whole; the running header skips page 1", async () => {
    const html = toHtml(buildReportDoc(await fixtureReport(), v));
    expect(html).not.toMatch(/\.card[^{]*\{[^}]*break-inside: avoid/);
    expect(html).toContain("figure.chart, .cols, .tiles { break-inside: avoid; }");
    expect(html).toContain('<div class="lead-in"><h2>Search performance</h2>');
    expect(html).toMatch(/@page \{ @top-left \{ content: "Example Co \\b7  Monthly SEO report \\b7  September 2026";/);
    expect(html).toContain("@page :first { @top-left { content: none; } }");
  });

  it("the running header can't break out of its CSS string", async () => {
    const evil = { ...client, name: 'Evil";} body{display:none} </style><script>x</script>' } as typeof client;
    const html = toHtml(buildReportDoc(await fixtureReport({}, fakeDeps(), evil), v));
    const style = html.slice(html.indexOf("<style>") + 7, html.indexOf("</style>"));
    expect(style).not.toMatch(/<\/?(style|script)|display:none|";\}/);
    expect(html.match(/<\/style>/g)).toHaveLength(1);
  });

  it("white label (branding.hideCrawlmark) leaves crawlmark's name and version out of every format", async () => {
    const doc = buildReportDoc(await fixtureReport(), { ...v, branding: { hideCrawlmark: true, footer: "Prepared by Example Agency" } });
    expect(doc.footer).toBe("Prepared by Example Agency");
    const zip = await JSZip.loadAsync(await toDocx(doc));
    for (const text of [toMarkdown(doc), toHtml(doc), toHtml(doc, { variant: "docs" }), await zip.file("word/document.xml")!.async("string"), await zip.file("docProps/core.xml")!.async("string")]) {
      expect(text).not.toMatch(/crawlmark/i);
    }
    expect(toMarkdown(doc)).toContain("saved site audits");
    expect(toMarkdown(buildReportDoc(await fixtureReport(), v))).toContain("crawlmark 0.1.0");
  });
});

describe("one-page executive template", () => {
  it("key figures, one chart, top wins and next steps side by side, a short About", async () => {
    const report = await fixtureReport({ template: "executive", include: [] });
    expect(report.template).toMatchObject({ id: "executive", layout: "onepage" });
    const doc = buildReportDoc(report, v);
    expect(doc.meta.layout).toBe("onepage");
    expect(doc.sections.map((s) => [s.title, Boolean(s.half)])).toEqual([["Clicks this period", false], ["Top wins", true], ["Next steps", true]]);
    expect(doc.summary?.items?.length).toBeLessThanOrEqual(3);
    const html = toHtml(doc);
    expect(html).toContain('<body class="onepage">');
    expect(svgs(html)).toHaveLength(1);
    expect(html).toContain('<div class="pair">');
    const md = toMarkdown(doc);
    expect(md).toContain("## Top wins");
    expect(md).toContain("| emergency plumber | 180 | +27 |");
    expect(md).toContain("## Next steps");
  });
});

describe("operator-only content", () => {
  it("paid data spend is in the export result, never in the files; the spend section is opt-in", async () => {
    let usd = 0;
    const deps = fakeDeps({ spentThisMonth: () => (usd += 0.25) });
    const report = await fixtureReport({}, deps);
    expect(report.sections.some((s) => s.type === "data_spend")).toBe(false);
    const dir = join(mkdtempSync(join(tmpdir(), "crawlmark-redesign-out-")), "reports");
    const out = await exportReport(report, { formats: ["md"], reportsDir: dir, branding: {}, version: "0.1.0", printer: vi.fn() });
    expect(out.spend).toEqual({ usd: 0.25, units: { ahrefs: 0, semrush: 0 } });
    const md = toMarkdown(buildReportDoc(report, v));
    expect(md).not.toMatch(/\$0\.25|Paid data/);
    const optIn = toMarkdown(buildReportDoc(await fixtureReport({ include: ["spend"] }), v));
    expect(optIn).toContain("## Paid data spend this month");
  });
});

describe("branding colours", () => {
  it("text on and in a light brand colour keeps AA contrast", () => {
    expect(textOn("#ffd400")).toBe("#111827");
    expect(textOn("#1f5ea8")).toBe("#ffffff");
    expect(contrast(inkOn("#ffd400"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(inkOn("#9ec5ff"), "#ffffff")).toBeGreaterThanOrEqual(4.5);
  });

  it("a light primary colour gets dark cover text in the HTML", async () => {
    const html = toHtml(buildReportDoc(await fixtureReport(), { ...v, branding: { primaryColor: "#ffd400" } }));
    expect(html).toContain("--on-primary: #111827;");
  });
});
