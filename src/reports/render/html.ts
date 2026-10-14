/**
 * HTML renderer (pure). The file variant is a self-contained agency-dashboard
 * page (also printed to PDF): a strict CSP meta (no script, no external
 * resource; the logo is a data: URI), inline CSS, inline SVG charts, every
 * string escaped. The docs variant is for the Google Docs handoff: no logo, no
 * <style>, plain bordered tables, charts as their small tables, and only
 * inline colour on change values (which Docs keeps).
 */
import { DEFAULT_ACCENT, DEFAULT_PRIMARY, NEUTRAL, TONE, inkOn, mix, textOn } from "./color.js";
import type { Block, Chart, DocSection, Kpi, ReportDoc, TableBlock, Text } from "./doc.js";
import { clean, escapeHtml, safeColor } from "./escape.js";
import type { NarrativeBlock, Run } from "./narrative.js";
import { lineChartSvg, seriesColor, shareChartSvg, shareColors } from "./svg.js";

export const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export interface HtmlOptions {
  variant?: "file" | "docs";
}

interface Ctx {
  docs: boolean;
  /** Width available to a chart, in SVG units (about CSS px at print size). */
  width: number;
  primary: string;
  onepage: boolean;
}

const TAG_COLORS = { good: TONE.good, bad: TONE.bad, warn: { fg: "#8a5300", bg: "#fdf0d5" }, neutral: TONE.neutral } as const;

function run(r: Run, ctx: Ctx): string {
  const body = r.c ? `<code>${escapeHtml(r.t)}</code>` : r.b ? `<strong>${escapeHtml(r.t)}</strong>` : escapeHtml(r.t);
  if (r.tag) return ctx.docs ? body : `<span class="tag tag-${r.tag}">${body}</span>`;
  if (r.tone) return ctx.docs ? `<span style="color:${TONE[r.tone].fg}">${body}</span>` : `<span class="${r.tone}">${body}</span>`;
  return body;
}
const text = (t: Text, ctx: Ctx) => t.map((r, i) => (r.tag && i > 0 ? " " : "") + run(r, ctx)).join("");

function narrative(blocks: NarrativeBlock[], ctx: Ctx): string {
  return blocks.map((b) => (b.kind === "p" ? `<p>${text(b.runs, ctx)}</p>` : `<ul>${b.items.map((i) => `<li>${text(i, ctx)}</li>`).join("")}</ul>`)).join("\n");
}

function commentaryBox(blocks: NarrativeBlock[], ctx: Ctx): string {
  return ctx.docs
    ? `<blockquote><p><strong>Commentary</strong></p>\n${narrative(blocks, ctx)}</blockquote>`
    : `<aside class="commentary"><p class="label">Commentary</p>\n${narrative(blocks, ctx)}</aside>`;
}

function table(b: TableBlock, ctx: Ctx): string {
  const { header, rows, numeric } = b;
  const title = b.title ? (ctx.docs ? `<p><strong>${escapeHtml(b.title)}</strong></p>` : `<h3 class="table-title">${escapeHtml(b.title)}</h3>`) : "";
  if (ctx.docs) {
    return [
      title,
      '<table border="1" cellpadding="4" cellspacing="0">',
      `<thead><tr>${header.map((h, i) => `<th${numeric?.[i] ? ' align="right"' : ' align="left"'}>${escapeHtml(h)}</th>`).join("")}</tr></thead>`,
      `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${numeric?.[i] ? ' align="right"' : ""}>${text(c, ctx)}</td>`).join("")}</tr>`).join("\n")}</tbody>`,
      "</table>",
    ].join("\n");
  }
  const max = b.bar ? Math.max(0, ...b.bar.values) : 0;
  const cls = (i: number) => (numeric?.[i] ? ' class="num"' : i === 0 ? ' class="lead"' : "");
  const cellHtml = (c: Text, i: number, ri: number) => {
    if (b.bar && i === b.bar.col && max > 0) {
      const pct = Math.max(1, Math.round(((b.bar.values[ri] ?? 0) / max) * 100));
      return `<td class="num"><span class="barbox"><span class="track"><span class="bar" style="width:${pct}%"></span></span><span class="v">${text(c, ctx)}</span></span></td>`;
    }
    return `<td${cls(i)}>${text(c, ctx)}</td>`;
  };
  return [
    title,
    `<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(b.title ?? header.join(", "))}"><table>`,
    `<thead><tr>${header.map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((r, ri) => `<tr>${r.map((c, i) => cellHtml(c, i, ri)).join("")}</tr>`).join("\n")}</tbody>`,
    "</table></div>",
  ].join("\n");
}

const ARROW = { up: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 1.5 9 8.5H1z"/></svg>', down: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M5 8.5 1 1.5h8z"/></svg>', flat: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 4h8v2H1z"/></svg>' } as const;
const ARROW_TEXT = { up: "▲", down: "▼", flat: "–" } as const;
const SR_DIR = { up: "up", down: "down", flat: "no change" } as const;

function kpiCard(k: Kpi, ctx: Ctx, tile: boolean): string {
  const chip = k.delta
    ? `<div class="chip ${k.delta.tone}">${ARROW[k.delta.dir]}<span class="sr">${SR_DIR[k.delta.dir]} </span>${escapeHtml(k.delta.text)}</div>`
    : "";
  const value = `<div class="kpi-value${k.tone ? ` ${k.tone}` : ""}">${escapeHtml(k.value)}</div>`;
  return `<div class="${tile ? "tile" : "kpi"}"><div class="kpi-label">${escapeHtml(k.label)}</div>${value}${chip}${k.detail ? `<div class="kpi-detail">${escapeHtml(k.detail)}</div>` : ""}</div>`;
}

/** Key figures as a plain table (docs variant, and the fallback for tiles there). */
function kpiTable(items: Kpi[]): string {
  const change = (k: Kpi) => (k.delta ? `<span style="color:${TONE[k.delta.tone].fg}">${ARROW_TEXT[k.delta.dir]} ${escapeHtml(k.delta.text)}</span>` : "");
  return [
    '<table border="1" cellpadding="6" cellspacing="0">',
    `<thead><tr>${items.map((k) => `<th align="left">${escapeHtml(k.label)}</th>`).join("")}</tr></thead>`,
    `<tbody><tr>${items.map((k) => `<td><strong>${escapeHtml(k.value)}</strong></td>`).join("")}</tr>`,
    ...(items.some((k) => k.delta || k.detail) ? [`<tr>${items.map((k) => `<td>${[change(k), k.detail ? escapeHtml(k.detail) : ""].filter(Boolean).join(" ")}</td>`).join("")}</tr>`] : []),
    "</tbody></table>",
  ].join("\n");
}

function chart(c: Chart, ctx: Ctx): string {
  if (ctx.docs) return c.fallback ? table(c.fallback, ctx) : "";
  const height = c.type === "line" ? Math.round(ctx.onepage ? 120 : ctx.width >= 600 ? 135 : ctx.width >= 300 ? 125 : 115) : 0;
  let legend = "";
  let svg = "";
  if (c.type === "line") {
    svg = lineChartSvg(c, { width: ctx.width, height }, ctx.primary);
    if (c.series.length > 1) {
      legend = `<span class="legend">${c.series
        .map((s) => `<span class="key-item"><span class="key${s.role === "previous" ? " dashed" : ""}" style="border-color:${seriesColor(s.role, s.index, ctx.primary)}"></span>${escapeHtml(s.name)}</span>`)
        .join("")}</span>`;
    }
  } else {
    svg = shareChartSvg(c, ctx.width, ctx.primary);
    const colors = shareColors(ctx.primary);
    legend = `<span class="legend">${c.parts.map((p, i) => `<span class="key-item"><span class="key box" style="background:${colors[i % colors.length]}"></span>${escapeHtml(p)}</span>`).join("")}</span>`;
  }
  if (!svg) return c.fallback ? table(c.fallback, ctx) : "";
  return `<figure class="chart"><figcaption${ctx.width < 600 ? ' class="stack"' : ""}><span class="chart-title">${escapeHtml(c.title)}</span>${legend}</figcaption>${svg}</figure>`;
}

function block(b: Block, ctx: Ctx): string {
  switch (b.kind) {
    case "heading":
      return `<h3>${escapeHtml(b.text)}</h3>`;
    case "paragraph":
      return `<p>${text(b.text, ctx)}</p>`;
    case "note":
      return ctx.docs ? `<p><em>${text(b.text, ctx)}</em></p>` : `<p class="note">${text(b.text, ctx)}</p>`;
    case "list":
      return `<ul>${b.items.map((i) => `<li>${text(i, ctx)}</li>`).join("")}</ul>`;
    case "table":
      return table(b, ctx);
    case "kpiRow":
      return ctx.docs ? kpiTable(b.items) : `<div class="tiles${b.items.length > 6 ? " tiles-5" : ` tiles-${b.items.length}`}">${b.items.map((k) => kpiCard(k, ctx, true)).join("")}</div>`;
    case "commentary":
      return commentaryBox(b.blocks, ctx);
    case "chart":
      return chart(b.chart, ctx);
    case "columns": {
      if (ctx.docs) return b.columns.flat().map((x) => block(x, ctx)).join("\n");
      const n = b.columns.length;
      const inner = { ...ctx, width: Math.round((ctx.width - 16 * (n - 1)) / n) };
      return `<div class="cols cols-${n}">${b.columns.map((col) => `<div class="col">${col.map((x) => block(x, inner)).join("\n")}</div>`).join("")}</div>`;
    }
  }
}

function section(s: DocSection, ctx: Ctx, width: number): string {
  const inner = { ...ctx, width };
  const html = (blocks: Block[]) => blocks.map((b) => block(b, inner)).filter(Boolean).join("\n");
  const commentary = s.commentary ? commentaryBox(s.commentary, ctx) : "";
  if (ctx.docs) return `<h2>${escapeHtml(s.title)}</h2>\n${[html(s.blocks), commentary].filter(Boolean).join("\n")}`;
  // The heading travels with its lead-in (short paragraphs and notes, then the first chart or tiles), so a
  // heading is never left alone at the bottom of a page. Tables aren't pulled in: their rows flow.
  let n = 0;
  while (n < s.blocks.length && (s.blocks[n]!.kind === "paragraph" || s.blocks[n]!.kind === "note")) n++;
  const first = s.blocks[n];
  if (first && (first.kind === "chart" || first.kind === "kpiRow" || (first.kind === "columns" && first.columns.flat().every((x) => x.kind === "chart")))) n++;
  const lead = `<div class="lead-in"><h2>${escapeHtml(s.title)}</h2>\n${html(s.blocks.slice(0, n))}</div>`;
  return `<section class="card" aria-label="${escapeHtml(s.title)}">${lead}\n${[html(s.blocks.slice(n)), commentary].filter(Boolean).join("\n")}</section>`;
}

/** A CSS string literal: everything but plain letters, digits and spaces as a CSS escape, so data can't end the string or the <style>. */
export function cssString(s: string): string {
  return `"${Array.from(clean(s)).map((ch) => (/[A-Za-z0-9 ]/.test(ch) ? ch : `\\${ch.codePointAt(0)!.toString(16)} `)).join("")}"`;
}

function style(primary: string, accent: string, onepage: boolean, runningHeader: string): string {
  const ink = inkOn(primary);
  const on = textOn(primary);
  const onSoft = mix(on, primary, 0.25);
  const rule = mix(on, primary, 0.72);
  return `<style>
:root { --primary: ${primary}; --primary-ink: ${ink}; --on-primary: ${on}; --on-primary-soft: ${onSoft}; --cover-rule: ${rule}; --accent: ${accent};
  --ink: ${NEUTRAL.ink}; --muted: ${NEUTRAL.muted}; --faint: ${NEUTRAL.faint}; --rule: ${NEUTRAL.rule}; --zebra: ${NEUTRAL.zebra}; --surface: ${NEUTRAL.surface};
  --bar: ${mix(primary, "#ffffff", 0.45)}; --tint: ${mix(primary, "#ffffff", 0.93)};
  --good: ${TONE.good.fg}; --good-bg: ${TONE.good.bg}; --bad: ${TONE.bad.fg}; --bad-bg: ${TONE.bad.bg}; --neutral: ${TONE.neutral.fg}; --neutral-bg: ${TONE.neutral.bg}; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; color-scheme: light; }
body { margin: 0; background: var(--surface); color: var(--ink); font: 13px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Noto Sans", sans-serif; }
.page { max-width: 880px; margin: 24px auto; padding: 0 16px; }
.cover { background: var(--primary); color: var(--on-primary); border-radius: 12px; padding: 18px 24px 16px; border-bottom: 4px solid var(--accent); margin-bottom: 14px; }
.cover-top { display: flex; justify-content: space-between; align-items: center; gap: 12px; min-height: 28px; }
.brand { display: flex; align-items: center; gap: 10px; font-weight: 600; font-size: 13px; }
.brand img { height: 34px; max-width: 160px; object-fit: contain; background: #fff; border-radius: 6px; padding: 3px; }
.badge { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; border: 1px solid var(--on-primary-soft); color: var(--on-primary-soft); border-radius: 999px; padding: 2px 10px; white-space: nowrap; }
.kind { font-size: 11px; text-transform: uppercase; letter-spacing: .09em; color: var(--on-primary-soft); margin: 14px 0 2px; font-weight: 600; }
h1 { font-size: 28px; line-height: 1.15; margin: 0; letter-spacing: -.01em; }
.domain { color: var(--on-primary-soft); margin: 3px 0 14px; font-size: 14px; }
.cover-meta { display: flex; flex-wrap: wrap; gap: 6px 32px; margin: 0; border-top: 1px solid var(--cover-rule); padding-top: 10px; font-size: 12.5px; }
.cover-meta dt { color: var(--on-primary-soft); font-size: 10px; text-transform: uppercase; letter-spacing: .07em; }
.cover-meta dd { margin: 0; font-weight: 600; }
.kpis { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin: 0 0 4px; }
.kpi, .tile { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 12px 14px; break-inside: avoid; }
.tile { background: var(--zebra); border-color: transparent; padding: 10px 12px; }
.kpi-label { font-size: 10.5px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; font-weight: 600; }
.kpi-value { font-size: 26px; font-weight: 700; line-height: 1.15; margin: 4px 0 6px; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
.tile .kpi-value { font-size: 20px; margin: 2px 0 4px; }
.kpi-detail { font-size: 11px; color: var(--muted); margin-top: 4px; }
.kpi-caption { font-size: 11px; color: var(--faint); margin: 0 0 14px; text-align: right; }
.chip { display: inline-flex; align-items: center; gap: 4px; font-size: 11.5px; font-weight: 600; border-radius: 999px; padding: 1px 8px 1px 6px; font-variant-numeric: tabular-nums; }
.chip svg { width: 8px; height: 8px; fill: currentColor; }
.chip.good { color: var(--good); background: var(--good-bg); }
.chip.bad { color: var(--bad); background: var(--bad-bg); }
.chip.neutral { color: var(--neutral); background: var(--neutral-bg); }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.tiles { display: grid; gap: 8px; margin: 4px 0 12px; grid-template-columns: repeat(4, minmax(0, 1fr)); }
.tiles-1, .tiles-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .tiles-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); } .tiles-5 { grid-template-columns: repeat(5, minmax(0, 1fr)); }
.summary { background: #fff; border: 1px solid var(--rule); border-left: 4px solid var(--primary); border-radius: 10px; padding: 14px 18px 12px; margin: 0 0 14px; break-inside: avoid; }
.summary h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .07em; margin: 0 0 6px; color: var(--primary-ink); }
.summary ul { margin: 0; padding-left: 18px; } .summary li { margin: 3px 0; } .summary p { margin: 4px 0; }
.caption { font-size: 11px; color: var(--faint); margin: 8px 0 0; }
.card { background: #fff; border: 1px solid var(--rule); border-radius: 10px; padding: 14px 18px 8px; margin: 0 0 14px; -webkit-box-decoration-break: clone; box-decoration-break: clone; }
.card h2 { font-size: 15px; margin: 0 0 10px; color: var(--primary-ink); display: flex; align-items: center; gap: 8px; break-after: avoid; }
.card h2::before { content: ""; width: 4px; height: 15px; border-radius: 2px; background: var(--primary); flex: none; }
.pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; margin: 0 0 14px; } .pair > .card { margin: 0; }
.cols { display: grid; gap: 16px; } .cols-2 { grid-template-columns: repeat(2, minmax(0, 1fr)); } .cols-3 { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.col > :first-child { margin-top: 0; }
h3, .table-title { font-size: 12px; font-weight: 600; color: var(--ink); margin: 10px 0 4px; break-after: avoid; }
p { margin: 6px 0; }
.note { font-size: 11px; color: var(--muted); margin: 4px 0 8px; }
figure.chart, .cols, .tiles { break-inside: avoid; }
figure.chart { margin: 2px 0 10px; }
figure.chart figcaption.stack { flex-direction: column; align-items: flex-start; gap: 2px; }
figure.chart figcaption { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; flex-wrap: wrap; font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.legend { display: flex; flex-wrap: wrap; gap: 4px 12px; font-weight: 400; color: var(--muted); font-size: 11px; }
.key-item { white-space: nowrap; }
.key { display: inline-block; width: 14px; height: 0; border-top: 2px solid; vertical-align: middle; margin-right: 5px; }
.key.dashed { border-top-style: dashed; }
.key.box { width: 10px; height: 10px; border: 0; border-radius: 2px; }
.chart-svg { display: block; width: 100%; height: auto; overflow: visible; }
.chart-svg .tick { font-size: 10px; fill: ${NEUTRAL.muted}; font-family: inherit; font-variant-numeric: tabular-nums; }
.chart-svg .strong { font-weight: 600; fill: ${NEUTRAL.ink}; }
table { width: 100%; border-collapse: collapse; font-size: 12px; margin: 2px 0 10px; font-variant-numeric: tabular-nums; }
th { text-align: left; font-weight: 600; color: var(--muted); font-size: 10px; text-transform: uppercase; letter-spacing: .05em; padding: 6px 8px; border-bottom: 1.5px solid #cbd2d9; vertical-align: bottom; }
td { padding: 5px 8px; border-bottom: 1px solid var(--rule); vertical-align: top; overflow-wrap: break-word; }
tbody tr:nth-child(even) td { background: var(--zebra); }
tr, .tile, .kpi { break-inside: avoid; }
thead { display: table-header-group; }
.num { text-align: right; white-space: nowrap; }
.table-wrap { overflow-x: auto; }
.table-wrap:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
td.lead { min-width: 34%; }
.barbox { display: inline-grid; grid-template-columns: 70px auto; align-items: center; gap: 8px; }
.track { display: block; height: 7px; }
.bar { display: block; height: 7px; background: var(--bar); border-radius: 0 3px 3px 0; }
.v { min-width: 3.2em; }
.good { color: var(--good); font-weight: 600; } .bad { color: var(--bad); font-weight: 600; }
.kpi-value.good, .kpi-value.bad { font-weight: 700; }
.tag { display: inline-block; font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .04em; border-radius: 999px; padding: 0 7px; line-height: 16px; white-space: nowrap; }
${Object.entries(TAG_COLORS).map(([k, v]) => `.tag-${k} { color: ${v.fg}; background: ${v.bg}; }`).join("\n")}
code { font-family: ui-monospace, "SF Mono", Menlo, Consolas, monospace; font-size: 11px; overflow-wrap: anywhere; background: var(--zebra); border-radius: 3px; padding: 0 3px; }
.commentary { background: var(--tint); border-left: 3px solid var(--primary); border-radius: 6px; padding: 8px 14px; margin: 10px 0 8px; break-inside: avoid; }
.commentary .label { font-size: 10px; text-transform: uppercase; letter-spacing: .07em; font-weight: 700; color: var(--primary-ink); margin: 2px 0 4px; }
.about { margin: 20px 0 0; padding: 14px 18px; background: #fff; border: 1px solid var(--rule); border-radius: 10px; font-size: 11px; color: var(--muted); }
.about h2 { break-after: avoid; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; color: var(--ink); margin: 0 0 6px; }
.about ul { margin: 0; padding-left: 16px; } .about li { margin: 2px 0; }
.colophon { display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--faint); padding: 12px 2px 24px; }
@media (max-width: 640px) {
  .kpis, .tiles, .tiles-5, .tiles-3 { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .pair, .cols-2, .cols-3 { grid-template-columns: minmax(0, 1fr); }
  h1 { font-size: 24px; }
}
/* PDF running header in the page's top margin (CSS page-margin box), left off the first page where the cover band is. */
@page { @top-left { content: ${cssString(runningHeader)}; font: 8px system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; color: ${NEUTRAL.faint}; vertical-align: bottom; padding-bottom: 3mm; } }
@page :first { @top-left { content: none; } }
@media print {
  /* Print density: a dashboard export fills its pages. */
  body { background: #fff; font-size: 10.5px; line-height: 1.4; }
  .page { max-width: none; margin: 0; padding: 0; }
  .cover { padding: 14px 20px 12px; } .kind { margin-top: 8px; } h1 { font-size: 24px; } .domain { margin-bottom: 10px; }
  .kpis { gap: 10px; } .kpi { padding: 10px 12px; } .kpi-value { font-size: 22px; margin: 2px 0 4px; } .kpi-caption { margin-bottom: 10px; }
  .summary { padding: 10px 16px 8px; margin-bottom: 10px; } .summary li { margin: 1px 0; }
  .card { padding: 10px 14px 4px; margin-bottom: 10px; } .card h2 { font-size: 13.5px; margin-bottom: 6px; } .pair { gap: 10px; margin-bottom: 10px; }
  table { font-size: 10.5px; margin-bottom: 6px; } th { padding: 4px 6px; font-size: 9px; } td { padding: 3px 6px; }
  .tiles { gap: 6px; margin-bottom: 8px; } .tile { padding: 7px 10px; } .tile .kpi-value { font-size: 17px; }
  h3, .table-title { margin: 6px 0 3px; } p { margin: 4px 0; } .note { margin: 3px 0 6px; } figure.chart { margin-bottom: 6px; } .cols { gap: 12px; }
  .about { margin-top: 10px; padding: 10px 14px; }
  .pair .track { display: none; } .pair .barbox { grid-template-columns: auto; } .pair td.lead { min-width: 0; } .pair th { letter-spacing: 0; } .pair .num { white-space: normal; }
  /* Only atomic units stay whole (a chart, a KPI row, a table row, a callout); section cards flow across pages. */
  .card h2, h3, .table-title, figcaption { break-after: avoid; }
  .summary { font-size: 10px; }
  .lead-in { break-inside: avoid; } p.note { break-before: avoid; }
  .table-wrap { overflow: visible; }
  .cover { margin-bottom: 12px; }
  .colophon { padding-bottom: 0; }
}
${
  onepage
    ? `/* One-page executive layout: tighter spacing so it fits one printed page. */
.pair { break-inside: avoid; }
.cover { padding: 12px 20px 10px; margin-bottom: 10px; } .kind { margin-top: 4px; } .brand img { height: 28px; } h1 { font-size: 22px; } .domain { margin: 1px 0 8px; font-size: 13px; } .cover-meta { padding-top: 7px; }
.summary li { margin: 1px 0; } figure.chart { margin-bottom: 4px; } table { font-size: 11px; } .summary .caption { display: none; } figure.chart .chart-title { display: none; } figure.chart figcaption { justify-content: flex-end; margin-top: -26px; } .kpi-caption { margin: -2px 0 8px; } .card h2 { margin-bottom: 6px; } .kpis { gap: 10px; } .about p { margin: 0; } .colophon { padding-top: 6px; }
.kpi { padding: 10px 12px; } .kpi-value { font-size: 22px; margin: 2px 0 4px; }
.card { padding: 12px 16px 6px; margin-bottom: 10px; } .pair { margin-bottom: 10px; } .summary { padding: 10px 16px 8px; margin-bottom: 10px; }
.about { margin-top: 6px; padding: 8px 14px; font-size: 10px; } .about h2 { margin-bottom: 2px; } .kpi-caption { margin-bottom: 10px; }
td { padding: 4px 6px; } th { padding: 4px 6px; }`
    : ""
}
</style>`;
}

export function toHtml(doc: ReportDoc, opts: HtmlOptions = {}): string {
  const docs = opts.variant === "docs";
  const b = doc.branding;
  const primary = safeColor(b.primaryColor, DEFAULT_PRIMARY);
  const accent = safeColor(b.accentColor, DEFAULT_ACCENT);
  const onepage = doc.meta.layout === "onepage";
  const ctx: Ctx = { docs, width: 680, primary, onepage };
  const head = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(doc.meta.title)}</title>`,
    ...(docs ? [] : [style(primary, accent, onepage, doc.meta.runningHeader)]),
    "</head>",
    docs ? "<body>" : `<body${onepage ? ' class="onepage"' : ""}>`,
  ];
  const m = doc.meta;
  const body: string[] = [];
  if (docs) {
    body.push(
      ...(b.agencyName ? [`<p><strong>${escapeHtml(b.agencyName)}</strong></p>`] : []),
      `<h1>${escapeHtml(m.clientName)}</h1>`,
      `<p><strong>${escapeHtml(m.domain)}</strong> · ${escapeHtml(m.templateTitle)} · ${escapeHtml(m.periodLabel)} (${escapeHtml(m.periodRange)})</p>`,
      `<p>${m.compareWith ? `Compared with ${escapeHtml(m.compareWith)} · ` : ""}Generated ${escapeHtml(m.generated)} · ${escapeHtml(doc.badge)}</p>`,
    );
    if (doc.kpis.length) body.push("<h2>Key figures</h2>", kpiTable(doc.kpis), ...(doc.kpiCaption ? [`<p><em>${escapeHtml(doc.kpiCaption)}</em></p>`] : []));
    if (doc.summary) {
      body.push(`<h2>${escapeHtml(doc.summary.title)}</h2>`);
      if (doc.summary.narrative) body.push(commentaryBox(doc.summary.narrative, ctx));
      if (doc.summary.items) body.push(`<ul>${doc.summary.items.map((h) => `<li>${text(h, ctx)}</li>`).join("")}</ul>`);
      body.push(`<p><em>${escapeHtml(doc.summary.caption)}</em></p>`);
    }
    for (const s of doc.sections) body.push(section(s, ctx, ctx.width));
    body.push("<h2>About this report</h2>", `<ul>${doc.about.map((a) => `<li>${text(a, ctx)}</li>`).join("")}</ul>`, `<p><em>${escapeHtml(doc.footer)}</em></p>`, "</body>", "</html>");
    return [...head, ...body.filter(Boolean)].join("\n") + "\n";
  }

  const logo = b.logo ? `<img alt="${escapeHtml(b.agencyName ?? "Logo")}" src="data:${b.logo.mime};base64,${b.logo.data.toString("base64")}">` : "";
  body.push(
    '<div class="page">',
    '<header class="cover">',
    `<div class="cover-top"><div class="brand">${logo}${b.agencyName ? `<span>${escapeHtml(b.agencyName)}</span>` : ""}</div><span class="badge">${escapeHtml(doc.badge)}</span></div>`,
    `<p class="kind">${escapeHtml(m.templateTitle)}</p>`,
    `<h1>${escapeHtml(m.clientName)}</h1>`,
    `<p class="domain">${escapeHtml(m.domain)}</p>`,
    '<dl class="cover-meta">',
    `<div><dt>Period</dt><dd>${escapeHtml(m.periodLabel)} · ${escapeHtml(m.periodRange)}</dd></div>`,
    ...(m.compareWith ? [`<div><dt>Compared with</dt><dd>${escapeHtml(m.compareWith)}</dd></div>`] : []),
    `<div><dt>Generated</dt><dd>${escapeHtml(m.generated)}</dd></div>`,
    "</dl>",
    "</header>",
    "<main>",
  );
  if (doc.kpis.length) {
    body.push(`<section class="kpis" aria-label="Key figures">${doc.kpis.map((k) => kpiCard(k, ctx, false)).join("")}</section>`);
    if (doc.kpiCaption) body.push(`<p class="kpi-caption">${escapeHtml(doc.kpiCaption)}</p>`);
  }
  if (doc.summary) {
    const s = doc.summary;
    body.push(
      `<section class="summary" aria-label="${escapeHtml(s.title)}"><h2>${escapeHtml(s.title)}</h2>`,
      s.narrative ? narrative(s.narrative, ctx) : "",
      s.items ? `<ul>${s.items.map((h) => `<li>${text(h, ctx)}</li>`).join("")}</ul>` : "",
      `<p class="caption">${escapeHtml(s.caption)}</p></section>`,
    );
  }
  // Consecutive half-width sections share a row.
  for (let i = 0; i < doc.sections.length; i++) {
    const s = doc.sections[i]!;
    const next = doc.sections[i + 1];
    if (s.half && next?.half) {
      body.push(`<div class="pair">${section(s, ctx, 300)}${section(next, ctx, 300)}</div>`);
      i++;
    } else body.push(section(s, ctx, 680));
  }
  body.push(
    "</main>",
    onepage
      ? `<footer class="about"><h2>About this report</h2><p>${doc.about.map((a) => text(a, ctx)).join(" ")}</p></footer>`
      : `<footer class="about"><h2>About this report</h2><ul>${doc.about.map((a) => `<li>${text(a, ctx)}</li>`).join("")}</ul></footer>`,
    `<div class="colophon"><span>${escapeHtml(doc.footer)}</span><span>Generated ${escapeHtml(m.generated)}</span></div>`,
    "</div>",
    "</body>",
    "</html>",
  );
  return [...head, ...body.filter(Boolean)].join("\n") + "\n";
}
