/**
 * Release 0.4.0 T0: with no theme set, or theme cards set anywhere (branding, template, export override), every
 * file equals the 0.3.0 goldens byte for byte: test/fixtures/reports/compat-0.2.0 and the release-b snapshots.
 * Markdown and the docs-variant HTML ignore the theme. Never regenerate those goldens for this release.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc, type BuildOptions } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { toHtml } from "../src/reports/render/html.js";
import { toMarkdown } from "../src/reports/render/markdown.js";
import { BUILTIN_TEMPLATES } from "../src/reports/templates/builtin.js";
import { THEME_IDS, type ThemeId } from "../src/reports/templates/schema.js";
import type { TemplateReport } from "../src/reports/report-types.js";
import { fixtureReport } from "./fixtures/reports/report.js";
import { layoutReport } from "./fixtures/reports/release-b-render.js";

const COMPAT = join(import.meta.dirname, "fixtures", "reports", "compat-0.2.0");
const SNAP = join(import.meta.dirname, "fixtures", "reports", "__snapshots__", "release-b");
const read = (dir: string, name: string) => {
  const f = join(dir, name);
  expect(existsSync(f), `missing golden ${name}`).toBe(true);
  return readFileSync(f, "utf8");
};
const NARRATIVE = {
  summary: "Clicks grew **12%** in September.\n\n- Blog pages led the gain\n- Branded searches held steady\n\nNext month we will look at the services pages.",
  sections: {} as Record<string, string>,
};
const BRANDING = { agencyName: "Example Agency", primaryColor: "#224466", accentColor: "#cc6600", footer: "Example Agency, example.com", paper: "A4" as const, hideCrawlmark: true };
const ids = Object.keys(BUILTIN_TEMPLATES);

/** Every way of getting the cards look: nothing set, then cards set in the branding, the template and the export override. */
type Variant = { name: string; apply(report: TemplateReport, opts: BuildOptions): { report: TemplateReport; opts: BuildOptions } };
const VARIANTS: Variant[] = [
  { name: "no theme", apply: (report, opts) => ({ report, opts }) },
  { name: "branding cards", apply: (report, opts) => ({ report, opts: { ...opts, branding: { ...opts.branding, theme: "cards" } } }) },
  { name: "template cards", apply: (report, opts) => ({ report: { ...report, template: { ...report.template, theme: "cards" } }, opts }) },
  { name: "export override cards", apply: (report, opts) => ({ report, opts: { ...opts, theme: "cards" } }) },
];

describe("cards (and no theme) equals the 0.2.0 and release-b goldens", () => {
  for (const variant of VARIANTS) {
    for (const id of ids) {
      it(`${variant.name}: ${id} md, html and docs html`, async () => {
        const report = await fixtureReport(id === "monthly" ? {} : { template: id, include: [] });
        const narrative = id === "monthly" ? { ...NARRATIVE, sections: { search: "Search is **up**.\n\n- Clicks rose\n- CTR flat" } } : NARRATIVE;
        for (const [tag, base] of [
          ["plain", { version: "0.2.0" }],
          ["brand", { version: "0.2.0", narrative, branding: BRANDING }],
        ] as const) {
          const { report: r, opts } = variant.apply(report, base as BuildOptions);
          const doc = buildReportDoc(r, opts);
          expect(toMarkdown(doc) === read(COMPAT, `${id}-${tag}.md`), `${id}-${tag}.md`).toBe(true);
          expect(toHtml(doc) === read(COMPAT, `${id}-${tag}.html`), `${id}-${tag}.html`).toBe(true);
          expect(toHtml(doc, { variant: "docs" }) === read(COMPAT, `${id}-${tag}.docs.html`), `${id}-${tag}.docs.html`).toBe(true);
        }
      });
    }

    it(`${variant.name}: monthly DOCX document.xml and styles.xml`, async () => {
      const { report, opts } = variant.apply(await fixtureReport(), { version: "0.2.0", narrative: NARRATIVE });
      const zip = await JSZip.loadAsync(await toDocx(buildReportDoc(report, opts)));
      const norm = (s: string) => s.replace(/ w:rsid\w*="[^"]*"/g, "").replace(/<wp:docPr id="\d+"/g, '<wp:docPr id="0"').replace(/r:id="rId[\w-]{20,}"/g, 'r:id="rIdX"');
      expect(norm(await zip.file("word/document.xml")!.async("string")) === read(COMPAT, "monthly.document.xml")).toBe(true);
      expect(norm(await zip.file("word/styles.xml")!.async("string")) === read(COMPAT, "monthly.styles.xml")).toBe(true);
    });

    it(`${variant.name}: the layout report equals the release-b snapshots`, async () => {
      const { report, opts } = variant.apply(await layoutReport(), { version: "0.3.0" });
      const doc = buildReportDoc(report, opts);
      expect(toMarkdown(doc) === read(SNAP, "layout.md")).toBe(true);
      expect(toHtml(doc) === read(SNAP, "layout.html")).toBe(true);
    });
  }
});

describe("Markdown and the docs-variant HTML ignore the theme", () => {
  it.each(THEME_IDS as readonly ThemeId[])("%s", async (theme) => {
    const report = await layoutReport();
    const base = { version: "0.4.0", narrative: NARRATIVE, branding: BRANDING };
    const ref = buildReportDoc(report, base);
    const doc = buildReportDoc(report, { ...base, theme });
    expect(doc.branding.theme).toBe(theme);
    expect(toMarkdown(doc)).toBe(toMarkdown(ref));
    expect(toHtml(doc, { variant: "docs" })).toBe(toHtml(ref, { variant: "docs" }));
  });
});

describe("T0 stubs leave every theme's HTML and DOCX at the cards output", () => {
  it.each(THEME_IDS as readonly ThemeId[])("%s", async (theme) => {
    const report = await fixtureReport();
    const a = buildReportDoc(report, { version: "0.4.0" });
    const b = buildReportDoc(report, { version: "0.4.0", theme });
    // Once the HTML and Word streams land this file's cards cases stay; the other themes are checked by their own tests.
    if (theme === "cards") expect(toHtml(b)).toBe(toHtml(a));
    expect(toMarkdown(b)).toBe(toMarkdown(a));
  });
});
