/**
 * Phase 13 A-6: the technical_issues and indexing_issues report sections in every format: dashboard blocks
 * (key figures, a table per severity, the coverage share chart, sitemaps, the indexed-share trend), hidden when
 * empty, white label, untrusted text inert in Markdown, HTML and DOCX, and no operator-only detail (property,
 * inspection counts, snapshot IDs, spend) in the files. Fixture data only (example.com); no network, no Chrome.
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { EMPTY_INDEXING, EMPTY_TECH_ISSUES, INDEXING, INDEXING_XSS, p13Report, TECH_ISSUES, TECH_ISSUES_XSS, XSS } from "./fixtures/reports/p13-data.js";

const v = { version: "0.1.0" };
const docXml = async (doc: ReturnType<typeof buildReportDoc>) => (await JSZip.loadAsync(await toDocx(doc))).file("word/document.xml")!.async("string");
const svgs = (html: string) => html.match(/<svg class="chart-svg"[\s\S]*?<\/svg>/g) ?? [];

describe("technical_issues section", () => {
  it("key figures, one table per severity with sources and changes, resolved issues and the sources note", async () => {
    const doc = buildReportDoc(p13Report(), v);
    const s = doc.sections.find((x) => x.id === "issues")!;
    const kpi = s.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => [k.label, k.value, k.tone])).toEqual([
      ["Critical", "1", "bad"],
      ["High", "2", "bad"],
      ["Medium", "3", undefined],
      ["Low", "2", undefined],
      ["New", "2", "bad"],
      ["Resolved", "1", "good"],
    ]);
    const md = toMarkdown(doc);
    await expect(md).toMatchFileSnapshot("fixtures/reports/__snapshots__/p13-sections.md");
    expect(md).toContain("**High**");
    expect(md).toContain("| Issue | Pages | Example | Found by | Change |");
    expect(md).toMatch(/\| Page has no title \| 1 \| \/thanks \| Site crawl, Audit \| \*new\* \|/);
    expect(md).toMatch(/\| Duplicate title tags \| 6 \| \/blog\/page\/2 \| DataForSEO crawl \| \*still open\* \|/);
    expect(md).toContain("not re-checked");
    expect(md).toContain("**Resolved since the last report**");
    expect(md).toContain("From Audit (9 Oct 2026), Site crawl (11 Oct 2026), Site checks (9 Oct 2026), DataForSEO crawl (20 Aug 2026, older data).");
    expect(md).toContain("Issues not re-checked by their source are shown as not re-checked, never as fixed.");
  });

  it("first checked and retired items get their own labels and key figures (D8)", () => {
    const first = TECH_ISSUES.issues[0]!;
    const doc = buildReportDoc(
      p13Report({ issues: { ...TECH_ISSUES, changes: { ...TECH_ISSUES.changes!, firstChecked: 2, retired: 1 }, issues: [{ ...first, change: "first_checked" }, ...TECH_ISSUES.issues.slice(1)] } }),
      v,
    );
    const kpi = doc.sections.find((x) => x.id === "issues")!.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => [k.label, k.value]).slice(-2)).toEqual([["First checked", "2"], ["Retired", "1"]]);
    expect(toMarkdown(doc)).toContain("*first checked*");
  });

  it("without a previous snapshot there are no New/Resolved tiles and no Change column", () => {
    const doc = buildReportDoc(p13Report({ issues: { ...TECH_ISSUES, changes: null, base: null, resolved: [], issues: TECH_ISSUES.issues.map((i) => ({ ...i, change: "first_run" as const })) } }), v);
    const md = toMarkdown(doc);
    expect(md).toContain("| Issue | Pages | Example | Found by |\n");
    expect(md).not.toContain("never as fixed");
    const kpi = doc.sections.find((x) => x.id === "issues")!.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => k.label)).toEqual(["Critical", "High", "Medium", "Low"]);
  });

  it("issues no longer checked by any source get one fixed line in About", () => {
    const md = toMarkdown(buildReportDoc(p13Report({ issues: { ...TECH_ISSUES, noLongerChecked: 3 } }), v));
    expect(md.match(/no longer checked by any current source/g)).toHaveLength(1);
    expect(toMarkdown(buildReportDoc(p13Report(), v))).not.toContain("no longer checked");
  });

  it("is left out when no source had data, and named once in About", () => {
    const doc = buildReportDoc(p13Report({ issues: EMPTY_TECH_ISSUES }), v);
    expect(doc.sections.some((x) => x.id === "issues")).toBe(false);
    expect(toMarkdown(doc)).toContain("Not included this time (no data for this period): Technical SEO issues.");
  });
});

describe("indexing_issues section", () => {
  it("key figures, the coverage share chart, pages to look at, sitemaps, the trend and the sample note", async () => {
    const doc = buildReportDoc(p13Report(), v);
    const html = toHtml(doc);
    await expect(html).toMatchFileSnapshot("fixtures/reports/__snapshots__/p13-sections.html");
    const s = doc.sections.find((x) => x.id === "indexing")!;
    const kpi = s.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => [k.label, k.value, k.detail])).toEqual([
      ["URLs checked", "40", undefined],
      ["Indexed", "31", "77.5% of checked"],
      ["Not indexed", "9", undefined],
      ["Canonical chosen differently", "2", undefined],
    ]);
    expect(html).toContain("Google&#39;s verdict for checked URLs");
    // Two charts: the coverage share and the indexed share by month; both described for screen readers.
    const charts = svgs(html);
    expect(charts.length).toBeGreaterThanOrEqual(2);
    for (const svg of charts) expect(svg).toMatch(/role="img" aria-label="[^"]+"/);
    const md = toMarkdown(doc);
    expect(md).toContain("| /services/old | *high* Not found (404) | yes | 2 Oct 2026 |");
    expect(md).toMatch(/\| \/pricing \| \*medium\* Duplicate, Google chose different canonical than user \(Google's canonical: \/plans\) \| yes \| 5 Oct 2026 \|/);
    expect(md).toContain("| `https://example.com/news-sitemap.xml` | 2 | 0 | 12 |");
    expect(md).toContain("Based on Google's URL Inspection of 40 pages (key pages, top Search Console pages and a rotating sample of sitemap URLs), not Search Console's full Page indexing report.");
    expect(md).toContain("5 key pages and 30 sitemap URLs (of about 120 submitted) were checked; the oldest result is 6 days old.");
    // Markdown shows the charts as small tables.
    expect(md).toContain("| Google says | URLs |");
    expect(md).toContain("| 2026-10 | 40 | 77.5% |");
  });

  it("more than six coverage states: the rest are grouped as Other, each part with its own colour", () => {
    const many = { ...INDEXING, byCoverage: Array.from({ length: 8 }, (_, i) => ({ state: `State ${i + 1}`, count: 10 - i, severity: null })) };
    const doc = buildReportDoc(p13Report({ indexing: many }), v);
    const chart = doc.sections.find((x) => x.id === "indexing")!.blocks.find((b) => b.kind === "chart")!;
    expect(chart.kind === "chart" && chart.chart.type === "share" && chart.chart.parts).toEqual(["State 1", "State 2", "State 3", "State 4", "State 5", "State 6", "Other"]);
    const html = toHtml(doc);
    const legend = html.slice(html.indexOf("Google&#39;s verdict"), html.indexOf("</figcaption>", html.indexOf("Google&#39;s verdict")));
    const colours = [...legend.matchAll(/background:(#[0-9a-f]{6})/g)].map((m) => m[1]);
    expect(colours).toHaveLength(7);
    expect(new Set(colours).size).toBe(7);
  });

  it("is left out when nothing has been inspected", () => {
    const doc = buildReportDoc(p13Report({ indexing: EMPTY_INDEXING }), v);
    expect(doc.sections.some((x) => x.id === "indexing")).toBe(false);
    expect(toMarkdown(doc)).toContain("Not included this time (no data for this period): Google indexing.");
  });
});

describe("both sections: escaping, white label, operator-only content", () => {
  it("an issue title, a coverage state and a URL carrying markup stay inert in Markdown, HTML and DOCX", async () => {
    const doc = buildReportDoc(p13Report({ issues: TECH_ISSUES_XSS, indexing: INDEXING_XSS }), v);
    const html = toHtml(doc);
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; title");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt; state");
    for (const svg of svgs(html)) expect(svg).not.toMatch(/img src/);
    // Markdown: code spans are literal text; outside them nothing may open a tag or a link.
    const md = toMarkdown(doc);
    const outsideCode = md.replace(/(`+)(?:(?!\1).)+\1/g, "");
    expect(outsideCode).not.toMatch(/(?<!\\)</);
    expect(outsideCode).not.toMatch(/(?<!\\)\[/);
    const xml = await docXml(doc);
    expect(xml).not.toContain(XSS);
    expect(xml).toContain("&lt;img src=x onerror=alert(1)&gt; title");
    const zip = await JSZip.loadAsync(await toDocx(doc));
    const charts = await Promise.all(Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).map((f) => zip.file(f)!.async("string")));
    expect(charts.join("")).not.toContain(XSS);
  });

  it("white label keeps crawlmark's name out; files carry no property, inspection count, snapshot ID or spend", async () => {
    const white = buildReportDoc(p13Report(), { ...v, branding: { hideCrawlmark: true } });
    const plain = buildReportDoc(p13Report(), v);
    for (const text of [toMarkdown(white), toHtml(white), await docXml(white)]) expect(text).not.toMatch(/crawlmark/i);
    expect(toMarkdown(white)).toContain("Technical SEO issues: saved site audits and crawls");
    expect(toMarkdown(plain)).toContain("Technical SEO issues: crawlmark's saved audits and crawls");
    for (const text of [toMarkdown(plain), toHtml(plain), toHtml(plain, { variant: "docs" }), await docXml(plain)]) {
      expect(text).not.toMatch(/quota|units|\$|sc-domain:|iss_|snapshot/i);
      expect(text).not.toContain("1000");
    }
  });
});
