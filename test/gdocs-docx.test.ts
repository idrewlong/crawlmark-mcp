/** 0.5.0 (Y4): the docs variant of the Word file (Google Docs copy): charts as tables, logo up to 48 KB, theme kept. */
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildReportDoc, type Chart, type ReportDoc } from "../src/reports/render/doc.js";
import { MAX_DOCS_LOGO_BYTES, toDocx } from "../src/reports/render/docx.js";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { fixtureReport, TINY_PNG } from "./fixtures/reports/report.js";

const parts = async (buf: Buffer) => {
  const zip = await JSZip.loadAsync(buf);
  return { zip, names: Object.keys(zip.files).filter((f) => !zip.files[f]!.dir), text: (f: string) => zip.file(f)!.async("string") };
};
const png = (bytes: number) => ({ mime: "image/png" as const, data: Buffer.concat([TINY_PNG, Buffer.alloc(bytes - TINY_PNG.length, 7)]) });

async function monthly(extra: Partial<Parameters<typeof buildReportDoc>[1]> = {}, contents = false): Promise<ReportDoc> {
  const report = await fixtureReport();
  if (contents) report.template = { ...report.template, contents: true };
  return buildReportDoc(report, { version: "0.5.0", narrative: { summary: "Clicks grew **12%**.", sections: {} }, ...extra });
}

const charts = (doc: ReportDoc): Chart[] => doc.sections.flatMap((s) => s.blocks.flatMap((b) => (b.kind === "chart" ? [b.chart] : [])));

describe("docx docs variant", () => {
  it("has no chart or embedding parts, and shows each chart's fallback table", async () => {
    const doc = await monthly();
    const file = await parts(await toDocx(doc));
    expect(file.names.some((n) => n.startsWith("word/charts/"))).toBe(true);
    const docs = await parts(await toDocx(doc, { variant: "docs" }));
    expect(docs.names.filter((n) => n.startsWith("word/charts/") || n.startsWith("word/embeddings/"))).toEqual([]);
    const xml = await docs.text("word/document.xml");
    expect(xml).not.toContain("<c:chart");
    const withFallback = charts(doc).filter((c) => c.fallback?.title);
    expect(withFallback.length).toBeGreaterThan(0);
    for (const c of withFallback) expect(xml).toContain(c.fallback!.title!.replace(/&/g, "&amp;"));
  });

  it("the default and variant: \"file\" are identical", async () => {
    const doc = await monthly();
    const [pa, pb] = [await parts(await toDocx(doc)), await parts(await toDocx(doc, { variant: "file" }))];
    expect(pb.names).toEqual(pa.names);
    // docProps carry a timestamp and the library draws random relationship ids and a running drawing id for charts; compare the rest.
    const norm = (x: string) => x.replace(/rId[^"<\s]{15,}/g, "rIdX").replace(/<wp:docPr id="\d+"/g, '<wp:docPr id="N"');
    // Embedded chart workbooks are zips with their own file timestamps; compare what's inside them.
    const xlsx = async (z: JSZip, n: string) => {
      const inner = await JSZip.loadAsync(await z.file(n)!.async("uint8array"));
      const names = Object.keys(inner.files).filter((f) => !inner.files[f]!.dir).sort();
      return (await Promise.all(names.map(async (f) => `${f}\n${await inner.file(f)!.async("string")}`))).join("\n");
    };
    for (const n of pa.names) {
      if (n.startsWith("docProps/")) continue;
      const [x, y] = n.endsWith(".xlsx") ? [await xlsx(pa.zip, n), await xlsx(pb.zip, n)] : [norm(await pa.text(n)), norm(await pb.text(n))];
      let i = 0;
      while (i < x.length && x[i] === y[i]) i++;
      expect(y, `${n} differs at ${i}: ${x.slice(Math.max(0, i - 60), i + 60)} | ${y.slice(Math.max(0, i - 60), i + 60)}`).toBe(x);
    }
  });

  for (const theme of THEME_IDS) {
    it(`${theme}: styles.xml equals the file variant's; the cover keeps its fill`, async () => {
      const doc = await monthly({ theme, branding: { primaryColor: "#224466" } });
      const file = await parts(await toDocx(doc));
      const docs = await parts(await toDocx(doc, { variant: "docs" }));
      expect(await docs.text("word/styles.xml")).toBe(await file.text("word/styles.xml"));
      const xml = await docs.text("word/document.xml");
      if (theme === "bold") expect(xml).toMatch(/<w:shd [^>]*w:fill="[0-9A-F]{6}"/);
      if (theme === "friendly") expect(xml).toContain('w:fill="224466"');
    });
  }

  it("keeps the contents bookmarks and links", async () => {
    const docs = await parts(await toDocx(await monthly({}, true), { variant: "docs" }));
    const xml = await docs.text("word/document.xml");
    expect(xml).toContain("<w:bookmarkStart");
    expect(xml).toContain("w:anchor=");
  });

  it("keeps a 40 KB logo and leaves out a 60 KB one", async () => {
    const withLogo = await parts(await toDocx(await monthly({ logo: png(40_000) }), { variant: "docs" }));
    expect(withLogo.names.some((n) => n.startsWith("word/media/"))).toBe(true);
    const big = await parts(await toDocx(await monthly({ logo: png(60_000) }), { variant: "docs" }));
    expect(big.names.some((n) => n.startsWith("word/media/"))).toBe(false);
    // The file variant keeps the big logo.
    const file = await parts(await toDocx(await monthly({ logo: png(60_000) })));
    expect(file.names.some((n) => n.startsWith("word/media/"))).toBe(true);
    expect(MAX_DOCS_LOGO_BYTES).toBe(48 * 1024);
  });
});
