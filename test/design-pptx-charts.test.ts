/**
 * T3b: native deck charts harvested from docx's chart generation. The same chartRunOptions feeds Word and
 * PowerPoint, so the chart XML must equal what toDocx writes; and if docx's internal zip layout ever changes,
 * chartPart must return null (the deck then shows the table) rather than throw or write a broken chart.
 */
import JSZip from "jszip";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PRIMARY } from "../src/reports/render/color.js";
import { buildReportDoc, type Block, type Chart, type LineChart, type ShareChart } from "../src/reports/render/doc.js";
import { toDocx } from "../src/reports/render/docx.js";
import { chartPart } from "../src/reports/render/pptx/charts.js";
import { fixtureReport } from "./fixtures/reports/report.js";

const O = { primary: DEFAULT_PRIMARY, font: "Calibri" };
const X = ["2026-09-01", "2026-09-02", "2026-09-03"];

const withPrevious: LineChart = {
  type: "line",
  title: "Clicks",
  x: X,
  series: [
    { name: "This period", values: [10, 12, 15], role: "current" },
    { name: "Last period", values: [8, 9, 11], role: "previous" },
  ],
  format: "count",
  summary: "Clicks rose.",
};
const positions: LineChart = {
  type: "line",
  title: "Average position",
  x: X,
  series: [{ name: "Position", values: [8, 6, 5], role: "current" }],
  format: "position",
  invert: true,
  summary: "Position improved.",
};
const share: ShareChart = {
  type: "share",
  title: "Device share",
  parts: ["Mobile", "Desktop"],
  rows: [{ label: "Example Co", values: [60, 40] }],
  summary: "Mostly mobile.",
};

const unzip = (b: Buffer) => JSZip.loadAsync(b);

function firstChart(blocks: Block[]): Chart | undefined {
  for (const b of blocks) {
    if (b.kind === "chart") return b.chart;
    if (b.kind === "columns") {
      const c = firstChart(b.columns.flat());
      if (c) return c;
    }
  }
  return undefined;
}

describe("chartPart", () => {
  it("builds a native line chart from the fixture's first chart", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.4.0" });
    const chart = doc.sections.map((s) => firstChart(s.blocks)).find(Boolean);
    expect(chart).toBeDefined();
    const part = await chartPart(chart!, O);
    expect(part).not.toBeNull();
    expect(part!.xml).toContain("<c:lineChart>");
  });

  it("dashes only the previous-period series", async () => {
    const { xml } = (await chartPart(withPrevious, O))!;
    const [first, second] = xml.split(/<c:ser>/).slice(1);
    expect(first).toContain('<c:idx val="0"/>');
    expect(first).toContain('<a:prstDash val="solid"/>');
    expect(second).toContain('<c:idx val="1"/>');
    expect(second).toContain('<a:prstDash val="dash"/>');
    expect(xml.match(/<a:prstDash val="dash"\/>/g)).toHaveLength(1);
  });

  it("flips the value axis for positions and stacks shares at 100%", async () => {
    expect((await chartPart(positions, O))!.xml).toContain('<c:orientation val="maxMin"/>');
    const bar = (await chartPart(share, O))!.xml;
    expect(bar).toContain("<c:barChart>");
    expect(bar).toContain('<c:grouping val="percentStacked"/>');
  });

  it("points externalData at rId1 and embeds a valid xlsx", async () => {
    const part = (await chartPart(withPrevious, O))!;
    expect(part.xml).toMatch(/<c:externalData r:id="rId1">/);
    expect(part.xml).not.toMatch(/rIdjk|Microsoft_Excel/);
    const wb = await unzip(part.workbook);
    expect(wb.file("xl/workbook.xml")).not.toBeNull();
    expect(wb.file("xl/worksheets/sheet1.xml")).not.toBeNull();
    expect(await wb.file("xl/sharedStrings.xml")!.async("string")).toContain("Last period");
  });

  it("writes the same chart XML as the Word export (apart from the relationship id)", async () => {
    const doc = buildReportDoc(await fixtureReport(), { version: "0.4.0" });
    const chart = doc.sections.map((s) => firstChart(s.blocks)).find(Boolean)!;
    const part = (await chartPart(chart, { primary: DEFAULT_PRIMARY, font: doc.branding.fonts.body ?? "Calibri" }))!;
    const zip = await unzip(await toDocx(doc));
    const norm = (s: string) => s.replace(/(<c:externalData r:id=")[^"]*"/, '$1rId1"');
    const word = await Promise.all(Object.keys(zip.files).filter((n) => /^word\/charts\/chart\d+\.xml$/.test(n)).map((n) => zip.file(n)!.async("string")));
    expect(word.map(norm)).toContain(part.xml);
  });

  it("is deterministic, workbook bytes included", async () => {
    const a = (await chartPart(withPrevious, O))!;
    const b = (await chartPart(withPrevious, O))!;
    expect(b.xml).toBe(a.xml);
    expect(b.workbook.equals(a.workbook)).toBe(true);
  });

  it("names no generator in the chart or the workbook", async () => {
    for (const c of [withPrevious, positions, share]) {
      const part = (await chartPart(c, O))!;
      expect(part.xml).not.toMatch(/docx|dolan|crawlmark|claude|dataforseo/i);
      const wb = await unzip(part.workbook);
      for (const n of Object.keys(wb.files)) {
        if (wb.files[n]!.dir) continue;
        expect(n).not.toMatch(/docProps/);
        expect(await wb.file(n)!.async("string")).not.toMatch(/docx|dolan|crawlmark|claude|dataforseo/i);
      }
    }
  });
});

/** The docx layout check: each of these stands in for a docx upgrade that moves things around. */
describe("chartPart when the docx layout changes", () => {
  afterEach(() => {
    vi.doUnmock("docx");
    vi.resetModules();
  });

  /** Loads charts.ts against a docx whose Packer returns `build()`'s zip, and runs it. */
  async function withZip(build: (real: JSZip) => Promise<void> | void) {
    vi.resetModules();
    vi.doMock("docx", async (orig) => {
      const real = await orig<typeof import("docx")>();
      return {
        ...real,
        Packer: {
          ...real.Packer,
          toBuffer: async (d: never) => {
            const zip = await JSZip.loadAsync(await real.Packer.toBuffer(d));
            await build(zip);
            return zip.generateAsync({ type: "nodebuffer" });
          },
        },
      };
    });
    const mod = await import("../src/reports/render/pptx/charts.js");
    return mod.chartPart(withPrevious, O);
  }

  it("sanity: an unmodified docx still yields a part", async () => {
    expect(await withZip(() => undefined)).not.toBeNull();
  });

  it("returns null, without throwing, when there is no chart part", async () => {
    expect(await withZip((z) => void z.remove("word/charts"))).toBeNull();
  });

  it("returns null when the chart moves to another folder", async () => {
    expect(
      await withZip(async (z) => {
        const xml = await z.file("word/charts/chart1.xml")!.async("string");
        z.remove("word/charts");
        z.file("word/drawings/chart1.xml", xml);
      }),
    ).toBeNull();
  });

  it("returns null when there are two chart parts", async () => {
    expect(await withZip(async (z) => void z.file("word/charts/chart2.xml", await z.file("word/charts/chart1.xml")!.async("string")))).toBeNull();
  });

  it("returns null when the workbook is not where the relationship says", async () => {
    expect(await withZip((z) => void z.remove("word/embeddings"))).toBeNull();
  });

  it("returns null when the relationship is no longer a package relationship", async () => {
    expect(
      await withZip(async (z) => {
        const rels = await z.file("word/charts/_rels/chart1.xml.rels")!.async("string");
        z.file("word/charts/_rels/chart1.xml.rels", rels.replace(/relationships\/package/, "relationships/oleObject"));
      }),
    ).toBeNull();
  });
});
