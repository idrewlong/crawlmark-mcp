/**
 * Model-written commentary (D2, D4): a tiny Markdown subset. Paragraphs
 * (separated by a blank line), `- ` bullets and `**bold**`; everything else is
 * literal text (raw HTML, links and headings stay as typed). stripControl runs
 * first; each renderer escapes the result for its own format.
 */
import { clean } from "./escape.js";

export interface Run {
  t: string;
  b?: true;
  c?: true;
}
export type NarrativeBlock = { kind: "p"; runs: Run[] } | { kind: "ul"; items: Run[][] };

export const MAX_NARRATIVE_CHARS = 30_000;
export const MAX_NARRATIVE_FIELD = 6_000;

/** `**bold**` runs; an unmatched `**` stays literal. */
export function inlineRuns(text: string): Run[] {
  const runs: Run[] = [];
  const re = /\*\*(.+?)\*\*/g;
  let last = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m.index > last) runs.push({ t: text.slice(last, m.index) });
    runs.push({ t: m[1]!, b: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ t: text.slice(last) });
  return runs.filter((r) => r.t.length > 0);
}

export function parseNarrative(input: string): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];
  const lines = clean(input).replace(/\r\n?/g, "\n").split("\n");
  let para: string[] = [];
  let list: Run[][] | undefined;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", runs: inlineRuns(para.join(" ").trim()) });
    para = [];
  };
  const flushList = () => {
    if (list?.length) blocks.push({ kind: "ul", items: list });
    list = undefined;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet && !/^\s*\*\*/.test(line)) {
      flushPara();
      (list ??= []).push(inlineRuns(bullet[1]!.trim()));
    } else if (line.trim() === "") {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return blocks.filter((b) => (b.kind === "p" ? b.runs.length > 0 : b.items.length > 0));
}

export interface Narrative {
  summary?: string | undefined;
  sections?: Record<string, string> | undefined;
}

/** Checks the narrative against the report's section ids and the size limits. Throws with a clear message. */
export function validateNarrative(n: Narrative | undefined, sectionIds: readonly string[]): void {
  if (!n) return;
  const fields = [n.summary ?? "", ...Object.values(n.sections ?? {})];
  for (const f of fields) if (f.length > MAX_NARRATIVE_FIELD) throw new Error(`Each narrative text is at most ${MAX_NARRATIVE_FIELD} characters.`);
  const total = fields.reduce((a, f) => a + f.length, 0);
  if (total > MAX_NARRATIVE_CHARS) throw new Error(`The narrative is ${total} characters; the limit is ${MAX_NARRATIVE_CHARS}.`);
  const unknown = Object.keys(n.sections ?? {}).filter((id) => !sectionIds.includes(id));
  if (unknown.length) throw new Error(`narrative.sections has ids that aren't sections of this report: ${unknown.join(", ")}. Sections: ${sectionIds.join(", ")}.`);
}
