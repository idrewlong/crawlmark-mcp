/**
 * Release 0.4.0 T2: the Word themes. Cards equals the 0.3.0 goldens (test/design-compat.test.ts); here each theme's
 * styles.xml is snapshotted and the P-C6 cover, heading, table, KPI and callout values are asserted on document.xml.
 */
import { join } from "node:path";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc, type BuildOptions } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { themePalette } from "../src/reports/render/themes/palette.js";
import { THEME_IDS, type ThemeId } from "../src/reports/templates/schema.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const SNAP = join(import.meta.dirname, "fixtures", "reports", "__snapshots__", "themes");
const NARRATIVE = { summary: "Clicks grew **12%**.\n\n- One\n- Two", sections: { search: "Search is **up**.\n\n- Clicks rose" } };
const PRIMARY = "#224466";
const norm = (s: string) => s.replace(/ w:rsid\w*="[^"]*"/g, "").replace(/<wp:docPr id="\d+"/g, '<wp:docPr id="0"').replace(/r:id="rId[\w-]{20,}"/g, 'r:id="rIdX"');

async function files(theme: ThemeId, extra: Partial<BuildOptions> = {}, contents = false) {
  const report = await fixtureReport();
  if (contents) report.template = { ...report.template, contents: true };
  const doc = buildReportDoc(report, { version: "0.4.0", narrative: NARRATIVE, ...extra, branding: { primaryColor: PRIMARY, accentColor: "#cc6600", hideCrawlmark: true, ...extra.branding }, theme });
  const zip = await JSZip.loadAsync(await toDocx(doc));
  return { document: norm(await zip.file("word/document.xml")!.async("string")), styles: norm(await zip.file("word/styles.xml")!.async("string")) };
}
const hexOf = (c: string) => c.replace("#", "").toUpperCase();
const pal = themePalette(PRIMARY, "#cc6600");
/** The first top-level table in the body is the cover. */
const coverCell = (document: string) => /<w:tbl>[\s\S]*?<\/w:tbl>/.exec(document)![0];
const heading2Paras = (document: string) => [...document.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:pStyle w:val="Heading2"\/>[\s\S]*?<\/w:p>/g)].map((m) => m[0]);

describe("docx themes", () => {
  it("editorial's default run font is Georgia (cards stays Calibri)", async () => {
    expect((await files("editorial")).styles).toMatch(/<w:rFonts[^>]*w:ascii="Georgia"/);
    expect((await files("cards")).styles).toMatch(/<w:rFonts[^>]*w:ascii="Calibri"/);
  });

  it.each(THEME_IDS as readonly ThemeId[])("%s styles.xml matches its snapshot", async (id) => {
    await expect((await files(id)).styles).toMatchFileSnapshot(join(SNAP, `${id}.styles.xml`));
  });

  describe("cover", () => {
    const fill = (id: ThemeId) => files(id).then((f) => /<w:shd [^>]*w:fill="(\w+)"/.exec(coverCell(f.document))?.[1]);
    it("fill: primary for cards and friendly, dark for bold, none otherwise", async () => {
      expect(await fill("cards")).toBe(hexOf(PRIMARY));
      expect(await fill("friendly")).toBe(hexOf(PRIMARY));
      expect(await fill("bold")).toBe(hexOf(pal.dark));
      for (const id of ["minimal", "editorial", "consulting"] as const) expect(await fill(id), id).toBeUndefined();
    });

    it("border side and size", async () => {
      const side = async (id: ThemeId) => {
        const cell = coverCell((await files(id)).document);
        const b = /<w:tcBorders>([\s\S]*?)<\/w:tcBorders>/.exec(cell)![1]!;
        return Object.fromEntries([...b.matchAll(/<w:(top|bottom|left|right) w:val="(\w+)"[^>]*w:sz="(\d+)"/g)].filter((m) => m[2] === "single").map((m) => [m[1], Number(m[3])]));
      };
      expect(await side("cards")).toEqual({ bottom: 36 });
      expect(await side("minimal")).toEqual({ bottom: 8 });
      expect(await side("editorial")).toEqual({ top: 80 });
      expect(await side("bold")).toEqual({ bottom: 40 });
      expect(await side("consulting")).toEqual({ left: 96 });
      expect(await side("friendly")).toEqual({});
    });

    it("bold with primaryColor #ffd400: the fill is dark and the title run is white", async () => {
      const { document } = await files("bold", { branding: { primaryColor: "#ffd400" } });
      const cell = coverCell(document);
      const dark = hexOf(themePalette("#ffd400", "#5b9bd5").dark);
      expect(/<w:shd [^>]*w:fill="(\w+)"/.exec(cell)![1]).toBe(dark);
      const title = /<w:pStyle w:val="Title"\/>[\s\S]*?<\/w:p>/.exec(cell)![0];
      expect(title).toContain('<w:color w:val="FFFFFF"/>');
    });
  });

  describe("Heading 2", () => {
    const run = async (id: ThemeId) => {
      const h = heading2Paras((await files(id)).document).find((p) => p.includes("Search")) ?? heading2Paras((await files(id)).document)[0]!;
      return h;
    };
    it("run size, weight and colour", async () => {
      const cards = await run("cards");
      expect(cards).toContain('<w:sz w:val="28"/>');
      expect(cards).toContain("<w:b/>");
      expect(cards).toContain(`<w:color w:val="${hexOf(pal.primaryInk)}"/>`);
      const editorial = await run("editorial");
      expect(editorial).toContain('<w:sz w:val="40"/>');
      expect(editorial).not.toContain("<w:b/>");
      const bold = await run("bold");
      expect(bold).toContain('<w:sz w:val="30"/>');
      expect(bold).toContain("<w:b/>");
      expect(bold).toContain(`<w:color w:val="${hexOf(pal.dark)}"/>`);
      const friendly = await run("friendly");
      expect(friendly).toContain(`<w:color w:val="${hexOf(pal.tintInk)}"/>`);
      expect(friendly).toContain(`w:fill="${hexOf(pal.tint)}"`);
      expect(await run("minimal")).not.toContain("<w:b/>");
    });
    it("paragraph rules", async () => {
      expect(await run("cards")).toMatch(/<w:pBdr><w:bottom [^>]*w:sz="6"/);
      expect(await run("minimal")).toMatch(/<w:pBdr><w:top [^>]*w:sz="8"/);
      expect(await run("editorial")).toMatch(/<w:pBdr><w:bottom [^>]*w:sz="8"/);
      expect(await run("bold")).toMatch(/<w:pBdr><w:bottom [^>]*w:color="224466"[^>]*w:sz="24"/);
      expect(await run("consulting")).toMatch(/<w:pBdr><w:top [^>]*w:sz="8"/);
      expect(await run("friendly")).not.toContain("<w:pBdr>");
    });
  });

  describe("tables, KPI cells and callouts", () => {
    it("header caps, zebra and the commentary fill", async () => {
      const caps = { cards: true, minimal: true, editorial: false, bold: true, consulting: true, friendly: false } as const;
      const zebra = { cards: "F7F8FA", minimal: null, editorial: null, bold: "F7F9FB", consulting: null, friendly: hexOf(pal.wash) } as const;
      const callout = { cards: hexOf(pal.warm), minimal: null, editorial: "FAF8F3", bold: "F5F7FA", consulting: "F6F7F9", friendly: hexOf(pal.warm) } as const;
      for (const id of THEME_IDS as readonly ThemeId[]) {
        const { document } = await files(id);
        const tables = document.split("<w:tbl>").slice(1).map((t) => t.split("</w:tbl>")[0]!);
        const data = tables.find((t) => t.includes("w:tblHeader"))!;
        expect(data.includes("<w:caps/>"), `${id} caps`).toBe(caps[id]);
        const z = zebra[id];
        expect(z ? data.includes(`w:fill="${z}"`) : !/w:fill="(F7F8FA|F7F9FB)"/.test(data) && !data.includes(`w:fill="${hexOf(pal.wash)}"`), `${id} zebra`).toBe(true);
        const box = tables.find((t) => t.includes("Commentary"))!;
        const cf = callout[id];
        expect(cf ? box.includes(`w:fill="${cf}"`) : !box.includes("w:shd"), `${id} callout`).toBe(true);
      }
    });

    it("the summary box stays a shade lighter than the commentary box in cards only", async () => {
      const { document } = await files("cards");
      const summaryTable = document.split("<w:tbl>").find((t) => t.includes("Summary"))!;
      expect(summaryTable).toContain('w:fill="');
      expect(summaryTable.includes(`w:fill="${hexOf(pal.warm)}"`)).toBe(false);
    });

    it("KPI cells carry the P-C6 values", async () => {
      const kpi = async (id: ThemeId) => {
        const { document } = await files(id);
        return document.split("<w:tbl>").find((t) => t.includes("<w:sz w:val=\"" + { cards: 40, minimal: 44, editorial: 52, bold: 56, consulting: 48, friendly: 40 }[id] + "\"/>"))!;
      };
      expect(await kpi("cards")).toContain('w:fill="F1F4F8"');
      expect(await kpi("minimal")).toMatch(/<w:left w:val="single" w:color="E6E8EB" w:sz="8"/);
      expect(await kpi("editorial")).toMatch(/<w:top w:val="single" w:color="1F2933" w:sz="24"/);
      expect(await kpi("bold")).toMatch(/<w:top w:val="single" w:color="224466" w:sz="32"/);
      expect(await kpi("consulting")).toMatch(/<w:left w:val="single" w:color="D9DDE2" w:sz="8"/);
      expect(await kpi("friendly")).toMatch(/<w:right w:val="single" w:color="E3E8EF" w:sz="8"/);
    });
  });

  describe("consulting numbering", () => {
    it("section headings start with 01, 02, ... and contents entries carry the same numbers", async () => {
      const { document } = await files("consulting", {}, true);
      const text = (p: string) => [...p.matchAll(/<w:t[^>]*>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("");
      const heads = heading2Paras(document).map(text);
      expect(heads[0]).toBe("Contents");
      const numbered = heads.slice(1);
      expect(numbered.length).toBeGreaterThan(2);
      numbered.forEach((h, i) => expect(h.startsWith(String(i + 1).padStart(2, "0")), h).toBe(true));
      const entries = [...document.matchAll(/<w:p>(?:(?!<\/w:p>)[\s\S])*?<w:hyperlink[\s\S]*?<\/w:p>/g)].map((m) => text(m[0]));
      expect(entries.length).toBe(numbered.length);
      entries.forEach((e, i) => expect(e.startsWith(`${String(i + 1).padStart(2, "0")}.`), e).toBe(true));
      expect(numbered.at(-1)).toContain("About this report");
    });
    it("other themes do not number", async () => {
      const heads = heading2Paras((await files("minimal", {}, true)).document);
      expect(heads.every((h) => !/<w:t[^>]*>0\d</.test(h))).toBe(true);
    });
  });

  describe("fonts", () => {
    it.each(THEME_IDS as readonly ThemeId[])("%s: branding bodyFont beats the theme font; headings follow the body font", async (id) => {
      const { styles, document } = await files(id, { branding: { bodyFont: "Inter" } });
      expect(styles).toMatch(/<w:docDefaults>[\s\S]*?w:ascii="Inter"/);
      expect(styles).not.toMatch(/w:ascii="(Georgia|Arial Black|Trebuchet MS)"/);
      expect(styles).toMatch(/w:styleId="Heading2"[\s\S]*?w:ascii="Inter"/);
      expect(document).not.toContain("Arial Black");
    });
    it("bold headings use Arial Black unless the branding says otherwise", async () => {
      expect((await files("bold")).styles).toMatch(/w:styleId="Heading2"[\s\S]*?w:ascii="Arial Black"/);
      expect((await files("bold", { branding: { headingFont: "Merriweather" } })).styles).toMatch(/w:styleId="Heading2"[\s\S]*?w:ascii="Merriweather"/);
    });
  });

  it("an XSS string in the client name stays inert in every theme", async () => {
    for (const id of THEME_IDS as readonly ThemeId[]) {
      const report = await fixtureReport();
      const doc = buildReportDoc({ ...report, clientName: "<script>alert(1)</script>" } as typeof report, { version: "0.4.0", theme: id });
      const zip = await JSZip.loadAsync(await toDocx(doc));
      expect(await zip.file("word/document.xml")!.async("string")).not.toContain("<script>");
    }
  });
});
