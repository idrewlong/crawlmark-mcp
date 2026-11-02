/**
 * Deck-only touches to a harvested chart part (charts.ts keeps the Word export's XML byte for byte; the Word
 * output doesn't change). On a slide:
 * - the chart's own title and legend go (`c:autoTitleDeleted`, no `c:legend`): the slide draws both on a caption
 *   row above the chart (title left, legend right), so nothing can collide in Keynote, PowerPoint or LibreOffice;
 * - axis labels are 11 pt;
 * - the chart and plot areas are transparent, so the chart sits on the slide's own background;
 * - line charts get a fixed value axis (min, max and a "nice" major unit of 1, 2, 2.5 or 5 × 10^n), because Keynote
 *   ignores the major unit without a max and splits the auto range into quarters (13, 25, 38, 50);
 * - polish (design brief, change 4): horizontal gridlines only, hairline light grey; the current line heavier
 *   (2.75 pt) and the previous one a 1.5 pt dashed grey; large counts abbreviated on the value axis (k, M); a data
 *   label on the last current point; percent labels inside the share bars, in a colour that reads on each fill.
 *   No area fill under the line: the combined area + line chart draws in Keynote, but Quick Look then draws only the
 *   area and loses both lines.
 */
import { textOn } from "../color.js";
import type { Chart, LineChart, ShareChart } from "../doc.js";

/** The value axis for a line chart on a slide: round ticks with at most `maxIntervals` steps. */
export interface AxisScale {
  min: number;
  max: number;
  unit: number;
}

const NICE = [1, 2, 2.5, 5] as const;

/** The smallest nice unit (1, 2, 2.5, 5 × 10^n) that covers `span` in at most `maxIntervals` steps; whole when asked. */
export function niceUnit(span: number, maxIntervals = 5, whole = false): number {
  if (!(span > 0) || !Number.isFinite(span)) return 1;
  const raw = span / maxIntervals;
  let e = Math.floor(Math.log10(raw));
  for (let guard = 0; guard < 4; guard++, e++) {
    for (const f of NICE) {
      const u = f * 10 ** e;
      // Round away float noise (0.1 * 3 = 0.30000000000000004).
      const unit = Number(u.toPrecision(12));
      if (whole && !Number.isInteger(unit)) continue;
      if (unit >= raw - 1e-12 && Math.ceil(span / unit - 1e-9) <= maxIntervals) return unit;
    }
  }
  return Number((10 ** e).toPrecision(12));
}

/** Exported for tests. The axis a line chart gets on a slide. */
export function axisScale(c: LineChart): AxisScale {
  const vals = c.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  const top = vals.length ? Math.max(...vals) : 1;
  const whole = c.format === "count" || c.format === "position" || c.format === "ms";
  // Positions start at 0 (its label is hidden) so the ticks land on round numbers: 0, 5, 10 rather than 1, 6, 11.
  const min = 0;
  const unit = niceUnit(Math.max(top, whole ? 1 : 0) - min || 1, 5, whole);
  const max = Number((Math.max(1, Math.ceil(top / unit - 1e-9)) * unit).toPrecision(12));
  return { min, max: max > min ? max : min + unit, unit };
}

/** Category labels a slide chart shows at most (the frame is at least 8 in wide). */
const MAX_CATEGORY_LABELS = 10;

const num = (n: number) => String(Number(n.toPrecision(12)));

/** Gridlines: 0.5 pt, light grey. */
const GRID_LINE = '<c:majorGridlines><c:spPr><a:ln w="6350" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:srgbClr val="E5E7EB"/></a:solidFill><a:round/></a:ln><a:effectLst/></c:spPr></c:majorGridlines>';
/** Line widths in EMU: the current period 2.75 pt, the previous 1.5 pt. */
const CURRENT_W = 34925;
const PREVIOUS_W = 19050;
/** A share segment under this fraction of its bar gets no label (it would not fit). */
const MIN_LABEL_SHARE = 0.06;

const SHOW_NONE = '<c:showLegendKey val="0"/><c:showVal val="0"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>';
const SHOW_VAL = '<c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/><c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/>';
const NO_BOX = '<c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr>';

const fillOf = (ser: string): string | undefined => /<c:spPr>[\s\S]*?<a:srgbClr val="([0-9A-Fa-f]{6})"/.exec(ser)?.[1];
const labelText = (hex: string, sz: number) => `<c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${sz}" b="1"><a:solidFill><a:srgbClr val="${hex}"/></a:solidFill></a:defRPr></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr>`;

/** Value-axis number format for large counts: 12k, 1.5M. null below 10,000. Quotes are XML-escaped for the attribute. */
export function abbreviatedFormat(a: AxisScale): string | null {
  if (a.max < 10_000) return null;
  const million = a.max >= 1_000_000;
  const unit = a.unit / (million ? 1_000_000 : 1_000);
  let d = 0;
  while (d < 3 && Math.abs(unit * 10 ** d - Math.round(unit * 10 ** d)) > 1e-9) d++;
  return `#,##0${d ? `.${"0".repeat(d)}` : ""},${million ? ',&quot;M&quot;' : '&quot;k&quot;'}`;
}

/** Percent labels inside the bars of a share chart (each bar's counts become shares), readable on each fill. */
function shareLabels(xml: string, c: ShareChart): string {
  let k = -1;
  return xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
    k++;
    const fill = fillOf(ser);
    if (!fill || ser.includes("<c:dLbls>")) return ser;
    const ink = textOn(`#${fill}`).slice(1).toUpperCase();
    const pts = c.rows.map((r, row) => {
      const total = r.values.reduce((t, v) => t + (Number.isFinite(v) ? v : 0), 0);
      const v = r.values[k];
      const share = total > 0 && v !== undefined && Number.isFinite(v) ? v / total : 0;
      if (share < MIN_LABEL_SHARE) return `<c:dLbl><c:idx val="${row}"/><c:delete val="1"/></c:dLbl>`;
      const text = `${(share * 100).toFixed(1)}%`;
      return `<c:dLbl><c:idx val="${row}"/><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="1100" b="1"><a:solidFill><a:srgbClr val="${ink}"/></a:solidFill></a:rPr><a:t>${text}</a:t></a:r></a:p></c:rich></c:tx><c:dLblPos val="ctr"/>${SHOW_VAL}</c:dLbl>`;
    });
    const lbls = `<c:dLbls>${pts.join("")}${NO_BOX}${labelText(ink, 1100)}<c:dLblPos val="ctr"/>${SHOW_VAL}</c:dLbls>`;
    return ser.replace(/(<c:invertIfNegative val="[01]"\/>)/, `$1${lbls}`);
  });
}

/** Index of the last point that has a value in a series' cache. */
function lastIndex(ser: string): number | null {
  const cache = /<c:val>[\s\S]*?<\/c:val>/.exec(ser)?.[0] ?? "";
  const idx = [...cache.matchAll(/<c:pt idx="(\d+)"><c:v>[^<]+<\/c:v><\/c:pt>/g)].map((m) => Number(m[1]));
  return idx.length ? Math.max(...idx) : null;
}

/**
 * A data label on the current series' last point (a per-point `c:dLbl`, no marker). PowerPoint and LibreOffice draw
 * it. Keynote and Quick Look ignore a single-point label and draw nothing, which is harmless. Two alternatives were
 * tried and dropped: a `c:dPt` marker (Keynote puts it on every point) and a one-point extra series with a
 * series-level label (Keynote draws it, but Quick Look compacts the missing points and parks a stray marker and
 * label at the first category).
 */
function endLabel(ser: string, fmt: string, fill: string): string {
  const last = lastIndex(ser);
  if (last === null) return ser;
  const label = `<c:dLbls><c:dLbl><c:idx val="${last}"/><c:numFmt formatCode="${fmt}" sourceLinked="0"/>${NO_BOX}${labelText(fill, 1200)}<c:dLblPos val="t"/>${SHOW_VAL}</c:dLbl>${SHOW_NONE}</c:dLbls>`;
  return ser.replace("</c:marker><c:cat>", () => `</c:marker>${label}<c:cat>`);
}

/** Line weights, and the label on the current line's last point. */
function polishLines(xml: string, c: LineChart, fmt: string): string {
  let i = -1;
  return xml.replace(/<c:ser>[\s\S]*?<\/c:ser>/g, (ser) => {
    i++;
    const role = c.series[i]?.role;
    if (role === "previous") return ser.replace(/(<c:spPr><a:ln w=")\d+(")/, `$1${PREVIOUS_W}$2`);
    if (role !== "current") return ser;
    const wide = ser.replace(/(<c:spPr><a:ln w=")\d+(")/, `$1${CURRENT_W}$2`);
    const fill = fillOf(ser);
    return fill ? endLabel(wide, fmt, fill) : wide;
  });
}

/** The deck's version of a harvested chart part's XML. */
export function deckChartXml(xml: string, c: Chart): string {
  let out = xml
    // No internal title: the slide carries it.
    .replace(/<c:title>[\s\S]*?<\/c:title>/, "")
    .replace(/<c:autoTitleDeleted val="0"\/>/, '<c:autoTitleDeleted val="1"/>')
    // Transparent chart area (the outer c:spPr of c:chartSpace, after c:chart) and plot area.
    .replace(/(<\/c:chart><c:spPr>)<a:solidFill>[\s\S]*?<\/a:solidFill>/, "$1<a:noFill/>")
    .replace(/(<\/c:valAx>|<\/c:catAx>)<c:spPr><a:solidFill>[\s\S]*?<\/a:solidFill>/, "$1<c:spPr><a:noFill/>");
  if (!out.includes('<c:autoTitleDeleted val="1"/>')) out = out.replace("<c:chart>", '<c:chart><c:autoTitleDeleted val="1"/>');
  // Axis and legend labels at 11 pt (Word's are 8 pt on a page; a slide is read from further away).
  out = out.replace(/(<a:defRPr sz=")800(")/g, "$11100$2");
  // No legend inside the chart: the slide draws it on the caption row, top right, as the report themes do.
  out = out.replace(/<c:legend>[\s\S]*?<\/c:legend>/, "");
  // Horizontal gridlines only, hairline light grey (share bars: none, the labels carry the numbers).
  if (c.type !== "line") return shareLabels(out.replace(/<c:majorGridlines>[\s\S]*?<\/c:majorGridlines>/, ""), c);
  out = out.replace(/<c:majorGridlines>[\s\S]*?<\/c:majorGridlines>/, GRID_LINE);

  // At most ~10 category labels (a 30-day chart labels every third day), so 11 pt dates don't run together.
  const skip = Math.ceil(c.x.length / MAX_CATEGORY_LABELS);
  if (skip > 1) out = out.replace(/(<c:catAx>[\s\S]*?)(<c:noMultiLvlLbl )/, `$1<c:tickLblSkip val="${skip}"/><c:tickMarkSkip val="${skip}"/>$2`);

  const a = axisScale(c);
  // The value axis's scaling: orientation, then max, then min (CT_Scaling order).
  out = out.replace(/(<c:valAx>[\s\S]*?<c:scaling>)([\s\S]*?)(<\/c:scaling>)/, (_m, open: string, body: string, close: string) => {
    const orientation = /<c:orientation val="[^"]*"\/>/.exec(body)?.[0] ?? '<c:orientation val="minMax"/>';
    return `${open}${orientation}<c:max val="${num(a.max)}"/><c:min val="${num(a.min)}"/>${close}`;
  });
  // The major unit: replace docx's, or add it at its place (after c:crossBetween).
  if (/<c:valAx>[\s\S]*?<c:majorUnit val="[^"]*"\/>/.test(out)) out = out.replace(/(<c:valAx>[\s\S]*?)<c:majorUnit val="[^"]*"\/>/, `$1<c:majorUnit val="${num(a.unit)}"/>`);
  else out = out.replace(/(<c:valAx>[\s\S]*?<c:crossBetween val="[^"]*"\/>)/, `$1<c:majorUnit val="${num(a.unit)}"/>`);
  // Counts over 10,000 read 12k / 1.2M on the axis; the end-point label keeps the full number.
  const valFmt = /<c:valAx>[\s\S]*?<c:numFmt formatCode="([^"]*)"/.exec(out)?.[1] ?? "#,##0";
  const short = c.format === "count" && !c.invert ? abbreviatedFormat(a) : null;
  if (short) out = out.replace(/(<c:valAx>[\s\S]*?<c:numFmt formatCode=")[^"]*(")/, `$1${short}$2`);
  out = polishLines(out, c, valFmt);
  // Positions: the 0 tick (the axis floor, not a rank) has no label.
  if (c.invert) out = out.replace(/(<c:valAx>[\s\S]*?<c:numFmt formatCode=")([^"]*)(")/, (_m, o: string, f: string, e: string) => `${o}${f};-${f};${e}`);
  return out;
}
