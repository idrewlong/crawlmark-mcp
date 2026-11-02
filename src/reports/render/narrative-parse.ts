/**
 * The commentary parser (D2, D4, B-C4), on its own so the template schema can check block texts without importing
 * the narrative module (tests mock that one). narrative.ts re-exports everything here.
 * A tiny Markdown subset: paragraphs (separated by a blank line), `- ` bullets, `1.` lists, `##`-`####` sub-headings,
 * pipe tables, `{{chart <sectionId>}}` lines and `**bold**`; everything else is literal text (raw HTML and links stay
 * as typed). stripControl runs first; each renderer escapes the result for its own format.
 */
import { clean } from "./escape.js";

export interface Run {
  t: string;
  b?: true;
  c?: true;
  /** A change coloured as good (green) or bad (red); renderers that can't colour show the text alone. */
  tone?: "good" | "bad";
  /** A small label pill (severity, "brand"); plain text where pills aren't available. */
  tag?: "good" | "bad" | "warn" | "neutral";
}
/** The parsed commentary. `chartRef` is resolved by `buildReportDoc` to a chart the report already draws. */
export type NarrativeBlock =
  | { kind: "p"; runs: Run[] }
  | { kind: "ul"; items: Run[][] }
  | { kind: "ol"; items: Run[][]; start: number }
  | { kind: "h"; runs: Run[] }
  | { kind: "table"; header: Run[][]; rows: Run[][][]; align: ("left" | "right")[] }
  | { kind: "chartRef"; section: string; index: number };

// Limits (B-C4): all client-facing text of one export, all internal text, and any one string.
export const MAX_NARRATIVE_CHARS = 100_000;
export const MAX_INTERNAL_CHARS = 50_000;
export const MAX_NARRATIVE_FIELD = 20_000;
export const MAX_TABLE_COLS = 12;
export const MAX_TABLE_ROWS = 200;
/** `{{chart}}` references per report (SEC-1): each one copies a whole chart into every file. Commentary, and each block, at most this many. */
export const MAX_CHART_REFS = 20;

/** The number of `{{chart}}` references in parsed commentary. */
export const chartRefCount = (blocks: readonly NarrativeBlock[]) => blocks.filter((b) => b.kind === "chartRef").length;

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

/** A commentary text that can't be parsed (a table over the limits). validateNarrative adds the field name. */
export class NarrativeParseError extends Error {
  override name = "NarrativeParseError";
}

const SEPARATOR = /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?$/;
const CHART_REF = /^\{\{chart ([A-Za-z0-9_-]{1,40})(?: ([1-9]))?\}\}$/;

/** Split a table line on pipes that aren't escaped (`\|` is a literal pipe); the outer pipes are dropped. */
function splitRow(line: string): string[] {
  const t = line.trim();
  const cells: string[] = [];
  let cur = "";
  let closedByPipe = false;
  for (let i = 0; i < t.length; i++) {
    const ch = t[i]!;
    closedByPipe = false;
    if (ch === "\\" && t[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (ch === "|") {
      cells.push(cur);
      cur = "";
      closedByPipe = true;
    } else cur += ch;
  }
  if (!closedByPipe) cells.push(cur);
  if (t.startsWith("|")) cells.shift();
  return cells.map((c) => c.trim());
}

const isPipeLine = (l: string | undefined) => l !== undefined && l.trim().length > 1 && l.trim().startsWith("|") && l.trim().endsWith("|");

export function parseNarrative(input: string): NarrativeBlock[] {
  const blocks: NarrativeBlock[] = [];
  const lines = clean(input)
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd());
  let para: string[] = [];
  let list: { kind: "ul" | "ol"; items: Run[][]; start: number } | undefined;
  const flushPara = () => {
    if (para.length) blocks.push({ kind: "p", runs: inlineRuns(para.join(" ").trim()) });
    para = [];
  };
  const flushList = () => {
    if (list?.items.length) blocks.push(list.kind === "ul" ? { kind: "ul", items: list.items } : { kind: "ol", items: list.items, start: list.start });
    list = undefined;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*(\d{1,3})[.)]\s+(.*)$/.exec(line);
    const heading = /^#{2,4}\s+(.+)$/.exec(line);
    const chart = CHART_REF.exec(line.trim());
    if (isPipeLine(line) && next !== undefined && SEPARATOR.test(next.trim())) {
      flushPara();
      flushList();
      const header = splitRow(line);
      if (header.length > MAX_TABLE_COLS) throw new NarrativeParseError(`a table has ${header.length} columns; at most ${MAX_TABLE_COLS}`);
      const seps = splitRow(next);
      const align = header.map((_, c) => (seps[c]?.endsWith(":") ? ("right" as const) : ("left" as const)));
      const rows: Run[][][] = [];
      let j = i + 2;
      for (; j < lines.length && lines[j]!.trim().startsWith("|"); j++) {
        const cells = splitRow(lines[j]!);
        if (cells.length > header.length) throw new NarrativeParseError(`a table row has ${cells.length} cells but the header has ${header.length}`);
        while (cells.length < header.length) cells.push("");
        rows.push(cells.map(inlineRuns));
      }
      if (rows.length > MAX_TABLE_ROWS) throw new NarrativeParseError(`a table has ${rows.length} rows; at most ${MAX_TABLE_ROWS}`);
      blocks.push({ kind: "table", header: header.map(inlineRuns), rows, align });
      i = j - 1;
    } else if (chart) {
      flushPara();
      flushList();
      blocks.push({ kind: "chartRef", section: chart[1]!, index: chart[2] ? Number(chart[2]) : 1 });
    } else if (heading) {
      flushPara();
      flushList();
      blocks.push({ kind: "h", runs: inlineRuns(heading[1]!.trim()) });
    } else if (bullet && !/^\s*\*\*/.test(line)) {
      flushPara();
      if (list?.kind !== "ul") {
        flushList();
        list = { kind: "ul", items: [], start: 1 };
      }
      list.items.push(inlineRuns(bullet[1]!.trim()));
    } else if (numbered) {
      flushPara();
      if (list?.kind !== "ol") {
        flushList();
        list = { kind: "ol", items: [], start: Number(numbered[1]) };
      }
      list.items.push(inlineRuns(numbered[2]!.trim()));
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
  return blocks.filter((b) => (b.kind === "p" || b.kind === "h" ? b.runs.length > 0 : b.kind === "ul" || b.kind === "ol" ? b.items.length > 0 : true));
}
