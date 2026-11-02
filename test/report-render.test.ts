import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TemplateReport } from "../src/reports/report-types.js";
import { buildReportDoc } from "../src/reports/render/doc.js";
import { escapeMarkdown, markdownCode } from "../src/reports/render/escape.js";
import { CSP, toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { parseNarrative, validateNarrative } from "../src/reports/render/narrative.js";
import { runTemplate } from "../src/reports/templates/run.js";
import * as data from "./fixtures/reports/data.js";
import { client, fakeDeps } from "./fixtures/reports/deps.js";

const today = new Date("2026-10-13T12:00:00Z");
const home = () => mkdtempSync(join(tmpdir(), "crawlmark-render-"));

/** The fixture report with fixed id and time, so snapshots are stable. */
async function fixtureReport(extra: Partial<Parameters<typeof runTemplate>[1]> = {}, deps = fakeDeps(), c = client): Promise<TemplateReport> {
  const r = await runTemplate(c, { homeDir: home(), today, month: "2026-09", include: ["cwv", "gtm"], store: false, ...extra }, deps);
  return { ...r, reportId: "rpt_01JFIXTURE0000000000000000", generatedAt: "2026-10-13T09:00:00.000Z" };
}

const NARRATIVE = {
  summary: "Organic search grew **12%** this month.\n\nThe main driver was the emergency page.\n\n- More calls\n- <b>raw html</b> stays literal",
  sections: { search: "Clicks rose because [a link](javascript:alert(1)) stays text.", audit: "One issue fixed." },
};

describe("Markdown and HTML renderers", () => {
  it("data-only snapshot (Markdown and HTML)", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.1.0" });
    expect(doc.meta.dataOnly).toBe(true);
    await expect(toMarkdown(doc)).toMatchFileSnapshot("fixtures/reports/__snapshots__/data-only.md");
    await expect(toHtml(doc)).toMatchFileSnapshot("fixtures/reports/__snapshots__/data-only.html");
    expect(toMarkdown(doc)).toContain("- Data-only report. Built automatically from Search Console and Google Analytics. It has no written commentary.");
    expect(toHtml(doc)).toContain("Data-only report.");
  });

  it("with narrative: commentary banner, summary and per-section boxes", async () => {
    const report = await fixtureReport();
    const doc = buildReportDoc(report, { version: "0.1.0", narrative: NARRATIVE });
    expect(doc.meta.dataOnly).toBe(false);
    const md = toMarkdown(doc);
    const html = toHtml(doc);
    await expect(md).toMatchFileSnapshot("fixtures/reports/__snapshots__/narrative.md");
    await expect(html).toMatchFileSnapshot("fixtures/reports/__snapshots__/narrative.html");
    expect(md).toContain("Commentary written with Claude; all figures come from the data below.");
    expect(md).toContain("> Organic search grew **12%** this month.");
    expect(md).toContain("> - \\<b\\>raw html\\</b\\> stays literal");
    expect(html).toContain("<strong>12%</strong>");
    expect(html).toContain("&lt;b&gt;raw html&lt;/b&gt; stays literal");
    // The summary sits in the summary box; the two section notes are commentary boxes beside their data.
    expect(html.match(/class="commentary"/g)).toHaveLength(2);
    expect(html).toMatch(/<section class="summary"[^>]*><h2>Summary<\/h2>\n<p>Organic search grew <strong>12%<\/strong>/);
  });

  it("an XSS fixture is inert in Markdown and HTML", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    writeFileSync(join(h, "config", "report-templates.yaml"), 'version: 1\ntemplates:\n  x:\n    title: "Report ](javascript:alert(1)) [x]"\n    sections: [{ id: q, type: top_queries }, { id: p, type: top_pages }]\n');
    const evil = { ...client, name: "Evil \u202eoC <script>alert(1)</script>" } as typeof client;
    const deps = fakeDeps({
      gscQuery: async (c, o) =>
        o.dimensions?.join() === "page"
          ? [{ keys: ['https://example.com/"><img src=x onerror=alert(1)>'], clicks: 1, impressions: 2, ctr: 50, position: 1 }]
          : [
              { keys: ["<img src=x onerror=alert(1)>"], clicks: 5, impressions: 10, ctr: 50, position: 2 },
              { keys: ["](javascript:alert(1))"], clicks: 4, impressions: 10, ctr: 40, position: 3 },
              { keys: ["a | b"], clicks: 3, impressions: 10, ctr: 30, position: 4 },
              { keys: ["bidi \u202egnp.exe\u2066 zero\u200bwidth"], clicks: 2, impressions: 10, ctr: 20, position: 5 },
              { keys: ["see http://evil.example.net/x"], clicks: 1, impressions: 10, ctr: 10, position: 6 },
            ].concat(data.gscQuery(c, o).slice(0, 0)),
    });
    const report = await fixtureReport({ homeDir: h, template: "x", include: [] }, deps, evil);
    const doc = buildReportDoc(report, { version: "0.1.0", narrative: { summary: "<script>alert(2)</script> [x](javascript:alert(3))" } });
    const md = toMarkdown(doc);
    const html = toHtml(doc);
    for (const out of [md, html]) expect(out).not.toMatch(/[\u202e\u2066\u200b]/);
    expect(html).not.toContain("<img");
    // Markdown: nothing becomes a link or raw HTML; table cells keep their columns.
    // Code spans are literal text; outside them nothing may open a link or a tag.
    const outsideCode = md.replace(/(`+)(?:(?!\1).)+\1/g, "");
    expect(outsideCode).not.toMatch(/(?<!\\)\[/);
    expect(outsideCode).not.toMatch(/(?<!\\)</);
    expect(md).toContain("a \\| b");
    expect(md).toContain("`see http://evil.example.net/x`");
    for (const line of md.split("\n").filter((l) => l.startsWith("| ") && l.includes("a \\| b"))) expect(line.split(/(?<!\\)\|/).length).toBe(7);
    // HTML: the CSP meta, no script, no external resources, no event handlers.
    expect(html).toContain(`<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
    expect(html).not.toMatch(/<script|<link|<iframe|<object|<embed/i);
    expect(html).not.toMatch(/\s(src|href|action|srcset)\s*=\s*["']?\s*(https?:|\/\/|javascript:)/i);
    expect(html).not.toMatch(/<[^>]+\son[a-z]+\s*=/i);
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("the docs variant has no logo and no <style>, and plain bordered tables", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.1.0", logo: { mime: "image/png", data: Buffer.from("png") } });
    const file = toHtml(doc);
    const docs = toHtml(doc, { variant: "docs" });
    expect(file).toContain('src="data:image/png;base64,');
    expect(docs).not.toContain("<img");
    expect(docs).not.toContain("<style");
    expect(docs).toContain('<table border="1"');
  });
});

describe("escaping helpers", () => {
  it("Markdown escapes specials and line-start markers; code spans can't be closed from inside", () => {
    expect(escapeMarkdown("# title")).toBe("\\# title");
    expect(escapeMarkdown("a*b_c`d[e]f<g>h|i\\j")).toBe("a\\*b\\_c\\`d\\[e\\]f\\<g\\>h\\|i\\\\j");
    expect(escapeMarkdown("line\nbreak")).toBe("line break");
    expect(markdownCode("a`b")).toBe("``a`b``");
    expect(markdownCode("x|y")).toBe("`x\\|y`");
  });

  it("block markers at the start can't make headings, fences, breaks, setext lines, lists or code blocks (SEC-2)", () => {
    const cases: [string, string][] = [
      ["~~~", "\\~\\~\\~"],
      ["```js", "\\`\\`\\`js"],
      ["---", "\\---"],
      ["===", "\\==="],
      ["    indented code", "indented code"],
      ["\t- item", "\\- item"],
      ["+ plus", "\\+ plus"],
      ["12. twelve", "12\\. twelve"],
      ["3) three", "3\\) three"],
      ["## h2", "\\## h2"],
      ["a ~~strike~~", "a \\~\\~strike\\~\\~"],
    ];
    for (const [input, want] of cases) expect(escapeMarkdown(input), JSON.stringify(input)).toBe(want);
    // Mid-line runs keep their spacing and get no block-marker escape.
    expect(escapeMarkdown(" (phone) - 3", false)).toBe(" (phone) - 3");
  });

  it("Markdown output of hostile block markers in data and commentary (SEC-2)", async () => {
    const h = home();
    mkdirSync(join(h, "config"), { recursive: true });
    const hostile = ["---", "~~~ fence", "    indented code", "1.one", "# heading", "===", "+ plus"];
    writeFileSync(
      join(h, "config", "report-templates.yaml"),
      `version: 1\ntemplates:\n  x:\n    title: X\n    sections:\n${hostile.map((t, i) => `      - { id: t${i}, type: text, text: ${JSON.stringify(t)} }`).join("\n")}\n`,
    );
    const report = await fixtureReport({ homeDir: h, template: "x", include: [] });
    const md = toMarkdown(buildReportDoc(report, { version: "0.1.0", narrative: { summary: hostile.join("\n\n") } }));
    await expect(md).toMatchFileSnapshot("fixtures/reports/__snapshots__/block-markers.md");
    // Between the renderer's own title heading and its footer separator, every line comes from data or commentary.
    const all = md.split("\n");
    const body = all.slice(all.indexOf("## Summary") + 1, all.lastIndexOf("---"));
    for (const line of body) {
      expect(line, line).not.toMatch(/^(> )?(---|~~~|===|    |\d+\. |# |\+ )/);
    }
    expect(md).toContain("\\---");
    expect(md).toContain("> \\~\\~\\~ fence");
  });
});

describe("narrative subset", () => {
  it("paragraphs, bullets and bold; everything else literal; control characters removed", () => {
    expect(parseNarrative("One **two** three.\nSame paragraph.\n\n- a\n- **b**\n\n# not a heading <i>x</i>\u202e")).toEqual([
      { kind: "p", runs: [{ t: "One " }, { t: "two", b: true }, { t: " three. Same paragraph." }] },
      { kind: "ul", items: [[{ t: "a" }], [{ t: "b", b: true }]] },
      { kind: "p", runs: [{ t: "# not a heading <i>x</i>" }] },
    ]);
    expect(parseNarrative("**unclosed bold")).toEqual([{ kind: "p", runs: [{ t: "**unclosed bold" }] }]);
  });

  it("limits: 20,000 per text, 100,000 in total, known section ids only", () => {
    expect(() => validateNarrative({ summary: "x".repeat(20_001) }, [])).toThrow(/20,000/);
    const sections = Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`s${i}`, "x".repeat(17_000)]));
    expect(() => validateNarrative({ sections }, Object.keys(sections))).toThrow(/100,000/);
    expect(() => validateNarrative({ sections: { nope: "x" } }, ["search"])).toThrow(/nope.*search/);
    expect(() => validateNarrative({ summary: "ok", sections: { search: "fine" } }, ["search"])).not.toThrow();
  });
});
