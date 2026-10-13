/**
 * Markdown renderer (pure). All data text is escaped (escape.ts); link-like
 * text becomes a code span, so no data string turns into a link or raw HTML.
 */
import type { Block, ReportDoc, Text } from "./doc.js";
import { escapeMarkdown, looksLinky, markdownCode } from "./escape.js";
import type { NarrativeBlock, Run } from "./narrative.js";

function run(r: Run, first: boolean): string {
  if (r.c || looksLinky(r.t)) return markdownCode(r.t);
  // Bold text is wrapped in ** so it can't start a block; plain text that comes first can.
  const e = escapeMarkdown(r.t, first && !r.b);
  return r.b && e.trim() ? `**${e}**` : e;
}
/** Runs of one block: only the first one starts the line. Table cells never start a block. */
const text = (t: Text, block = true) => t.map((r, i) => run(r, block && i === 0)).join("");

function commentary(blocks: NarrativeBlock[], title = "Commentary"): string[] {
  const out = [`> **${title}**`, ">"];
  blocks.forEach((b, i) => {
    if (i) out.push(">");
    if (b.kind === "p") out.push(`> ${text(b.runs)}`);
    else for (const item of b.items) out.push(`> - ${text(item)}`);
  });
  return out;
}

function table(header: string[], rows: Text[][], numeric?: boolean[]): string[] {
  const head = `| ${header.map((h) => escapeMarkdown(h, false)).join(" | ")} |`;
  const sep = `| ${header.map((_, i) => (numeric?.[i] ? "---:" : "---")).join(" | ")} |`;
  return [head, sep, ...rows.map((r) => `| ${r.map((c) => text(c, false) || " ").join(" | ")} |`)];
}

function block(b: Block): string[] {
  switch (b.kind) {
    case "heading":
      return [`${"#".repeat(b.level)} ${escapeMarkdown(b.text)}`];
    case "paragraph":
      return [text(b.text)];
    case "note":
      return [`*${text(b.text)}*`];
    case "list":
      return b.items.map((i) => `- ${text(i)}`);
    case "table":
      return table(b.header, b.rows, b.numeric);
    case "kpiRow":
      return table(b.items.map((k) => k.label), [b.items.map((k) => [{ t: k.value }])]);
    case "commentary":
      return commentary(b.blocks);
  }
}

export function toMarkdown(doc: ReportDoc): string {
  const lines: string[] = [];
  const push = (...ls: string[]) => lines.push(...ls, "");
  if (doc.branding.agencyName) push(`**${escapeMarkdown(doc.branding.agencyName)}**`);
  push(`# ${escapeMarkdown(doc.meta.clientLine)}`);
  push(escapeMarkdown(doc.meta.reportLine) + "  ", escapeMarkdown(doc.meta.compareLine));
  push(`> **${escapeMarkdown(doc.banner.title)}.** ${escapeMarkdown(doc.banner.text)}`);
  if (doc.kpis.length) {
    push("## Key figures");
    push(...table(["Metric", "Value", "Change"], doc.kpis.map((k) => [[{ t: k.label }], [{ t: k.value }], [{ t: k.detail ?? "" }]]), [false, true, false]));
  }
  if (doc.highlights.length) {
    push("## Highlights (computed automatically)");
    push(...doc.highlights.map((h) => `- ${text(h)}`));
  }
  if (doc.summary) {
    push("## Summary");
    push(...commentary(doc.summary));
  }
  for (const b of [...doc.blocks, ...doc.sourcesAndNotes]) push(...block(b));
  push("---", escapeMarkdown(doc.footer));
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}
