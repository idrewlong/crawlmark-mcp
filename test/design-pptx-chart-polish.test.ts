/**
 * 0.4.0 deck chart polish (design brief, change 4): hairline horizontal gridlines, line weights, k/M axis labels, a
 * last-point label, percent labels inside the share bars. The chart XML stays schema-ordered and deterministic, and
 * the Word export's chart options are untouched.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_PRIMARY } from "../src/reports/render/color.js";
import type { LineChart, ShareChart } from "../src/reports/render/doc.js";
import { abbreviatedFormat, deckChartXml } from "../src/reports/render/pptx/chart-style.js";
import { chartPart } from "../src/reports/render/pptx/charts.js";

const X = ["2026-09-01", "2026-09-02", "2026-09-03"];
const line = (cur: (number | null)[], prev: number[] = [1, 2, 3], o: Partial<LineChart> = {}): LineChart => ({
  type: "line",
  title: "Clicks per day",
  x: X,
  series: [
    { name: "September 2026", values: cur, role: "current" },
    { name: "August 2026", values: prev, role: "previous" },
  ],
  format: "count",
  summary: "s",
  ...o,
});
const share = (rows: ShareChart["rows"], parts = ["Branded", "Non-branded"]): ShareChart => ({ type: "share", title: "Share of clicks", parts, rows, summary: "s" });
const deck = async (c: LineChart | ShareChart) => deckChartXml((await chartPart(c, { primary: DEFAULT_PRIMARY, font: "Arial" }))!.xml, c);
const sers = (xml: string): string[] => xml.match(/<c:ser>[\s\S]*?<\/c:ser>/g) ?? [];
const ser = (xml: string, i: number): string => sers(xml)[i] ?? "";

describe("line chart polish", () => {
  it("gridlines are 0.5 pt light grey, horizontal only (the value axis's; the category axis has none)", async () => {
    const xml = await deck(line([37, 45, 48]));
    expect(xml.match(/<c:majorGridlines>/g)).toHaveLength(1);
    expect(/<c:valAx>[\s\S]*<c:majorGridlines><c:spPr><a:ln w="6350"[^>]*><a:solidFill><a:srgbClr val="E5E7EB"\/>/.test(xml)).toBe(true);
    expect(/<c:catAx>[\s\S]*?<\/c:catAx>/.exec(xml)![0]).not.toContain("majorGridlines");
  });

  it("the current line is 2.75 pt solid; the previous is a 1.5 pt dashed grey", async () => {
    const [cur, prev] = sers(await deck(line([37, 45, 48])));
    expect(cur).toContain('<a:ln w="34925"');
    expect(cur).toContain('<a:prstDash val="solid"/>');
    expect(prev).toContain('<a:ln w="19050"');
    expect(prev).toContain('<a:prstDash val="dash"/>');
    expect(prev).toContain('<a:srgbClr val="9AA5B1"/>');
  });

  it("labels only the last current point, between marker and cat (CT_LineSer order); the previous series has no labels", async () => {
    const xml = await deck(line([37, 45, 48]));
    const [cur, prev] = [ser(xml, 0), ser(xml, 1)];
    expect(cur).toMatch(/<\/c:marker><c:dLbls><c:dLbl><c:idx val="2"\/><c:numFmt formatCode="#,##0" sourceLinked="0"\/>.*<c:dLblPos val="t"\/><c:showLegendKey val="0"\/><c:showVal val="1"\/>.*<\/c:dLbl><c:showLegendKey val="0"\/><c:showVal val="0"\/>.*<\/c:dLbls><c:cat>/);
    expect(cur.match(/<c:dLbl>/g)).toHaveLength(1);
    expect(prev).not.toContain("<c:dLbl");
  });

  it("the label sits on the last point that has a value", async () => {
    const [cur] = sers(await deck(line([37, 45, null])));
    expect(cur).toContain('<c:dLbl><c:idx val="1"/>');
  });

  it("no area chart is added (Quick Look draws only the area of a combined chart and loses the lines)", async () => {
    const xml = await deck(line([37, 45, 48]));
    expect(xml).not.toContain("<c:areaChart>");
    expect(xml.match(/<c:ser>/g)).toHaveLength(2);
  });

  it("abbreviates large counts on the value axis, not small counts or other formats", async () => {
    expect(await deck(line([12_000, 31_000, 48_000]))).toContain('<c:numFmt formatCode="#,##0,&quot;k&quot;" sourceLinked="0"/><c:majorTickMark');
    expect(await deck(line([4_200_000, 3_100_000, 1_000_000]))).toContain('formatCode="#,##0,,&quot;M&quot;"');
    expect(await deck(line([37, 45, 48]))).toContain('<c:numFmt formatCode="#,##0" sourceLinked="0"/><c:majorTickMark');
    const ms = await deck(line([12_000, 31_000, 48_000], [1, 2, 3], { format: "ms" }));
    expect(/<c:valAx>[\s\S]*<\/c:valAx>/.exec(ms)![0]).not.toContain("&quot;k&quot;");
    // The end-point label keeps the full number.
    expect(sers(await deck(line([12_000, 31_000, 48_000])))[0]).toContain('<c:dLbl><c:idx val="2"/><c:numFmt formatCode="#,##0"');
  });

  it("abbreviatedFormat uses decimals only when the tick unit needs them", () => {
    expect(abbreviatedFormat({ min: 0, max: 50_000, unit: 10_000 })).toBe('#,##0,&quot;k&quot;');
    expect(abbreviatedFormat({ min: 0, max: 25_000, unit: 2_500 })).toBe('#,##0.0,&quot;k&quot;');
    expect(abbreviatedFormat({ min: 0, max: 2_000_000, unit: 500_000 })).toBe('#,##0.0,,&quot;M&quot;');
    expect(abbreviatedFormat({ min: 0, max: 9_000, unit: 2_000 })).toBeNull();
  });

  it("positions (reversed axis) keep the plain format and the hidden 0 label", async () => {
    const xml = await deck(line([8, 6, 5], [9, 8, 7], { format: "position", invert: true }));
    expect(xml).toContain('<c:numFmt formatCode="0;-0;"');
    expect(xml).not.toContain("&quot;k&quot;");
  });

  it("keeps the earlier slide rules: no title or legend, round ticks, transparent areas", async () => {
    const xml = await deck(line([37, 45, 48]));
    expect(xml).not.toContain("<c:title>");
    expect(xml).not.toContain("<c:legend>");
    expect(xml).toContain('<c:max val="50"/><c:min val="0"/>');
    expect(xml).toContain('<c:majorUnit val="10"/>');
    expect(xml).toContain("</c:chart><c:spPr><a:noFill/>");
  });

  it("is deterministic and carries no generator strings", async () => {
    const c = line([37, 45, 48]);
    const a = await deck(c);
    expect(await deck(c)).toBe(a);
    expect(a).not.toMatch(/docx|generated|crawlmark/i);
  });
});

describe("share chart polish", () => {
  it("draws no gridlines and puts percent labels inside the segments, centred", async () => {
    const xml = await deck(share([{ label: "September 2026", values: [300, 459] }, { label: "August 2026", values: [255, 492] }]));
    expect(xml).not.toContain("majorGridlines");
    const [branded, non] = [ser(xml, 0), ser(xml, 1)];
    expect(branded).toMatch(/<c:invertIfNegative val="0"\/><c:dLbls><c:dLbl><c:idx val="0"\/><c:tx><c:rich>/);
    expect(branded).toContain("<a:t>39.5%</a:t>");
    expect(branded).toContain("<a:t>34.1%</a:t>");
    expect(non).toContain("<a:t>60.5%</a:t>");
    expect(branded.match(/<c:dLblPos val="ctr"\/>/g)!.length).toBeGreaterThanOrEqual(2);
    expect(branded).toMatch(/<\/c:dLbls><c:cat>/);
  });

  it("picks a readable text colour for each fill (white on dark, dark on light)", async () => {
    const xml = await deck(share([{ label: "September 2026", values: [40, 60] }]));
    const [branded, non] = [ser(xml, 0), ser(xml, 1)];
    const ink = (s: string) => /<a:rPr[^>]*><a:solidFill><a:srgbClr val="([0-9A-F]{6})"/.exec(s)?.[1];
    expect(ink(branded)).toBe("FFFFFF");
    expect(ink(non)).not.toBe("FFFFFF");
  });

  it("drops the label of a segment too narrow to hold it", async () => {
    const xml = await deck(share([{ label: "Checked URLs", values: [98, 2] }]));
    const [, small] = sers(xml);
    expect(small).toContain('<c:dLbl><c:idx val="0"/><c:delete val="1"/></c:dLbl>');
    expect(small).not.toContain("<a:t>");
  });

  it("handles an all-zero bar without a NaN label", async () => {
    const xml = await deck(share([{ label: "None", values: [0, 0] }]));
    expect(xml).not.toContain("NaN");
  });
});
