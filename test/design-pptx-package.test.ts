/**
 * 0.4.0 T3a: the PPTX package (hand-written decks; chartPart stubbed with a fixed chart part). Content types,
 * relationships, presentation order and ids, title placeholders, notes, docProps, determinism, guards.
 */
import { posix } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { THEME_IDS } from "../src/reports/templates/schema.js";
import { childNames, fixedChartPart, fixtureDeck, styleFor, text, unzip, wellFormed, xmlParts } from "./fixtures/pptx/decks.js";
import { TINY_PNG } from "./fixtures/reports/report.js";

vi.mock("../src/reports/render/pptx/charts.js", async () => {
  const { fixedChartPart } = await import("./fixtures/pptx/decks.js");
  return { chartPart: vi.fn(async () => fixedChartPart()) };
});

const { renderDeck } = await import("../src/reports/render/pptx/index.js");
const { checkPackage } = await import("../src/reports/render/pptx/package.js");
const { chartPart } = await import("../src/reports/render/pptx/charts.js");

const deck = fixtureDeck({ logo: true });
const style = styleFor("cards", { logo: { mime: "image/png", data: TINY_PNG } });

describe("renderDeck package", () => {
  it("returns a zip with ppt/presentation.xml", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    expect(zip.file("ppt/presentation.xml")).not.toBeNull();
  });

  it("has a content type for every part, resolving relationships and no external targets", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    const ct = await text(zip, "[Content_Types].xml");
    const defaults = new Set([...ct.matchAll(/<Default Extension="(\w+)"/g)].map((m) => m[1]));
    const overrides = new Set([...ct.matchAll(/<Override PartName="\/([^"]+)"/g)].map((m) => m[1]));
    const names = Object.keys(zip.files).filter((n) => !zip.files[n]!.dir);
    expect(names.every((n) => !n.endsWith("/"))).toBe(true);
    for (const n of names) if (n !== "[Content_Types].xml") expect(overrides.has(n) || defaults.has(n.slice(n.lastIndexOf(".") + 1)), n).toBe(true);
    for (const o of overrides) expect(names, o).toContain(o);
    for (const n of names.filter((x) => x.endsWith(".rels"))) {
      const xml = await text(zip, n);
      expect(xml).not.toMatch(/TargetMode/);
      const base = n === "_rels/.rels" ? "" : posix.dirname(posix.dirname(n));
      for (const m of xml.matchAll(/Target="([^"]+)"/g)) expect(names, `${n} → ${m[1]}`).toContain(posix.normalize(posix.join(base, m[1]!)));
    }
    expect(defaults).toEqual(new Set(["rels", "xlsx", "png"]));
  });

  it("every XML part is well formed, for every theme", async () => {
    for (const id of THEME_IDS) {
      const zip = await unzip(await renderDeck(deck, styleFor(id, { logo: { mime: "image/png", data: TINY_PNG } })));
      for (const [name, xml] of await xmlParts(zip)) expect(wellFormed(xml), `${id} ${name}`).toBeNull();
    }
  });

  it("presentation.xml: children in order, 16:9, slide ids from 256, master id 2147483648", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    const xml = await text(zip, "ppt/presentation.xml");
    expect(childNames(xml, "p:presentation")).toEqual(["p:sldMasterIdLst", "p:notesMasterIdLst", "p:sldIdLst", "p:sldSz", "p:notesSz", "p:defaultTextStyle"]);
    expect(xml).toContain(`<p:sldSz cx="12192000" cy="6858000"/>`);
    expect(xml).toContain(`<p:sldMasterId id="2147483648"`);
    expect([...xml.matchAll(/<p:sldId id="(\d+)"/g)].map((m) => Number(m[1]))).toEqual(deck.slides.map((_, i) => 256 + i));
    const master = await text(zip, "ppt/slideMasters/slideMaster1.xml");
    expect(childNames(master, "p:sldMaster")).toEqual(["p:cSld", "p:clrMap", "p:sldLayoutIdLst", "p:txStyles"]);
    expect([...master.matchAll(/<p:sldLayoutId id="(\d+)"/g)].map((m) => m[1])).toEqual(["2147483649", "2147483650"]);
    for (const n of [1, 2]) expect(childNames(await text(zip, `ppt/slideLayouts/slideLayout${n}.xml`), "p:sldLayout")).toEqual(["p:cSld", "p:clrMapOvr"]);
    const rels = await text(zip, "ppt/_rels/presentation.xml.rels");
    const targets = [...rels.matchAll(/Target="([^"]+)"/g)].map((m) => m[1]);
    expect(targets).toEqual(["slideMasters/slideMaster1.xml", ...deck.slides.map((_, i) => `slides/slide${i + 1}.xml`), "notesMasters/notesMaster1.xml", "theme/theme1.xml", "presProps.xml", "viewProps.xml", "tableStyles.xml"]);
    expect(await text(zip, "ppt/tableStyles.xml")).toContain(`<a:tblStyleLst xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>`);
  });

  it("element order inside slides: sld, spTree, sp, txBody, pic, graphicFrame", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    for (let i = 1; i <= deck.slides.length; i++) {
      const xml = await text(zip, `ppt/slides/slide${i}.xml`);
      expect(childNames(xml, "p:sld")).toEqual(["p:cSld", "p:clrMapOvr"]);
      expect(childNames(xml, "p:spTree").slice(0, 2)).toEqual(["p:nvGrpSpPr", "p:grpSpPr"]);
      for (const sp of xml.match(/<p:sp>.*?<\/p:sp>/g) ?? []) expect(childNames(sp, "p:sp").join(",")).toMatch(/^p:nvSpPr,p:spPr(,p:txBody)?$/);
      for (const tx of xml.match(/<p:txBody>.*?<\/p:txBody>/g) ?? []) expect(childNames(tx, "p:txBody").slice(0, 2)).toEqual(["a:bodyPr", "a:lstStyle"]);
      for (const pic of xml.match(/<p:pic>.*?<\/p:pic>/g) ?? []) expect(childNames(pic, "p:pic")).toEqual(["p:nvPicPr", "p:blipFill", "p:spPr"]);
      for (const gf of xml.match(/<p:graphicFrame>.*?<\/p:graphicFrame>/g) ?? []) expect(childNames(gf, "p:graphicFrame")).toEqual(["p:nvGraphicFramePr", "p:xfrm", "a:graphic"]);
      for (const tbl of xml.match(/<a:tbl>.*?<\/a:tbl>/g) ?? []) expect(childNames(tbl, "a:tbl").slice(0, 2)).toEqual(["a:tblPr", "a:tblGrid"]);
      for (const tc of xml.match(/<a:tcPr[^>]*>.*?<\/a:tcPr>/g) ?? []) expect(childNames(tc, "a:tcPr").slice(0, 4)).toEqual(["a:lnL", "a:lnR", "a:lnT", "a:lnB"]);
      for (const r of xml.match(/<a:rPr[^>]*>.*?<\/a:rPr>/g) ?? []) expect(childNames(r, "a:rPr")[0]).toBe("a:solidFill");
      // shape ids are unique per slide
      const ids = [...xml.matchAll(/<p:cNvPr id="(\d+)"/g)].map((m) => m[1]);
      expect(new Set(ids).size, `slide ${i}`).toBe(ids.length);
    }
  });

  it("every slide has a title placeholder holding the slide title", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    for (const [i, s] of deck.slides.entries()) {
      const xml = await text(zip, `ppt/slides/slide${i + 1}.xml`);
      const sp = (xml.match(/<p:sp>.*?<\/p:sp>/g) ?? []).find((x) => /<p:ph type="(ctrTitle|title)"/.test(x));
      expect(sp, `slide ${i + 1}`).toBeDefined();
      // A continuation slide's title ends in a muted "continued" tag instead of "(continued)".
      const title = "continued" in s && s.continued ? s.title.replace(/ \(continued\)$/, "   continued") : s.title;
      expect([...sp!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join("")).toBe(title.replace(/&/g, "&amp;"));
      expect(xml.indexOf("<p:sp>")).toBe(xml.indexOf(sp!));
    }
  });

  it("notes slides exist exactly for slides with notes, with that text", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    for (const [i, s] of deck.slides.entries()) {
      const notes = zip.file(`ppt/notesSlides/notesSlide${i + 1}.xml`);
      const rels = await text(zip, `ppt/slides/_rels/slide${i + 1}.xml.rels`);
      const n = "notes" in s ? s.notes : undefined;
      if (!n) {
        expect(notes, `slide ${i + 1}`).toBeNull();
        expect(rels).not.toContain("notesSlide");
        continue;
      }
      const xml = await notes!.async("string");
      const body = (xml.match(/<p:sp>.*?<\/p:sp>/g) ?? []).find((x) => x.includes(`type="body"`))!;
      const lines = [...body.matchAll(/<a:p>(.*?)<\/a:p>/g)].map((p) => [...p[1]!.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map((m) => m[1]).join(""));
      expect(lines.join("\n")).toBe(n);
      expect(rels).toContain(`Target="../notesSlides/notesSlide${i + 1}.xml"`);
      const nrels = await text(zip, `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`);
      expect(nrels).toContain(`Target="../slides/slide${i + 1}.xml"`);
      expect(nrels).toContain(`Target="../notesMasters/notesMaster1.xml"`);
    }
    const app = await text(zip, "docProps/app.xml");
    expect(app).toContain(`<Notes>${deck.slides.filter((s) => "notes" in s && s.notes).length}</Notes>`);
    expect(app).toContain(`<Slides>${deck.slides.length}</Slides>`);
  });

  it("docProps: author, company, dates; every zip entry dated generatedAt", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    const core = await text(zip, "docProps/core.xml");
    expect(core).toContain("<dc:creator>crawlmark</dc:creator>");
    expect(core).toContain("<cp:lastModifiedBy>crawlmark</cp:lastModifiedBy>");
    expect(core).toContain(`<dcterms:created xsi:type="dcterms:W3CDTF">2026-10-13T00:00:00Z</dcterms:created>`);
    expect(core).toContain(`<dcterms:modified xsi:type="dcterms:W3CDTF">2026-10-13T00:00:00Z</dcterms:modified>`);
    expect(await text(zip, "docProps/app.xml")).toContain("<Application>crawlmark</Application>");
    for (const f of Object.values(zip.files)) expect(f.date.toISOString(), f.name).toBe("2026-10-13T00:00:00.000Z");

    const wl = await unzip(await renderDeck(fixtureDeck({ author: "Example Agency", company: "Example Agency" }), style));
    expect(await text(wl, "docProps/core.xml")).toContain("<dc:creator>Example Agency</dc:creator>");
    const app = await text(wl, "docProps/app.xml");
    expect(app).toContain("<Application>Example Agency</Application>");
    expect(app).toContain("<Company>Example Agency</Company>");

    const blank = await unzip(await renderDeck(fixtureDeck({ author: "", company: "" }), style));
    for (const [name, xml] of await xmlParts(blank)) expect(xml, name).not.toMatch(/crawlmark|claude|dataforseo/i);
    expect(await text(blank, "docProps/app.xml")).not.toContain("<Application>");
  });

  it("two renders are byte-identical", async () => {
    const a = await renderDeck(deck, style);
    const b = await renderDeck(deck, style);
    expect(a.equals(b)).toBe(true);
    expect(a.subarray(0, 2).toString()).toBe("PK");
  });

  it("charts: one part per chart slide, with its workbook and package relationship", async () => {
    const zip = await unzip(await renderDeck(deck, style));
    const chartSlides = deck.slides.filter((s) => s.kind === "section" && s.chart).length;
    const charts = Object.keys(zip.files).filter((n) => /^ppt\/charts\/chart\d+\.xml$/.test(n));
    expect(charts.length).toBe(chartSlides);
    for (let n = 1; n <= chartSlides; n++) {
      expect(await text(zip, `ppt/charts/_rels/chart${n}.xml.rels`)).toContain(`Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/package" Target="../embeddings/workbook${n}.xlsx"`);
      expect(zip.file(`ppt/embeddings/workbook${n}.xlsx`)).not.toBeNull();
    }
    expect(await text(zip, "[Content_Types].xml")).toContain(`<Override PartName="/ppt/charts/chart1.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`);
    const s5 = await text(zip, "ppt/slides/slide5.xml");
    expect(s5).toContain(`<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId2"/>`);
    expect(s5).toContain(`descr="Clicks rose from 10 to 30 over September."`);
    expect(chartPart).toHaveBeenCalledWith(expect.objectContaining({ title: "Clicks per day" }), { primary: "#1f5ea8", font: "Arial" });
  });

  it("a chart that can't be drawn shows its fallback table, the footnote and a warning (toPptx)", async () => {
    vi.mocked(chartPart).mockResolvedValueOnce(null);
    const zip = await unzip(await renderDeck(deck, style));
    expect(zip.file("ppt/charts/chart2.xml")).toBeNull();
    const s5 = await text(zip, "ppt/slides/slide5.xml");
    expect(s5).not.toContain("drawingml/2006/chart");
    expect(s5).toContain("<a:t>1 Sep</a:t>");
    expect(s5).toContain("More detail in the full report.");
    // the second chart still gets chart1 (numbering follows stored charts)
    expect(await text(zip, "ppt/slides/_rels/slide7.xml.rels")).toContain("../charts/chart1.xml");
  });

  it("a chart that can't be drawn and has no fallback table shows a short placeholder in the chart area", async () => {
    vi.mocked(chartPart).mockResolvedValueOnce(null);
    const d = structuredClone(deck);
    const sec = d.slides[4]!;
    if (sec.kind !== "section" || !sec.chart) throw new Error("fixture changed");
    delete sec.chart.fallback;
    const s5 = await text(await unzip(await renderDeck(d, style)), "ppt/slides/slide5.xml");
    expect(s5).not.toContain("drawingml/2006/chart");
    expect(s5).toContain('name="Chart placeholder"');
    expect(s5).toContain("<a:t>Chart not available in this format; see the full report.</a:t>");
    expect(s5).not.toMatch(/docx|chartPart|null|undefined/i);
  });

  it("guards: a dangling target, an external target and a part without a content type throw", () => {
    const rels = (target: string, extra = "") => `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="x" Target="${target}"${extra}/></Relationships>`;
    expect(() => checkPackage([{ name: "_rels/.rels", data: rels("ppt/missing.xml") }])).toThrow(/missing part/);
    expect(() => checkPackage([{ name: "_rels/.rels", data: rels("https://example.com/", ` TargetMode="External"`) }])).toThrow(/external/);
    expect(() => checkPackage([{ name: "ppt/x.xml", data: "<x/>" }])).toThrow(/no content type/);
    expect(() => checkPackage([{ name: "ppt/x.xml", data: "<x/>", contentType: "application/xml" }, { name: "ppt/_rels/x.xml.rels", data: rels("x.xml") }])).not.toThrow();
  });

  it("an empty deck is refused", async () => {
    await expect(renderDeck({ ...deck, slides: [] }, style)).rejects.toThrow(/no slides/);
  });
});
