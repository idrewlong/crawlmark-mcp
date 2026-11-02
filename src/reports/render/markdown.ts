/**
 * Markdown renderer (pure). All data text is escaped (escape.ts); link-like
 * text becomes a code span, so no data string turns into a link or raw HTML.
 * Same structure as the HTML file: header, key figures, summary, one section
 * per card, charts as their small tables, and "About this report".
 */
import { coverEntries, type Block, type Chart, type DocNarrativeBlock, type Kpi, type ReportDoc, type TableBlock, type Text } from "./doc.js";
import { escapeMarkdown, looksLinky, markdownCode } from "./escape.js";
import type { Run } from "./narrative.js";

function run(r: Run, first: boolean): string {
  if (r.c || looksLinky(r.t)) return markdownCode(r.t);
  // Bold and tagged text is wrapped in ** or * so it can't start a block; plain text that comes first can.
  const e = escapeMarkdown(r.t, first && !r.b && !r.tag);
  if (r.tag) return e.trim() ? `*${e}*` : e;
  return r.b && e.trim() ? `**${e}**` : e;
}
/** Runs of one block: only the first one starts the line. Table cells never start a block. */
const text = (t: Text, block = true) => t.map((r, i) => (r.tag && i > 0 ? " " : "") + run(r, block && i === 0)).join("");

/** Commentary blocks as Markdown chunks (one per block, no quote prefix). */
function narrativeChunks(blocks: DocNarrativeBlock[]): string[][] {
  const out: string[][] = [];
  for (const b of blocks) {
    if (b.kind === "p") out.push([text(b.runs)]);
    else if (b.kind === "ul") out.push(b.items.map((item) => `- ${text(item)}`));
    else if (b.kind === "ol") out.push(b.items.map((item, i) => `${b.start + i}. ${text(item)}`));
    else if (b.kind === "h") out.push([`#### ${text(b.runs, false)}`]);
    else if (b.kind === "table") out.push(commentaryTable(b));
    else if (b.kind === "chart") {
      const lines = chart(b.chart);
      if (lines.length) out.push(lines);
    }
  }
  return out;
}

function commentaryTable(b: Extract<DocNarrativeBlock, { kind: "table" }>): string[] {
  const cols = b.header.length;
  const cell = (c: Text) => text(c, false) || " ";
  return [`| ${b.header.map(cell).join(" | ")} |`, `| ${b.header.map((_, i) => (b.align[i] === "right" ? "---:" : "---")).join(" | ")} |`, ...b.rows.map((r) => `| ${Array.from({ length: cols }, (_, i) => cell(r[i] ?? [])).join(" | ")} |`)];
}

function quoteBox(title: string, blocks: DocNarrativeBlock[]): string[] {
  const out = [`> **${escapeMarkdown(title)}**`, ">"];
  narrativeChunks(blocks).forEach((chunk, i) => {
    if (i) out.push(">");
    for (const l of chunk) out.push(l ? `> ${l}` : ">");
  });
  return out;
}

function table(b: TableBlock): string[] {
  const head = `| ${b.header.map((h) => escapeMarkdown(h, false)).join(" | ")} |`;
  const sep = `| ${b.header.map((_, i) => (b.numeric?.[i] ? "---:" : "---")).join(" | ")} |`;
  return [...(b.title ? [`**${escapeMarkdown(b.title, false)}**`, ""] : []), head, sep, ...b.rows.map((r) => `| ${r.map((c) => text(c, false) || " ").join(" | ")} |`)];
}

const ARROW = { up: "▲", down: "▼", flat: "–" } as const;
const kpiTable = (items: Kpi[]): string[] => {
  const t: TableBlock = {
    kind: "table",
    header: items.map((k) => k.label),
    rows: [items.map((k) => [{ t: k.value, b: true }]), ...(items.some((k) => k.delta || k.detail) ? [items.map((k) => [{ t: [k.delta ? `${ARROW[k.delta.dir]} ${k.delta.text}` : "", k.detail ?? ""].filter(Boolean).join(" · ") }])] : [])],
    numeric: items.map(() => true),
  };
  return table(t);
};

const chart = (c: Chart): string[] => (c.fallback ? table(c.fallback) : []);

function block(b: Block): string[][] {
  switch (b.kind) {
    case "heading":
      return [[`### ${escapeMarkdown(b.text)}`]];
    case "paragraph":
      return [[text(b.text)]];
    case "note":
      return [[`*${text(b.text)}*`]];
    case "list":
      return [b.items.map((i) => `- ${text(i)}`)];
    case "table":
      return [table(b)];
    case "kpiRow":
      return [kpiTable(b.items)];
    case "commentary":
      return [quoteBox("Commentary", b.blocks)];
    case "chart":
      return [chart(b.chart)].filter((x) => x.length);
    case "columns":
      return b.columns.flat().flatMap(block);
    case "rich":
      return narrativeChunks(b.blocks);
  }
}

export function toMarkdown(doc: ReportDoc): string {
  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls, "");
  const m = doc.meta;
  if (doc.branding.agencyName) push(`**${escapeMarkdown(doc.branding.agencyName)}**`);
  push(`# ${escapeMarkdown(m.clientName)}`);
  if (m.cover.subtitle) push(`*${escapeMarkdown(m.cover.subtitle, false)}*`);
  // The period joins the first line when it is the first labelled entry (the default cover); the rest follow in order.
  const cv = coverEntries(m);
  const first = cv.entries[0]?.field === "period" ? cv.entries[0] : undefined;
  const entryText = (e: (typeof cv.entries)[number]) => `${e.field === "period" ? "Period:" : e.label} ${escapeMarkdown(e.value, false)}`;
  const line1 = [...(cv.domain ? [`**${escapeMarkdown(m.domain, false)}**`] : []), escapeMarkdown(m.templateTitle, false), ...(first ? [`${escapeMarkdown(m.periodLabel, false)} (${escapeMarkdown(m.periodRange, false)})`] : [])].join(" · ");
  const line2 = [...cv.entries.slice(first ? 1 : 0).map(entryText), ...(cv.badge ? [`*${escapeMarkdown(doc.badge, false)}*`] : [])].join(" · ");
  push(...(line2 ? [`${line1}  `, line2] : [line1]));
  if (doc.contents) {
    push("## Contents");
    push(...doc.contents.map((c, i) => `${i + 1}. ${escapeMarkdown(c.title, false)}`));
  }
  if (doc.kpis.length) {
    push("## Key figures");
    push(...kpiTable(doc.kpis));
    if (doc.kpiCaption) push(`*${escapeMarkdown(doc.kpiCaption)}*`);
  }
  if (doc.summary) {
    const s = doc.summary;
    push(`## ${escapeMarkdown(s.title)}`);
    if (s.narrative) push(...quoteBox("Commentary", s.narrative));
    if (s.items) push(...s.items.map((h) => `- ${text(h)}`));
    if (s.caption) push(`*${escapeMarkdown(s.caption)}*`);
  }
  for (const s of doc.sections) {
    push(`## ${escapeMarkdown(s.title)}`);
    for (const b of s.blocks) for (const chunk of block(b)) push(...chunk);
    if (s.commentary) push(...quoteBox("Commentary", s.commentary));
  }
  push("## About this report");
  push(...doc.about.map((a) => `- ${text(a)}`));
  push("---", escapeMarkdown(doc.footer));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
