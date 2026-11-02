/**
 * Deck-only touches to a harvested chart part (charts.ts keeps the Word export's XML byte for byte; the Word
 * output doesn't change). On a slide:
 * - the chart's own title and legend go (`c:autoTitleDeleted`, no `c:legend`): the slide draws both on a caption
 *   row above the chart (title left, legend right), so nothing can collide in Keynote, PowerPoint or LibreOffice;
 * - axis labels are 11 pt;
 * - the chart and plot areas are transparent, so the chart sits on the slide's own background;
 * - line charts get a fixed value axis (min, max and a "nice" major unit of 1, 2, 2.5 or 5 × 10^n), because Keynote
 *   ignores the major unit without a max and splits the auto range into quarters (13, 25, 38, 50).
 */
import type { Chart, LineChart } from "../doc.js";

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
  if (c.type !== "line") return out;

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
  // Positions: the 0 tick (the axis floor, not a rank) has no label.
  if (c.invert) out = out.replace(/(<c:valAx>[\s\S]*?<c:numFmt formatCode=")([^"]*)(")/, (_m, o: string, f: string, e: string) => `${o}${f};-${f};${e}`);
  return out;
}
