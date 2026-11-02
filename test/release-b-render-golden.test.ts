/**
 * Release B (B2): Markdown and HTML output of the new features, as golden snapshots plus targeted assertions.
 * Default output (no new fields) is covered by test/release-b-compat.test.ts against the 0.2.0 goldens; this file
 * covers what is new: fonts, cover fields, the linked contents list, page breaks, and the commentary kinds.
 * Fixture data only (example.com); no network, no Chrome.
 */
import { describe, expect, it, vi } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { CSP, fontStacks, toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { footerFont, footerTemplate } from "../src/reports/render/pdf.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport, RICH_MARK, XSS } from "./fixtures/reports/release-b-render.js";

vi.mock("../src/reports/render/narrative.js", async (orig) => {
  const m = await orig<typeof import("../src/reports/render/narrative.js")>();
  const { richBlocks: blocks, RICH_MARK: mark } = await import("./fixtures/reports/release-b-render.js");
  return { ...m, parseNarrative: (t: string) => (t.includes(mark) ? blocks() : m.parseNarrative(t)) };
});

const v = { version: "0.3.0" };
const SNAP = "fixtures/reports/__snapshots__/release-b";
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

describe("fonts", () => {
  const branding = { bodyFont: "Inter", headingFont: "Merriweather" };

  it("sets --font-body and --font-heading with the quoted names and the sans fallback", async () => {
    const html = toHtml(buildReportDoc(await fixtureReport(), { ...v, branding }));
    expect(html).toContain('--font-body: "Inter", system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif;');
    expect(html).toContain('--font-heading: "Merriweather", system-ui,');
    expect(html).toContain("body { font-family: var(--font-body); }");
    // The PDF running header uses the body stack too.
    expect(html).toMatch(/@page \{ @top-left \{ content: [^;]+; font-family: "Inter", system-ui/);
    expect(html).toContain(`content="${CSP}"`);
  });

  it("the serif fallback uses the serif stack", async () => {
    const html = toHtml(buildReportDoc(await fixtureReport(), { ...v, branding: { bodyFont: "Source Sans 3", fontFallback: "serif" } }));
    expect(html).toContain('--font-body: "Source Sans 3", Georgia, Cambria, "Times New Roman", Times, serif;');
    expect(html).toContain('--font-heading: "Source Sans 3", Georgia,');
  });

  it("a hyphenated name stays readable and a hostile name can't leave the CSS string", () => {
    expect(fontStacks({ body: "Fira-Sans", heading: null, fallback: "sans-serif" })!.body).toMatch(/^"Fira-Sans", /);
    const hostile = fontStacks({ body: 'x";}</style><script>', heading: null, fallback: "sans-serif" })!.body;
    expect(hostile).not.toMatch(/<|;\}|<\/style>/);
    expect(hostile.startsWith('"x\\22 \\3b \\7d \\3c ')).toBe(true);
  });

  it("no font fields: no font variables at all (the output matches 0.2.0)", async () => {
    const html = toHtml(buildReportDoc(await fixtureReport(), v));
    expect(html).not.toContain("--font-body");
    expect(fontStacks({ body: null, heading: null, fallback: "sans-serif" })).toBeNull();
  });

  it("the docs variant has no style block and so no fonts", async () => {
    expect(toHtml(buildReportDoc(await fixtureReport(), { ...v, branding }), { variant: "docs" })).not.toContain("Inter");
  });

  it("the PDF footer template uses the body stack, quotes made safe for the style attribute", async () => {
    const doc = buildReportDoc(await fixtureReport(), { ...v, branding });
    const family = footerFont(doc.branding.fonts);
    expect(family).toBe("'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, 'Noto Sans', sans-serif");
    const footer = footerTemplate("Example Agency", family);
    expect(footer).toContain(`font-family:${family};`);
    expect(footer).not.toMatch(/style="[^"]*"[^>]*"[^>]*>.*font-family:[^;]*"/);
    // Without fonts, the footer is the one it always was.
    expect(footerFont(buildReportDoc(await fixtureReport(), v).branding.fonts)).toBe("system-ui,-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif");
    expect(footerTemplate("x")).toBe(footerTemplate("x", footerFont({ body: null, heading: null, fallback: "sans-serif" })));
  });
});

describe("cover, contents and page breaks", () => {
  it("Markdown golden", async () => {
    const md = toMarkdown(buildReportDoc(await layoutReport(), v));
    await expect(md).toMatchFileSnapshot(`${SNAP}/layout.md`);
    // The cover entries in the chosen order; the contents list in section order with About last; no links.
    const head = md.slice(0, md.indexOf("## Key figures"));
    expect(head.indexOf("Prepared for Jane Doe, Example Co")).toBeLessThan(head.indexOf("Period:"));
    expect(head).toContain("*Quarterly check-in*");
    expect(head).not.toContain("Prepared by");
    expect(head).not.toContain("example.com");
    expect(head).toContain("## Contents\n\n1. Search performance\n2. Branded vs non-branded");
    expect(head.trimEnd().endsWith("14. About this report")).toBe(true);
    expect(head).not.toContain("](#");
  });

  it("HTML golden: the contents links resolve and exactly two cards break the page", async () => {
    const html = toHtml(buildReportDoc(await layoutReport(), v));
    await expect(html).toMatchFileSnapshot(`${SNAP}/layout.html`);
    const hrefs = [...html.matchAll(/<a href="#([^"]+)">/g)].map((m) => m[1]!);
    expect(hrefs).toHaveLength(14);
    expect(hrefs.at(-1)).toBe("about-this-report");
    for (const id of hrefs) expect(html.match(new RegExp(`\\bid="${id}"`, "g")), id).toHaveLength(1);
    expect(count(html, /<section class="card[^"]*page-break"/g)).toBe(2);
    expect(html).toContain("@media print { .page-break { break-before: page; } }");
    expect(html).toContain('<nav class="contents" aria-label="Contents">');
    // Cover: subtitle, then the three chosen entries in order; no domain line, comparison, preparer or badge.
    const cover = html.slice(html.indexOf('<header class="cover">'), html.indexOf("</header>"));
    expect(cover).toContain('<p class="subtitle">Quarterly check-in</p>');
    expect([...cover.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1])).toEqual(["Prepared for", "Period", "Generated"]);
    expect(cover).not.toContain('class="domain"');
    expect(cover).not.toContain('class="badge"');
  });

  it("the Google Docs variant keeps the contents links and their targets", async () => {
    const html = toHtml(buildReportDoc(await layoutReport(), v), { variant: "docs" });
    expect(html).toContain("<h2>Contents</h2>");
    expect(html).toContain('<h2 id="s-search">Search performance</h2>');
    expect(html).toContain('<h2 id="about-this-report">About this report</h2>');
    expect(html).not.toContain("page-break");
  });

  it("without contents there are no anchors and no contents list", async () => {
    const r = await layoutReport();
    delete r.template.contents;
    const doc = buildReportDoc(r, v);
    const html = toHtml(doc);
    const md = toMarkdown(doc);
    expect(html).not.toContain('class="contents"');
    expect(html).not.toMatch(/ id="s-/);
    expect(md).not.toContain("## Contents");
    // Page breaks work without a contents list.
    expect(count(html, /page-break"/g)).toBe(2);
    expect(md).not.toContain("page-break");
  });

  it("onepage ignores contents and page breaks", async () => {
    const r = await layoutReport();
    r.template.layout = "onepage";
    const doc = buildReportDoc(r, v);
    const html = toHtml(doc);
    expect(html).not.toContain("page-break");
    expect(html).not.toContain('class="contents"');
    expect(toMarkdown(doc)).not.toContain("## Contents");
  });

  it("a section that starts a new page is never paired as half", async () => {
    const r = await fixtureReport();
    const plain = buildReportDoc(r, v);
    const halves = plain.sections.filter((s) => s.half).map((s) => s.id);
    expect(halves.length).toBeGreaterThanOrEqual(2);
    for (const k of r.sections) if (halves.includes(k.id)) (k as { pageBreakBefore?: true }).pageBreakBefore = true;
    expect(buildReportDoc(r, v).sections.some((s) => s.half)).toBe(false);
  });

  it("cover text is escaped in every format", async () => {
    const r = await fixtureReport();
    r.template.cover = { subtitle: XSS, preparedFor: XSS };
    const doc = buildReportDoc(r, v);
    for (const out of [toHtml(doc), toHtml(doc, { variant: "docs" })]) {
      expect(out).not.toContain(XSS);
      expect(out).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
    expect(toMarkdown(doc)).not.toMatch(/(?<!\\)</);
  });
});

describe("commentary kinds", () => {
  const rich = async () => buildReportDoc(await fixtureReport(), { ...v, narrative: { summary: RICH_MARK, sections: { search: RICH_MARK } } });

  it("Markdown golden: #### heading, numbered lists, an aligned pipe table, the chart's table, no chart reference text", async () => {
    const md = toMarkdown(await rich());
    await expect(md).toMatchFileSnapshot(`${SNAP}/commentary-kinds.md`);
    expect(md).toContain("> #### What changed");
    expect(md).toContain("> 1. Update the services pages\n> 2. Fix the broken links");
    expect(md).toContain("> 3. Review again in October");
    expect(md).toContain("> | Page | Clicks |\n> | --- | ---: |");
    expect(md).toMatch(/> \| short row \| +\|/);
    expect(md).not.toContain("{{chart");
  });

  it("HTML golden: h4, ol with start, a table in the commentary box, an inline chart", async () => {
    const html = toHtml(await rich());
    await expect(html).toMatchFileSnapshot(`${SNAP}/commentary-kinds.html`);
    expect(html).toContain("<h4>What changed</h4>");
    expect(html).toContain("<ol><li>Update the services pages</li>");
    expect(html).toContain('<ol start="3"><li>Review again in October</li></ol>');
    const box = html.slice(html.indexOf('<aside class="commentary">'), html.indexOf("</aside>", html.indexOf('<aside class="commentary">')));
    expect(box).toContain('<td class="num"><strong>120</strong></td>');
    expect(box).toContain("<table>");
    expect(box).toContain('<figure class="chart">');
    expect(html).toContain("h4 { font-size: 12px;");
  });

  it("table cell markup is inert in HTML (file and docs) and Markdown", async () => {
    const doc = await rich();
    for (const html of [toHtml(doc), toHtml(doc, { variant: "docs" })]) {
      expect(html).not.toContain(XSS);
      expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    }
    const md = toMarkdown(doc);
    expect(md).not.toContain(XSS);
    expect(md.replace(/(`+)(?:(?!\1).)+\1/g, "")).not.toMatch(/(?<!\\)</);
  });

  it("a block section is drawn as plain Markdown/HTML with no Commentary label", async () => {
    const r = await fixtureReport();
    r.sections.push({ id: "gloss", type: "block", title: "Glossary", status: "ok", data: { blockId: "glossary", text: RICH_MARK } });
    const doc = buildReportDoc(r, v);
    const md = toMarkdown(doc);
    const html = toHtml(doc);
    const mdSection = md.slice(md.indexOf("## Glossary"), md.indexOf("## About this report"));
    expect(mdSection).toContain("#### What changed");
    expect(mdSection).not.toContain("Commentary");
    expect(mdSection).not.toMatch(/^>/m);
    const card = html.slice(html.indexOf('aria-label="Glossary"'), html.indexOf("</section>", html.indexOf('aria-label="Glossary"')));
    expect(card).toContain("<h4>What changed</h4>");
    expect(card).not.toContain("commentary");
  });

  it("a block that isn't in the report's own sections can't be reached: unresolved references go to warnings", async () => {
    const r = await fixtureReport();
    r.sections.push({ id: "gloss", type: "block", title: "Glossary", status: "ok", data: { blockId: "glossary", text: RICH_MARK } });
    const doc = buildReportDoc(r, v);
    expect(doc.warnings).toContain("narrative.blocks.glossary: {{chart search 9}} has no chart to show; left out.");
  });
});

describe("commentary note", () => {
  const nar = { summary: "Clicks grew." };

  it("the default and white label text, a custom note, and an empty note removing the line", async () => {
    const r = await fixtureReport();
    const d = (branding: object) => buildReportDoc(r, { ...v, narrative: nar, branding });
    expect(toMarkdown(d({}))).toContain("Commentary written with Claude; all figures come from the data below.");
    const white = toMarkdown(d({ hideCrawlmark: true }));
    expect(white).toContain("Written commentary; all figures come from the data below.");
    expect(white).not.toMatch(/claude/i);
    expect(toMarkdown(d({ commentaryNote: "Notes by our analysts." }))).toContain("*Notes by our analysts.*");
    const none = d({ commentaryNote: "" });
    const md = toMarkdown(none);
    const html = toHtml(none);
    expect(md).not.toMatch(/written commentary|written with Claude/i);
    expect(html).not.toMatch(/written commentary|written with Claude|class="caption"/i);
    // Both the summary caption and the About line are gone, but the commentary itself stays.
    expect(md).toContain("Clicks grew.");
  });
});
