/**
 * Hand-built inline SVG charts for the HTML (and so PDF) report (pure). No
 * script, no external resource, no link: plain <svg> elements, which the file's
 * CSP allows. Data strings never go inside the SVG (series names are in the
 * HTML legend, escaped); the SVG holds numbers, dates and crawlmark's own
 * labels, escaped all the same.
 */
import { NEUTRAL, SERIES, inkOn, mix, textOn } from "./color.js";
import type { LineChart, ShareChart } from "./doc.js";
import { escapeHtml } from "./escape.js";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const shortDay = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? `${Number(iso.slice(8, 10))} ${MONTHS[Number(iso.slice(5, 7)) - 1]}` : iso);
const r1 = (n: number) => Math.round(n * 10) / 10;

/** 1, 2, 2.5 or 5 times a power of ten, at least x. */
export function niceStep(x: number): number {
  if (!(x > 0)) return 1;
  const e = Math.floor(Math.log10(x));
  const f = x / 10 ** e;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * 10 ** e;
}

/** A step for whole-number labels: at least 1, and a fractional nice step (2.5) bumped to the next nice integer (5). */
export function wholeStep(raw: number): number {
  if (!(raw > 1)) return 1;
  return Number.isInteger(raw) ? raw : niceStep(Math.ceil(raw));
}

export function tickLabel(v: number, format: LineChart["format"]): string {
  if (format === "score") return v.toFixed(2).replace(/0$/, "");
  if (format === "ms") return v >= 1000 ? `${r1(v / 1000)} s` : `${Math.round(v)} ms`;
  if (format === "position") return String(Math.round(v));
  if (v >= 1_000_000) return `${r1(v / 1_000_000).toLocaleString("en-US")}M`;
  return v >= 1000 ? `${r1(v / 1000)}k` : String(Math.round(v));
}

export interface ChartSize {
  width: number;
  height: number;
}

/** The series colour for a line chart's legend and marks. */
export function seriesColor(role: LineChart["series"][number]["role"], index: number | undefined, primary: string): string {
  if (role === "current") return inkOn(primary, "#ffffff", 3);
  if (role === "previous") return NEUTRAL.previous;
  return SERIES[(index ?? 0) % SERIES.length]!;
}

export function lineChartSvg(ch: LineChart, size: ChartSize, primary: string): string {
  const { width: W, height: H } = size;
  const pad = { l: 40, r: 12, t: 10, b: 22 };
  const pw = W - pad.l - pad.r;
  const ph = H - pad.t - pad.b;
  const n = ch.x.length;
  const all = ch.series.flatMap((s) => s.values).filter((v): v is number => v !== null && Number.isFinite(v));
  if (n < 2 || !all.length) return "";

  // Y domain: from zero (from 1 for positions), to a nice number above the data (and above the good threshold).
  const min = ch.invert ? 1 : 0;
  let top = Math.max(...all);
  if (ch.bands) top = Math.max(top * 1.08, ch.bands.good * 1.25);
  // Whole-number formats (counts, positions) never get a fractional step: their labels are rounded, so a step of
  // 0.5 would print "1, 1, 2, 2".
  const whole = ch.format === "count" || ch.format === "position";
  const raw = niceStep((top - min) / 4 || 1);
  const step = whole ? wholeStep(raw) : raw;
  const max = Math.max(min + step, Math.ceil(top / step) * step);
  // A value near Number.MAX_VALUE overflows to Infinity; a runaway tick count would never finish. Fall back to the table.
  if (!Number.isFinite(max) || !Number.isFinite(step) || step <= 0 || (max - min) / step > 50) return "";
  const y = (v: number) => (ch.invert ? pad.t + ((v - min) / (max - min)) * ph : pad.t + ph - ((v - min) / (max - min)) * ph);
  const x = (i: number) => pad.l + (n === 1 ? pw / 2 : (i * pw) / (n - 1));

  const out: string[] = [];
  out.push(`<svg class="chart-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="${escapeHtml(ch.summary)}">`, `<title>${escapeHtml(ch.summary)}</title>`);

  // Threshold bands (good / needs improvement / poor), faint, behind everything.
  if (ch.bands) {
    const band = (from: number, to: number, fill: string) => {
      const a = Math.max(min, Math.min(max, from));
      const b = Math.max(min, Math.min(max, to));
      if (b <= a) return;
      out.push(`<rect x="${pad.l}" y="${r1(y(b))}" width="${pw}" height="${r1(y(a) - y(b))}" fill="${fill}"/>`);
    };
    band(min, ch.bands.good, "#e6f4ea");
    band(ch.bands.good, ch.bands.poor, "#fdf3dc");
    band(ch.bands.poor, max, "#fbe9e7");
  }

  // Gridlines and y labels.
  // Ticks: the axis start, then every multiple of the step above it (1, 5, 10 for positions; 0, 20, 40 for counts).
  const ticks = [min];
  // The tolerance is relative to the step (an absolute one would loop for tiny values), and at most 51 ticks.
  const eps = step * 1e-6;
  for (let k = 1, v = Math.floor(min / step) * step + step; v <= max + eps && k <= 51; k++, v += step) if (v > min + step / 4) ticks.push(v);
  for (const val of ticks) {
    const yy = r1(y(val));
    out.push(`<line x1="${pad.l}" x2="${W - pad.r}" y1="${yy}" y2="${yy}" stroke="${NEUTRAL.rule}" stroke-width="1"/>`);
    out.push(`<text x="${pad.l - 6}" y="${r1(yy + 3.5)}" text-anchor="end" class="tick">${escapeHtml(tickLabel(val, ch.format))}</text>`);
  }

  // X labels: about five, always the first and the last.
  const labels = Math.min(n, W < 300 ? 3 : W < 450 ? 4 : 6);
  const idx = [...new Set(Array.from({ length: labels }, (_, i) => Math.round((i * (n - 1)) / (labels - 1))))];
  for (const i of idx) {
    const anchor = i === 0 ? "start" : i === n - 1 ? "end" : "middle";
    out.push(`<text x="${r1(x(i))}" y="${H - 6}" text-anchor="${anchor}" class="tick">${escapeHtml(shortDay(ch.x[i]!))}</text>`);
  }

  // Previous first (behind), then categorical series, then the current period on top.
  const order = [...ch.series].sort((a, b) => (a.role === "previous" ? -1 : b.role === "previous" ? 1 : a.role === "current" ? 1 : b.role === "current" ? -1 : 0));
  for (const s of order) {
    const color = seriesColor(s.role, s.index, primary);
    const segments: [number, number][][] = [[]];
    s.values.forEach((v, i) => {
      if (i >= n) return;
      if (v === null || !Number.isFinite(v)) {
        if (!ch.connectGaps && segments.at(-1)!.length) segments.push([]);
        return;
      }
      segments.at(-1)!.push([r1(x(i)), r1(y(v))]);
    });
    const segs = segments.filter((sg) => sg.length);
    if (s.role === "current" && !ch.invert && !ch.bands) {
      for (const sg of segs.filter((g) => g.length > 1)) {
        out.push(`<path d="M${sg[0]![0]},${r1(y(min))} ${sg.map(([a, b]) => `L${a},${b}`).join(" ")} L${sg.at(-1)![0]},${r1(y(min))} Z" fill="${color}" fill-opacity="0.12" stroke="none"/>`);
      }
    }
    for (const sg of segs) {
      if (sg.length === 1) continue;
      const dash = s.role === "previous" ? ' stroke-dasharray="4 3"' : "";
      out.push(`<path d="M${sg.map(([a, b]) => `${a},${b}`).join(" L")}" fill="none" stroke="${color}" stroke-width="${s.role === "previous" ? 1.5 : 2}" stroke-linejoin="round" stroke-linecap="round"${dash}/>`);
    }
    const pts = segs.flat();
    const sparse = n <= 12;
    const marks = s.role === "previous" ? [] : sparse ? pts : pts.slice(-1);
    for (const [a, b] of marks) out.push(`<circle cx="${a}" cy="${b}" r="3" fill="${color}" stroke="#ffffff" stroke-width="1.5"/>`);
  }
  out.push("</svg>");
  return out.join("");
}

export function shareChartSvg(ch: ShareChart, width: number, primary: string): string {
  const rowH = 22;
  const gapY = 12;
  const labelW = 118;
  const H = ch.rows.length * (rowH + gapY) - gapY + 4;
  const bw = width - labelW - 4;
  const fills = shareColors(primary, ch.parts.length);
  const out = [`<svg class="chart-svg" viewBox="0 0 ${width} ${H}" role="img" aria-label="${escapeHtml(ch.summary)}">`, `<title>${escapeHtml(ch.summary)}</title>`];
  ch.rows.forEach((row, ri) => {
    const top = ri * (rowH + gapY) + 2;
    const total = row.values.reduce((a, b) => a + b, 0);
    out.push(`<text x="0" y="${top + rowH / 2 + 4}" class="tick strong">${escapeHtml(row.label)}</text>`);
    if (total <= 0) return;
    let xx = labelW;
    row.values.forEach((v, i) => {
      const w = (v / total) * bw;
      const gap = i < row.values.length - 1 && w > 2 ? 2 : 0;
      const fill = fills[i % fills.length]!;
      if (w > 0) out.push(`<rect x="${r1(xx)}" y="${top}" width="${r1(Math.max(0, w - gap))}" height="${rowH}" rx="3" fill="${fill}"/>`);
      const pct = `${((v / total) * 100).toFixed(1)}%`;
      if (w > 46) out.push(`<text x="${r1(xx + 8)}" y="${top + rowH / 2 + 4}" class="tick" fill="${textOn(fill)}" style="fill:${textOn(fill)}">${escapeHtml(pct)}</text>`);
      xx += w;
    });
  });
  out.push("</svg>");
  return out.join("");
}

/**
 * Fill colours of a share chart's parts, for the chart and its legend: the brand colour, a light tint and grey
 * for up to three parts; with more (Phase 13: coverage states), the brand colour, the categorical series, a tint
 * and grey last (for "Other").
 */
export function shareColors(primary: string, parts = 3): string[] {
  if (parts <= 3) return [inkOn(primary, "#ffffff", 3), mix(primary, "#ffffff", 0.6), NEUTRAL.previous];
  const palette = [inkOn(primary, "#ffffff", 3), SERIES[1], SERIES[2], SERIES[3], SERIES[4], mix(primary, "#ffffff", 0.6)];
  return [...palette.slice(0, Math.min(parts - 1, palette.length)), NEUTRAL.previous];
}
