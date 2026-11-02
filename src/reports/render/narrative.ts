/**
 * Model-written commentary (D2, D4, B-C4): a tiny Markdown subset. Paragraphs
 * (separated by a blank line), `- ` bullets, `1.` lists, `##`-`####` sub-headings,
 * pipe tables, `{{chart <sectionId>}}` lines and `**bold**`; everything else is
 * literal text (raw HTML and links stay as typed). stripControl runs first; each
 * renderer escapes the result for its own format.
 */
import { chartRefCount, MAX_CHART_REFS, MAX_INTERNAL_CHARS, MAX_NARRATIVE_CHARS, MAX_NARRATIVE_FIELD, NarrativeParseError, parseNarrative, type NarrativeBlock } from "./narrative-parse.js";

export * from "./narrative-parse.js";

/** A text for the client, or a client / internal split. A plain string counts as client text. */
export type NarrativeText = string | { client?: string | undefined; internal?: string | undefined };

export interface Narrative {
  summary?: NarrativeText | undefined;
  sections?: Record<string, NarrativeText> | undefined;
  /** General internal notes; never rendered into client files. */
  internal?: string | undefined;
}

/** The part of a narrative text a client file may show. */
export function clientText(v: NarrativeText | undefined): string | undefined {
  return typeof v === "string" ? v : v?.client;
}

/** The internal part of a narrative text (a plain string has none). */
export function internalText(v: NarrativeText | undefined): string | undefined {
  return typeof v === "string" ? undefined : v?.internal;
}

const num = (n: number) => n.toLocaleString("en-US");

/** Checks the narrative against the report's section ids and the size limits. Throws with the field name. */
export function validateNarrative(n: Narrative | undefined, sectionIds: readonly string[]): void {
  if (!n) return;
  const unknown = Object.keys(n.sections ?? {}).filter((id) => !sectionIds.includes(id));
  if (unknown.length) throw new Error(`narrative.sections has ids that aren't sections of this report: ${unknown.join(", ")}. Sections: ${sectionIds.join(", ")}.`);
  const fields: { where: string; text: string; internal: boolean }[] = [];
  const add = (where: string, v: NarrativeText | undefined) => {
    fields.push({ where, text: clientText(v) ?? "", internal: false }, { where: `${where}.internal`, text: internalText(v) ?? "", internal: true });
  };
  add("narrative.summary", n.summary);
  for (const [id, v] of Object.entries(n.sections ?? {})) add(`narrative.sections.${id}`, v);
  fields.push({ where: "narrative.internal", text: n.internal ?? "", internal: true });
  let client = 0;
  let internal = 0;
  let chartRefs = 0;
  for (const f of fields) {
    if (f.text.length > MAX_NARRATIVE_FIELD) throw new Error(`${f.where} is ${num(f.text.length)} characters; at most ${num(MAX_NARRATIVE_FIELD)} per text.`);
    if (f.internal) internal += f.text.length;
    else client += f.text.length;
    if (!f.text) continue;
    let blocks: NarrativeBlock[];
    try {
      blocks = parseNarrative(f.text);
    } catch (err) {
      if (err instanceof NarrativeParseError) throw new Error(`${f.where}: ${err.message}`);
      throw err;
    }
    // Internal notes become a Markdown file with no charts, so only client text is checked for chart references.
    if (f.internal) continue;
    chartRefs += chartRefCount(blocks);
    if (chartRefs > MAX_CHART_REFS) {
      throw new Error(`${f.where}: the commentary has more than ${MAX_CHART_REFS} {{chart}} references; at most ${MAX_CHART_REFS} per report. Keep the ones that matter most.`);
    }
    for (const b of blocks) {
      if (b.kind === "chartRef" && !sectionIds.includes(b.section)) {
        throw new Error(`${f.where}: {{chart ${b.section}}} isn't a section of this report. Sections: ${sectionIds.join(", ")}.`);
      }
    }
  }
  if (client > MAX_NARRATIVE_CHARS) throw new Error(`The client-facing narrative is ${num(client)} characters; the limit is ${num(MAX_NARRATIVE_CHARS)}.`);
  if (internal > MAX_INTERNAL_CHARS) throw new Error(`The internal notes are ${num(internal)} characters; the limit is ${num(MAX_INTERNAL_CHARS)}.`);
}
