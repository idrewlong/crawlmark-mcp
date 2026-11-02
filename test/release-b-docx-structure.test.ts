/**
 * Release B (B2): the DOCX structure of the new features. Fonts (the failing-first R2 test), cover fields, the
 * linked contents list, page breaks, and the commentary kinds (sub-heading, numbered lists, tables, chart
 * references). Fixture data only (example.com); no network.
 */
import { describe, expect, it, vi } from "vitest";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport, part, richBlocks, RICH_MARK, XSS, zipOf } from "./fixtures/reports/release-b-render.js";

// A stand-in parser for the marker text, so the chart-reference path doesn't depend on the text pipeline's parser.
vi.mock("../src/reports/render/narrative.js", async (orig) => {
  const m = await orig<typeof import("../src/reports/render/narrative.js")>();
  const { richBlocks: blocks, RICH_MARK: mark } = await import("./fixtures/reports/release-b-render.js");
  return { ...m, parseNarrative: (t: string) => (t.includes(mark) ? blocks() : m.parseNarrative(t)) };
});

const v = { version: "0.3.0" };
const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

async function files(doc: ReturnType<typeof buildReportDoc>) {
  const zip = await zipOf(await toDocx(doc));
  return { zip, document: await part(zip, "word/document.xml"), styles: await part(zip, "word/styles.xml") };
}

describe("fonts", () => {
  it("bodyFont and headingFont reach the default run and the Title, Heading 2, 3 and 4 styles", async () => {
    const doc = buildReportDoc(await fixtureReport(), { ...v, branding: { bodyFont: "Inter", headingFont: "Merriweather" } });
    const { styles } = await files(doc);
    expect(styles).toMatch(/<w:docDefaults>[\s\S]*?<w:rFonts [^>]*w:ascii="Inter"[\s\S]*?<\/w:docDefaults>/);
    for (const id of ["Title", "Heading2", "Heading3", "Heading4"]) {
      const style = new RegExp(`<w:style [^>]*w:styleId="${id}"[\\s\\S]*?</w:style>`).exec(styles)?.[0] ?? "";
      expect(style, id).toContain('w:ascii="Merriweather"');
    }
  });

  it("the heading font falls back to the body font", async () => {
    const { styles } = await files(buildReportDoc(await fixtureReport(), { ...v, branding: { bodyFont: "Inter" } }));
    expect(/<w:style [^>]*w:styleId="Heading2"[\s\S]*?<\/w:style>/.exec(styles)![0]).toContain('w:ascii="Inter"');
  });

  it("with no font fields the file still uses Calibri", async () => {
    const { styles } = await files(buildReportDoc(await fixtureReport(), v));
    expect(styles).toContain('w:ascii="Calibri"');
    expect(styles).not.toMatch(/Inter|Merriweather/);
  });
});

describe("cover, contents and page breaks", () => {
  it("the cover shows exactly the chosen fields in order, with the subtitle", async () => {
    const { document } = await files(buildReportDoc(await layoutReport(), v));
    const at = (s: string) => document.indexOf(s);
    expect(at("Quarterly check-in")).toBeGreaterThan(0);
    expect(at("Prepared for: Jane Doe, Example Co")).toBeGreaterThan(0);
    expect(at("Prepared for: Jane Doe, Example Co")).toBeLessThan(at("Period: September 2026"));
    expect(at("Period: September 2026")).toBeLessThan(at("Generated: 13 Oct 2026"));
    // Not chosen: the domain line, the comparison, "Prepared by" and the badge.
    expect(document).not.toContain("Compared with:");
    expect(document).not.toContain("Prepared by:");
    // Only the About section says "Data-only report"; the badge field wasn't chosen.
    expect(count(document, /Data-only report/g)).toBe(1);
  });

  it("a bookmark per section heading, an internal link per contents entry, About last", async () => {
    const doc = buildReportDoc(await layoutReport(), v);
    const { document } = await files(doc);
    expect(count(document, /<w:bookmarkStart /g)).toBe(doc.sections.length + 1);
    const links = [...document.matchAll(/<w:hyperlink [^>]*w:anchor="([^"]+)"/g)].map((m) => m[1]!);
    expect(links).toHaveLength(doc.sections.length + 1);
    const bookmarks = new Set([...document.matchAll(/<w:bookmarkStart [^>]*w:name="([^"]+)"/g)].map((m) => m[1]!));
    for (const l of links) expect(bookmarks.has(l), l).toBe(true);
    for (const b of bookmarks) expect(b).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,39}$/);
    // Section order, About this report last.
    const hyperlinkText = [...document.matchAll(/<w:hyperlink [^>]*>[\s\S]*?<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]!);
    expect(hyperlinkText).toEqual([...doc.sections.map((s) => s.title), "About this report"]);
  });

  it("no contents, no bookmarks", async () => {
    const r = await layoutReport();
    delete r.template.contents;
    const { document } = await files(buildReportDoc(r, v));
    expect(document).not.toContain("w:bookmarkStart");
    expect(document).not.toContain("w:hyperlink");
  });

  it("pageBreakBefore sits on exactly the two chosen headings", async () => {
    const { document } = await files(buildReportDoc(await layoutReport(), v));
    expect(count(document, /<w:pageBreakBefore\b/g)).toBe(2);
    const paragraphs = document.match(/<w:p>(?:(?!<\/w:p>).)*<w:pageBreakBefore\/?>[\s\S]*?<\/w:p>/g) ?? [];
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs.join("")).toContain("Heading2");
  });

  it("a page break on the first heading of a half-pair splits the pair rule: the break section is never paired", async () => {
    const doc = buildReportDoc(await layoutReport(), v);
    for (const s of doc.sections) if (s.pageBreakBefore) expect(s.half).toBeUndefined();
  });

  it("onepage ignores contents and page breaks", async () => {
    const r = await layoutReport();
    r.template.layout = "onepage";
    const doc = buildReportDoc(r, v);
    expect(doc.contents).toBeUndefined();
    expect(doc.sections.some((s) => s.pageBreakBefore)).toBe(false);
    const { document } = await files(doc);
    expect(document).not.toContain("w:bookmarkStart");
    expect(document).not.toContain("w:pageBreakBefore");
  });
});

describe("commentary kinds", () => {
  const withRich = async () => {
    const doc = buildReportDoc(await fixtureReport(), { ...v, narrative: { summary: RICH_MARK, sections: { search: RICH_MARK } } });
    return { doc, ...(await files(doc)) };
  };

  it("sub-heading, numbered lists with their own numbering, a table inside the callout", async () => {
    const { document, styles, zip } = await withRich();
    expect(document).toContain('w:val="Heading4"');
    expect(styles).toContain('w:styleId="Heading4"');
    expect(document).toContain("<w:numPr>");
    const numbering = await part(zip, "word/numbering.xml");
    expect(numbering).toMatch(/w:start w:val="3"/);
    // Two lists in the summary and two in the section: four list instances, restarting separately.
    const instances = new Set([...document.matchAll(/<w:numId w:val="(\d+)"\/>/g)].map((m) => m[1]));
    expect(instances.size).toBeGreaterThanOrEqual(4);
    // A table nested in the callout (the callout is itself a one-cell table).
    expect(count(document, /<w:tbl>/g)).toBeGreaterThan(count(await part(await zipOf(await toDocx(buildReportDoc(await fixtureReport(), v))), "word/document.xml"), /<w:tbl>/g));
    expect(document).toContain("short row");
  });

  it("table text with markup is inert text; every cell is a paragraph", async () => {
    const { document } = await withRich();
    expect(document).not.toContain(XSS);
    expect(document).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("a chart reference draws one more chart; an unresolved one is left out and listed in warnings", async () => {
    const base = buildReportDoc(await fixtureReport(), v);
    const baseCharts = Object.keys((await files(base)).zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).length;
    const { doc, zip } = await withRich();
    const charts = Object.keys(zip.files).filter((f) => /^word\/charts\/chart\d+\.xml$/.test(f)).length;
    // Two {{chart search}} (summary and section commentary) resolve; the two {{chart search 9}} don't.
    expect(charts).toBe(baseCharts + 2);
    expect([...doc.warnings].sort()).toEqual([
      "narrative.sections.search: {{chart search 9}} has no chart to show; left out.",
      "narrative.summary: {{chart search 9}} has no chart to show; left out.",
    ]);
  });

  it("a block section is drawn without the Commentary label", async () => {
    const r = await fixtureReport();
    r.sections.push({ id: "gloss", type: "block", title: "Glossary", status: "ok", data: { blockId: "glossary", text: RICH_MARK } });
    const doc = buildReportDoc(r, v);
    const section = doc.sections.find((s) => s.id === "gloss")!;
    expect(section.blocks[0]?.kind).toBe("rich");
    const { document } = await files(doc);
    expect(document).toContain("Glossary");
    expect(document).toContain("What changed");
    expect(count(document, /Commentary/g)).toBe(0);
  });
});
