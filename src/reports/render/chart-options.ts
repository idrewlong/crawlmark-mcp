/**
 * Native chart options shared by the Word and PowerPoint exports (docx's ChartRun options), so both files draw
 * the same chart: colours, dashed previous-period line, inverted position axes, number formats, whole-number
 * axis steps and percent-stacked share bars. Moved out of docx.ts unchanged.
 */
import type { ChartRunOptions } from "docx/charts";
import { NEUTRAL, SERIES, inkOn } from "./color.js";
import type { Chart, LineChart } from "./doc.js";
import { docxText } from "./escape.js";
import { niceStep, shareColors, wholeStep } from "./svg.js";

const hex = (c: string) => c.replace("#", "").toUpperCase();
const H = { ink: hex(NEUTRAL.ink), muted: hex(NEUTRAL.muted) };

/** The value-axis major unit for counts and positions: the same nice step as the HTML chart, at least 1. */
export function wholeInterval(c: LineChart): number {
  const vals = c.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const min = c.invert ? 1 : 0;
  const top = vals.length ? Math.max(...vals) : min + 1;
  return wholeStep(niceStep((top - min) / 4 || 1));
}

/**
 * The options for a native chart (Word and PowerPoint both build charts from this): line charts for the daily and
 * trend series, a 100% stacked bar for shares. `widthPx` is the final chart width (already halved for a half-width
 * chart); `half` only changes the height.
 */
export function chartRunOptions(c: Chart, o: { primary: string; font: string; widthPx: number; half: boolean }): ChartRunOptions {
  const px = o.widthPx;
  const half = o.half;
  const ctx = { primary: o.primary };
  const font = { name: o.font };
  const axisFont = { size: 8, color: H.muted };
  let opts: ChartRunOptions;
  if (c.type === "line") {
    const cats = c.x.map((d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${Number(d.slice(8, 10))} ${["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][Number(d.slice(5, 7)) - 1]}` : docxText(d)));
    const color = (s: (typeof c.series)[number]) => hex(s.role === "current" ? inkOn(ctx.primary, "#ffffff", 3) : s.role === "previous" ? NEUTRAL.previous : SERIES[(s.index ?? 0) % SERIES.length]!);
    opts = {
      type: "line",
      font,
      title: { text: docxText(c.title), font: { size: 10, bold: true, color: H.ink } },
      categories: cats,
      series: c.series.map((s) => ({ name: docxText(s.name), values: s.values.slice(0, cats.length).map((x) => (x !== null && Number.isFinite(x) ? x : null)), color: color(s), line: { color: color(s), width: s.role === "previous" ? 1.25 : 2, dash: s.role === "previous" ? ("dash" as const) : ("solid" as const) }, markers: false })),
      emptyValues: c.connectGaps ? "connect" : "gap",
      legend: c.series.length > 1 ? { position: "top", font: { size: 8, color: H.muted } } : false,
      categoryAxis: { font: axisFont, gridlines: false },
      valueAxis: {
        font: axisFont,
        numberFormat: c.format === "score" ? "0.00" : c.format === "position" ? "0" : "#,##0",
        ...(c.invert ? { reverseOrder: true, minimum: 1 } : { minimum: 0 }),
        // Whole-number labels need a whole-number major unit, or Word prints "1, 1, 2, 2".
        ...(c.format === "count" || c.format === "position" ? { interval: wholeInterval(c) } : {}),
      },
      chartArea: { fill: "FFFFFF", border: "none" },
      transformation: { width: px, height: Math.round(px * (half ? 0.62 : 0.34)) },
      altText: { name: docxText(c.title), description: docxText(c.summary), title: docxText(c.title) },
    };
  } else {
    const colors = shareColors(ctx.primary, c.parts.length).map(hex);
    opts = {
      type: "bar",
      font,
      title: { text: docxText(c.title), font: { size: 10, bold: true, color: H.ink } },
      categories: [...c.rows].reverse().map((r) => docxText(r.label)),
      series: c.parts.map((p, i) => ({ name: docxText(p), values: [...c.rows].reverse().map((r) => { const x = r.values[i]; return x !== undefined && Number.isFinite(x) ? x : 0; }), color: colors[i % colors.length]! })),
      stacking: "percent",
      gapWidth: 60,
      legend: { position: "top", font: { size: 8, color: H.muted } },
      categoryAxis: { font: axisFont },
      valueAxis: { font: axisFont, numberFormat: "0%" },
      chartArea: { fill: "FFFFFF", border: "none" },
      transformation: { width: px, height: Math.max(110, 50 + c.rows.length * 40) },
      altText: { name: docxText(c.title), description: docxText(c.summary), title: docxText(c.title) },
    };
  }
  return opts;
}

