/**
 * HTML renderer (pure). The file variant is a self-contained page: a strict CSP
 * meta (no script, no external resource; the logo is a data: URI), inline CSS,
 * every string escaped. The docs variant is for the Google Docs handoff: no
 * logo, no <style>, plain bordered tables.
 */
import type { Block, ReportDoc, Text } from "./doc.js";
import { escapeHtml, safeColor } from "./escape.js";
import type { NarrativeBlock, Run } from "./narrative.js";

export const CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'";

export interface HtmlOptions {
  variant?: "file" | "docs";
}

const run = (r: Run) => (r.c ? `<code>${escapeHtml(r.t)}</code>` : r.b ? `<strong>${escapeHtml(r.t)}</strong>` : escapeHtml(r.t));
const text = (t: Text) => t.map(run).join("");

function narrative(blocks: NarrativeBlock[]): string {
  return blocks.map((b) => (b.kind === "p" ? `<p>${text(b.runs)}</p>` : `<ul>${b.items.map((i) => `<li>${text(i)}</li>`).join("")}</ul>`)).join("\n");
}

function commentaryBox(blocks: NarrativeBlock[], docs: boolean): string {
  return docs
    ? `<blockquote><p><strong>Commentary</strong></p>\n${narrative(blocks)}</blockquote>`
    : `<aside class="commentary"><p class="label">Commentary</p>\n${narrative(blocks)}</aside>`;
}

function table(header: string[], rows: Text[][], numeric: boolean[] | undefined, docs: boolean): string {
  const attrs = docs ? ' border="1" cellpadding="4" cellspacing="0"' : "";
  const cls = (i: number) => (numeric?.[i] && !docs ? ' class="num"' : "");
  return [
    `<table${attrs}>`,
    `<thead><tr>${header.map((h, i) => `<th${cls(i)}>${escapeHtml(h)}</th>`).join("")}</tr></thead>`,
    `<tbody>${rows.map((r) => `<tr>${r.map((c, i) => `<td${cls(i)}>${text(c)}</td>`).join("")}</tr>`).join("\n")}</tbody>`,
    "</table>",
  ].join("\n");
}

function block(b: Block, docs: boolean): string {
  switch (b.kind) {
    case "heading":
      return `<h${b.level}>${escapeHtml(b.text)}</h${b.level}>`;
    case "paragraph":
      return `<p>${text(b.text)}</p>`;
    case "note":
      return `<p class="note"><em>${text(b.text)}</em></p>`;
    case "list":
      return `<ul>${b.items.map((i) => `<li>${text(i)}</li>`).join("")}</ul>`;
    case "table":
      return table(b.header, b.rows, b.numeric, docs);
    case "kpiRow":
      return docs
        ? table(b.items.map((k) => k.label), [b.items.map((k) => [{ t: k.value }])], undefined, true)
        : `<div class="kpis">${b.items.map((k) => `<div class="kpi"><div class="kpi-label">${escapeHtml(k.label)}</div><div class="kpi-value">${escapeHtml(k.value)}</div></div>`).join("")}</div>`;
    case "commentary":
      return commentaryBox(b.blocks, docs);
  }
}

function style(primary: string, accent: string): string {
  return `<style>
:root { --primary: ${primary}; --accent: ${accent}; }
body { font-family: -apple-system, "Segoe UI", Helvetica, Arial, sans-serif; color: #1a1a1a; max-width: 960px; margin: 24px auto; padding: 0 16px; line-height: 1.45; font-size: 14px; }
header { border-bottom: 3px solid var(--primary); padding-bottom: 12px; margin-bottom: 16px; }
header img { max-height: 56px; max-width: 220px; display: block; margin-bottom: 8px; }
.agency { color: var(--primary); font-weight: 600; }
h1 { font-size: 24px; margin: 4px 0; color: var(--primary); }
h2 { font-size: 18px; color: var(--primary); border-bottom: 1px solid #ddd; padding-bottom: 4px; margin-top: 28px; }
h3 { font-size: 15px; margin: 16px 0 6px; }
.meta { color: #444; margin: 2px 0; }
.banner { border: 1px solid var(--accent); border-left: 6px solid var(--accent); background: #f6faf6; padding: 10px 14px; margin: 16px 0; }
.kpis { display: flex; flex-wrap: wrap; gap: 10px; margin: 8px 0; }
.kpi { border: 1px solid #ddd; border-radius: 6px; padding: 8px 12px; min-width: 140px; }
.kpi-label { font-size: 12px; color: #555; }
.kpi-value { font-size: 20px; font-weight: 600; }
.kpi-detail { font-size: 12px; color: #444; }
table { border-collapse: collapse; width: 100%; margin: 8px 0 12px; font-size: 13px; }
th, td { border: 1px solid #d6d6d6; padding: 5px 7px; text-align: left; vertical-align: top; word-break: break-word; }
th { background: #f1f4f8; }
tr { page-break-inside: avoid; }
.num { text-align: right; white-space: nowrap; }
code { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 12px; word-break: break-all; }
.note { color: #555; font-size: 12px; }
.commentary { border-left: 4px solid var(--primary); background: #f5f8fc; padding: 6px 14px; margin: 12px 0; }
.commentary .label { font-weight: 600; color: var(--primary); margin: 4px 0; }
footer { border-top: 1px solid #ddd; margin-top: 32px; padding-top: 8px; color: #555; font-size: 12px; }
@media print { body { margin: 0; max-width: none; } h2 { page-break-after: avoid; } }
</style>`;
}

export function toHtml(doc: ReportDoc, opts: HtmlOptions = {}): string {
  const docs = opts.variant === "docs";
  const b = doc.branding;
  const head = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    `<meta http-equiv="Content-Security-Policy" content="${CSP}">`,
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="referrer" content="no-referrer">',
    `<title>${escapeHtml(doc.meta.title)}</title>`,
    ...(docs ? [] : [style(safeColor(b.primaryColor, "#1f4e79"), safeColor(b.accentColor, "#2e8540"))]),
    "</head>",
    "<body>",
  ];
  const logo = !docs && b.logo ? `<img alt="${escapeHtml(b.agencyName ?? "Logo")}" src="data:${b.logo.mime};base64,${b.logo.data.toString("base64")}">` : "";
  const body: string[] = [
    "<header>",
    logo,
    b.agencyName ? `<div class="agency">${escapeHtml(b.agencyName)}</div>` : "",
    `<h1>${escapeHtml(doc.meta.clientLine)}</h1>`,
    `<p class="meta">${escapeHtml(doc.meta.reportLine)}</p>`,
    `<p class="meta">${escapeHtml(doc.meta.compareLine)}</p>`,
    "</header>",
    docs
      ? `<p><strong>${escapeHtml(doc.banner.title)}.</strong> ${escapeHtml(doc.banner.text)}</p>`
      : `<section class="banner"><strong>${escapeHtml(doc.banner.title)}.</strong> ${escapeHtml(doc.banner.text)}</section>`,
  ];
  if (doc.kpis.length) {
    body.push("<h2>Key figures</h2>");
    body.push(
      docs
        ? table(["Metric", "Value", "Change"], doc.kpis.map((k) => [[{ t: k.label }], [{ t: k.value }], [{ t: k.detail ?? "" }]]), undefined, true)
        : `<div class="kpis">${doc.kpis.map((k) => `<div class="kpi"><div class="kpi-label">${escapeHtml(k.label)}</div><div class="kpi-value">${escapeHtml(k.value)}</div>${k.detail ? `<div class="kpi-detail">${escapeHtml(k.detail)}</div>` : ""}</div>`).join("")}</div>`,
    );
  }
  if (doc.highlights.length) body.push("<h2>Highlights (computed automatically)</h2>", `<ul>${doc.highlights.map((h) => `<li>${text(h)}</li>`).join("")}</ul>`);
  if (doc.summary) body.push("<h2>Summary</h2>", commentaryBox(doc.summary, docs));
  for (const bl of [...doc.blocks, ...doc.sourcesAndNotes]) body.push(block(bl, docs));
  body.push(`<footer>${escapeHtml(doc.footer)}</footer>`, "</body>", "</html>");
  return [...head, ...body.filter(Boolean)].join("\n") + "\n";
}
