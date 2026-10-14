/**
 * Markdown renderer (pure). All data text is escaped (escape.ts); link-like
 * text becomes a code span, so no data string turns into a link or raw HTML.
 * Same structure as the HTML file: header, key figures, summary, one section
 * per card, charts as their small tables, and "About this report".
 */
import type { Block, Chart, Kpi, ReportDoc, TableBlock, Text } from "./doc.js";
import { escapeMarkdown, looksLinky, markdownCode } from "./escape.js";
import type { NarrativeBlock, Run } from "./narrative.js";

function run(r: Run, first: boolean): string {
  if (r.c || looksLinky(r.t)) return markdownCode(r.t);
  // Bold and tagged text is wrapped in ** or * so it can't start a block; plain text that comes first can.
  const e = escapeMarkdown(r.t, first && !r.b && !r.tag);
  if (r.tag) return e.trim() ? `*${e}*` : e;
  return r.b && e.trim() ? `**${e}**` : e;
}
/** Runs of one block: only the first one starts the line. Table cells never start a block. */
const text = (t: Text, block = true) => t.map((r, i) => (r.tag && i > 0 ? " " : "") + run(r, block && i === 0)).join("");

function quoteBox(title: string, blocks: NarrativeBlock[]): string[] {
  const out = [`> **${escapeMarkdown(title)}**`, ">"];
  blocks.forEach((b, i) => {
    if (i) out.push(">");
    if (b.kind === "p") out.push(`> ${text(b.runs)}`);
    else for (const item of b.items) out.push(`> - ${text(item)}`);
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
  }
}

export function toMarkdown(doc: ReportDoc): string {
  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls, "");
  const m = doc.meta;
  if (doc.branding.agencyName) push(`**${escapeMarkdown(doc.branding.agencyName)}**`);
  push(`# ${escapeMarkdown(m.clientName)}`);
  push(
    `**${escapeMarkdown(m.domain, false)}** · ${escapeMarkdown(m.templateTitle, false)} · ${escapeMarkdown(m.periodLabel, false)} (${escapeMarkdown(m.periodRange, false)})  `,
    `${m.compareWith ? `Compared with ${escapeMarkdown(m.compareWith, false)} · ` : ""}Generated ${escapeMarkdown(m.generated, false)} · *${escapeMarkdown(doc.badge, false)}*`,
  );
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
    push(`*${escapeMarkdown(s.caption)}*`);
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
