/**
 * The internal notes file (B-C5): the `internal` parts of the narrative as one Markdown document that is never
 * given to the client. Text is parsed with the commentary parser and escaped like client Markdown, so it can't
 * become raw HTML or a link.
 */
import type { TemplateReport } from "../report-types.js";
import { escapeMarkdown, looksLinky, markdownCode } from "./escape.js";
import { internalText, parseNarrative, type Narrative, type NarrativeBlock, type Run } from "./narrative.js";

function run(r: Run, first: boolean): string {
  if (r.c || looksLinky(r.t)) return markdownCode(r.t);
  const e = escapeMarkdown(r.t, first && !r.b);
  return r.b && e.trim() ? `**${e}**` : e;
}
const runs = (rs: Run[], block = true) => rs.map((r, i) => run(r, block && i === 0)).join("");

function blocks(text: string): string[] {
  const out: string[] = [];
  for (const b of parseNarrative(text) as NarrativeBlock[]) {
    if (b.kind === "p") out.push(runs(b.runs));
    else if (b.kind === "h") out.push(`#### ${runs(b.runs, false)}`);
    else if (b.kind === "ul") out.push(b.items.map((i) => `- ${runs(i, false)}`).join("\n"));
    else if (b.kind === "ol") out.push(b.items.map((i, n) => `${b.start + n}. ${runs(i, false)}`).join("\n"));
    else if (b.kind === "table") {
      const row = (cells: Run[][]) => `| ${cells.map((c) => runs(c, false) || " ").join(" | ")} |`;
      out.push([row(b.header), `| ${b.align.map((a) => (a === "right" ? "---:" : "---")).join(" | ")} |`, ...b.rows.map(row)].join("\n"));
    } else out.push(`(chart: ${escapeMarkdown(b.section, false)})`);
  }
  return out;
}

/** The internal notes of a narrative, or undefined when there are none. */
export function internalNotesMarkdown(report: Pick<TemplateReport, "client" | "template" | "period" | "sections">, n: Narrative | undefined): string | undefined {
  if (!n) return undefined;
  const parts: { title?: string; text: string }[] = [];
  if (n.internal?.trim()) parts.push({ text: n.internal });
  const summary = internalText(n.summary);
  if (summary?.trim()) parts.push({ title: "Summary", text: summary });
  for (const s of report.sections) {
    const t = internalText(n.sections?.[s.id]);
    if (t?.trim()) parts.push({ title: s.title, text: t });
  }
  if (!parts.length) return undefined;
  const lines = ["# Internal notes (not for the client)", "", escapeMarkdown(`${report.client.name} - ${report.template.title} - ${report.period.label}`)];
  for (const p of parts) {
    lines.push("");
    if (p.title) lines.push(`## ${escapeMarkdown(p.title, false)}`, "");
    lines.push(blocks(p.text).join("\n\n"));
  }
  return `${lines.join("\n")}\n`;
}
