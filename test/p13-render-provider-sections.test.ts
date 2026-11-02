/**
 * Phase 13 B-6: the backlinks, organic_visibility and competitor_overview report sections in every format: key
 * figures with better/worse chips, the labelled authority metric (never mixed), the position-band share chart only
 * when the provider has bands, trends as inline SVG with table fallbacks in Markdown and DOCX, hidden when empty, a
 * "Source: <provider>" line kept in white label, untrusted domains inert, and no operator-only detail.
 * Fixture data only (example.com); no network, no Chrome.
 */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { BACKLINKS, BACKLINKS_AHREFS, COMPETITORS, COMPETITORS_XSS, p13bReport, VISIBILITY, VISIBILITY_SEMRUSH, XSS } from "./fixtures/reports/p13-data.js";

const v = { version: "0.1.0" };
const docXml = async (doc: ReturnType<typeof buildReportDoc>) => (await JSZip.loadAsync(await toDocx(doc))).file("word/document.xml")!.async("string");
const svgs = (html: string) => html.match(/<svg class="chart-svg"[\s\S]*?<\/svg>/g) ?? [];
const section = (doc: ReturnType<typeof buildReportDoc>, id: string) => doc.sections.find((x) => x.id === id);

describe("backlinks section", () => {
  it("key figures with change chips, the labelled authority metric, new/lost for the month, the trend chart and the comparison table", async () => {
    const doc = buildReportDoc(p13bReport(), v);
    const kpi = section(doc, "backlinks")!.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => [k.label, k.value, k.delta?.text, k.delta?.tone, k.detail])).toEqual([
      ["Referring domains", "212", "7.1%", "good", "vs 198 in August 2026"],
      ["Backlinks", "1,840", "8.1%", "good", "vs 1,702 in August 2026"],
      ["DataForSEO Rank (0–1000)", "312", "7", "good", "vs 305 in August 2026"],
      ["New referring domains", "19", undefined, undefined, "September 2026 (DataForSEO, monthly)"],
      ["Lost referring domains", "5", undefined, undefined, "September 2026 (DataForSEO, monthly)"],
    ]);
    const md = toMarkdown(doc);
    await expect(md).toMatchFileSnapshot("fixtures/reports/__snapshots__/p13-provider-sections.md");
    expect(md).toContain("| Metric | 2 Oct 2026 | August 2026 | Change |");
    expect(md).toContain("| Referring domains | 212 | 198 | +14 |");
    expect(md).toContain("| Month | Referring domains | Backlinks | DataForSEO Rank (0–1000) |");
    expect(md).toContain("Source: DataForSEO. Figures as of 2 Oct 2026.");
    const html = toHtml(doc);
    await expect(html).toMatchFileSnapshot("fixtures/reports/__snapshots__/p13-provider-sections.html");
    expect(svgs(html).length).toBeGreaterThanOrEqual(3);
    for (const svg of svgs(html)) expect(svg).toMatch(/role="img" aria-label="[^"]+"/);
  });

  it("Ahrefs: Domain Rating label, no new/lost tiles, a note that Ahrefs doesn't report them", () => {
    const doc = buildReportDoc(p13bReport({ backlinks: BACKLINKS_AHREFS }), v);
    const kpi = section(doc, "backlinks")!.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => k.label)).toEqual(["Referring domains", "Backlinks", "Ahrefs Domain Rating (0–100)"]);
    const md = toMarkdown(doc);
    expect(md).toContain("Ahrefs doesn't report new and lost referring domains");
    expect(md).toContain("Source: Ahrefs.");
    expect(md).not.toContain("DataForSEO Rank");
  });

  it("a requested comparison with no stored figures is dropped with one note; empty figures hide the section", () => {
    const md = toMarkdown(buildReportDoc(p13bReport({ backlinks: { ...BACKLINKS, comparisons: { previous_period: null } } }), v));
    expect(md.match(/Backlinks: no DataForSEO figures are stored for August 2026/g)).toHaveLength(1);
    expect(md).not.toContain("| Metric | 2 Oct 2026");
    const empty = buildReportDoc(p13bReport({ backlinks: { ...BACKLINKS, current: { ...BACKLINKS.current, backlinks: null, referringDomains: null, authority: null } } }), v);
    expect(section(empty, "backlinks")).toBeUndefined();
    expect(toMarkdown(empty)).toMatch(/Not included this time \(no data for this period\): Backlinks/);
  });
});

describe("organic visibility section", () => {
  it("keywords, top 3 and traffic; the position share chart with this period and the last; the band table", () => {
    const doc = buildReportDoc(p13bReport(), v);
    const s = section(doc, "visibility")!;
    const kpi = s.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => [k.label, k.value, k.delta?.text])).toEqual([
      ["Ranking keywords (top 100)", "1,204", "6.5%"],
      ["In the top 3", "41", "13.9%"],
      ["Estimated traffic", "3,950", "9.4%"],
    ]);
    const cols = s.blocks.find((b) => b.kind === "columns")!;
    const charts = cols.kind === "columns" ? cols.columns.flat() : [];
    const share = charts.find((b) => b.kind === "chart" && b.chart.type === "share");
    expect(share?.kind === "chart" && share.chart.type === "share" && share.chart.parts).toEqual(["Top 3", "4–10", "11–20", "21–100"]);
    expect(share?.kind === "chart" && share.chart.type === "share" && share.chart.rows.map((r) => r.label)).toEqual(["2 Oct 2026", "August 2026"]);
    const md = toMarkdown(doc);
    expect(md).toContain("| Positions 1–3 | 41 | 36 | +5 |");
    expect(md).toContain("| Position | 2 Oct 2026 | August 2026 |");
    expect(md).toContain("Estimated traffic is DataForSEO estimated traffic, a modelled figure");
  });

  it("Semrush: no band chart or top-3 tile, the note, and Semrush as the source", () => {
    const doc = buildReportDoc(p13bReport({ visibility: VISIBILITY_SEMRUSH }), v);
    const s = section(doc, "visibility")!;
    expect(JSON.stringify(s.blocks)).not.toContain('"type":"share"');
    const kpi = s.blocks[0]!;
    expect(kpi.kind === "kpiRow" && kpi.items.map((k) => k.label)).toEqual(["Ranking keywords (top 100)", "Estimated traffic"]);
    const md = toMarkdown(doc);
    expect(md).toContain("Semrush's API doesn't report keywords by position band.");
    expect(md).toContain("Source: Semrush.");
    expect(md).not.toContain("Positions 1–3");
  });
});

describe("competitor overview section", () => {
  it("this site first, saved then suggested, shared keywords with n/a for competitors outside the provider's list", () => {
    const md = toMarkdown(buildReportDoc(p13bReport(), v));
    expect(md).toContain("Organic competitors in the client's market (DataForSEO data, as of 2 Oct 2026); saved competitors first.");
    expect(md).toContain("| Domain |  | Shared keywords | Their ranking keywords | Est. traffic |");
    const rows = md.split("\n").filter((l) => /^\| (\*\*)?`/.test(l));
    expect(rows.map((l) => l.split("|")[1]!.trim())).toEqual(["`example.com`", "`competitor-a.example`", "`competitor-b.example`", "`rival.example.net`", "`another.example.org`"]);
    expect(md).toMatch(/\| `competitor-b.example` \| Saved \| n\/a \|/);
    expect(md).toContain('"n/a": not among DataForSEO\'s top 20 competitors for this site');
    const empty = buildReportDoc(p13bReport({ competitors: { ...COMPETITORS, competitors: [] } }), v);
    expect(section(empty, "competitors")).toBeUndefined();
  });
});

describe("all three: escaping, white label, operator-only content", () => {
  it("a competitor domain carrying markup stays inert in Markdown, HTML and DOCX", async () => {
    const doc = buildReportDoc(p13bReport({ competitors: COMPETITORS_XSS }), v);
    const html = toHtml(doc);
    expect(html).not.toContain(XSS);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;.example");
    const md = toMarkdown(doc);
    const outsideCode = md.replace(/(`+)(?:(?!\1).)+\1/g, "");
    expect(outsideCode).not.toMatch(/(?<!\\)</);
    const xml = await docXml(doc);
    expect(xml).not.toContain(XSS);
  });

  it("white label keeps the Source lines and crawlmark's name out; no cost, units, market code or snapshot detail in any file", async () => {
    // Release B: white label also hides the DataForSEO name (hideProviders follows hideCrawlmark); the Source line stays, generically named.
    const white = buildReportDoc(p13bReport(), { ...v, branding: { hideCrawlmark: true } });
    for (const text of [toMarkdown(white), toHtml(white), await docXml(white)]) {
      expect(text).not.toMatch(/crawlmark|dataforseo/i);
      expect(text).toContain("Source: a third-party SEO data provider");
      expect(text).not.toMatch(/units|\$|2840|snapshot|provider_history|reused|quota/i);
    }
    expect(toMarkdown(white)).toContain("Backlinks, organic visibility and competitors: a third-party SEO data provider (paid), stored month by month");
  });

  it("hideProviders: false keeps the DataForSEO name even in white label", async () => {
    const white = buildReportDoc(p13bReport(), { ...v, branding: { hideCrawlmark: true, hideProviders: false } });
    for (const text of [toMarkdown(white), toHtml(white), await docXml(white)]) {
      expect(text).not.toMatch(/crawlmark/i);
      expect(text).toContain("Source: DataForSEO");
    }
    expect(toMarkdown(white)).toContain("Backlinks, organic visibility and competitors: DataForSEO (paid), stored month by month");
  });
});
