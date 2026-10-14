/**
 * Search Console's Pages (Page indexing) report export, parsed locally (research
 * docs/research/2026-10-14-gsc-pages-export.md). Pure: CSV text and .xlsx sheets in, a typed summary out.
 *
 * Search Console → Indexing → Pages → Export gives a zip of CSV files (or an Excel / Google Sheets workbook with
 * the same tables as tabs): the summary page exports Chart (Date, Not indexed, Indexed, Impressions), Critical
 * issues and Non-critical issues (Reason, Source, Validation, Pages) and Metadata; a reason's drilldown exports a
 * Table (URL, Last crawled) of up to 1,000 example URLs with its own Chart and Metadata. File names vary, so tables
 * are recognised by their header row, file names only break ties.
 *
 * Every cell is untrusted: control and invisible characters are stripped, cells and rows are capped, formulas
 * are never evaluated (an .xlsx formula cell contributes only its cached value, and a leading = + - @ never
 * reaches a label), and URLs must be http(s).
 */
import { normalizeUrl } from "./findings.js";
import { stripControl } from "../lib/terminal-text.js";
import type { IssueSeverity } from "../reports/report-types.js";

/** Longest cell kept (longer ones are cut). */
export const CELL_MAX = 2_000;
/** Rows read per table (Search Console exports at most 1,000 example rows). */
export const ROWS_MAX = 5_000;
/** Columns read per row. */
export const COLS_MAX = 50;
/** Distinct reasons kept from one export (Google has about 17). */
export const REASONS_MAX = 50;
/** Tables read from one zip or workbook. */
export const TABLES_MAX = 20;
/** <row> elements looked at per worksheet, empty ones included (a hostile sheet can't make the loop run on). */
export const ROW_ELEMENTS_MAX = ROWS_MAX * 4;

export type ReasonGroup = "not_indexed" | "improve" | "indexed";

/** Google's "Why pages aren't indexed" reasons (Page indexing report help, research note), in the report's wording. */
export const NOT_INDEXED_REASONS = [
  "Server error (5xx)",
  "Redirect error",
  "URL blocked by robots.txt",
  "URL marked 'noindex'",
  "Soft 404",
  "Blocked due to unauthorized request (401)",
  "Not found (404)",
  "Blocked due to access forbidden (403)",
  "URL blocked due to other 4xx issue",
  "Crawled - currently not indexed",
  "Discovered - currently not indexed",
  "Alternate page with proper canonical tag",
  "Duplicate without user-selected canonical",
  "Duplicate, Google chose different canonical than user",
  "Page with redirect",
] as const;
/** Indexed with a problem ("Improve page experience"). */
export const IMPROVE_REASONS = ["Indexed, though blocked by robots.txt", "Page indexed without content"] as const;

const fold = (s: string) => s.toLowerCase().replace(/[\u2018\u2019\u201c\u201d"']/g, "'").replace(/[\u2013\u2014]/g, "-").replace(/\s+/g, " ").trim();
const KNOWN = new Map<string, { label: string; group: ReasonGroup }>([...NOT_INDEXED_REASONS.map((r) => [fold(r), { label: r, group: "not_indexed" as const }] as const), ...IMPROVE_REASONS.map((r) => [fold(r), { label: r, group: "improve" as const }] as const)]);

/** One cell of untrusted text: control/invisible characters stripped, whitespace collapsed, capped. */
export function cleanCell(s: string | undefined, max = CELL_MAX): string {
  return stripControl(String(s ?? "")).replace(/\s+/g, " ").trim().slice(0, max);
}

/** A label from a cell: cleaned, capped at 200, with any leading formula characters (= + - @) removed. */
export function cleanLabel(s: string | undefined): string {
  return cleanCell(s, 200).replace(/^[=+\-@\s]+/, "").trim();
}

/** Google's label for a known reason (matched loosely: case, quotes, dashes), else null. */
export function knownReason(s: string): { label: string; group: ReasonGroup } | null {
  return KNOWN.get(fold(s)) ?? null;
}

/** Severity of a Search Console reason, in line with the URL Inspection mapping (docs/audits.md). */
export function exportReasonSeverity(reason: string, group: ReasonGroup): IssueSeverity {
  const r = fold(reason);
  if (group === "improve") return "medium";
  if (r.includes("server error") || r.includes("soft 404")) return "high";
  if (r.includes("alternate page") || r === "page with redirect" || r.includes("robots.txt") || r.includes("noindex")) return "low";
  return "medium";
}

/** A table from the export: its file (or sheet) name without the extension, and its rows (the header first). */
export interface ExportTable {
  name: string;
  rows: string[][];
  truncated?: boolean;
}

/**
 * RFC 4180 CSV (quotes, doubled quotes, CRLF), linear, capped at `maxRows` rows and COLS_MAX columns; cells are
 * capped as they're read. A tab-separated file (Excel's "Unicode text") is read when the first line has tabs and
 * no commas.
 */
export function parseCsv(text: string, maxRows = ROWS_MAX + 1): { rows: string[][]; truncated: boolean } {
  const input = text.replace(/^\uFEFF/, "");
  const nl = input.search(/[\r\n]/);
  const firstLine = nl < 0 ? input : input.slice(0, nl);
  const sep = firstLine.includes("\t") && !firstLine.includes(",") ? "\t" : ",";
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  let i = 0;
  const endCell = () => {
    if (row.length < COLS_MAX) row.push(cell);
    cell = "";
  };
  const endRow = () => {
    endCell();
    if (row.some((c) => c.trim() !== "")) rows.push(row);
    row = [];
  };
  const add = (ch: string) => {
    if (cell.length < CELL_MAX * 2) cell += ch;
  };
  for (; i < input.length && rows.length < maxRows; i++) {
    const ch = input[i]!;
    if (quoted) {
      if (ch === '"') {
        if (input[i + 1] === '"') {
          add('"');
          i++;
        } else quoted = false;
      } else add(ch);
    } else if (ch === '"' && cell === "") quoted = true;
    else if (ch === sep) endCell();
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && input[i + 1] === "\n") i++;
      endRow();
    } else add(ch);
  }
  if (rows.length < maxRows && (cell !== "" || row.length)) endRow();
  return { rows, truncated: rows.length >= maxRows && input.slice(i).trim() !== "" };
}

// ------------------------------------------------------------------ .xlsx (Excel, or Google Sheets downloaded as .xlsx)

const XML_ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (s: string) =>
  s.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|amp|lt|gt|quot|apos);/gi, (_, e: string) => {
    if (e[0] === "#") {
      const cp = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : "";
    }
    return XML_ENTITIES[e.toLowerCase()] ?? "";
  });
/** Longest tag whose attributes are read (real ones are a few hundred characters). */
const TAG_MAX = 4_096;
/** workbook.xml and its relationships are small; larger ones are refused. */
export const WORKBOOK_XML_MAX = 1024 * 1024;
// Every tag pattern below uses [^<>]* (a scan stops at the next "<"), so many tag openings without a ">" stay linear.
const attr = (tag: string, name: string) => (tag.length > TAG_MAX ? undefined : new RegExp(`\\s${name}="([^"<>]*)"`).exec(tag)?.[1]);
/** The text of every <t> inside a fragment (shared strings and inline strings; rich-text runs joined). */
const texts = (frag: string) => [...frag.matchAll(/<t(?:\s[^<>]*)?>([^<]*)<\/t>/g)].map((m) => unescapeXml(m[1]!)).join("");

/** Column letters of a cell reference ("C12" → 2). */
function colIndex(ref: string | undefined, fallback: number): number {
  const letters = /^([A-Z]{1,3})/.exec(ref ?? "")?.[1];
  if (!letters) return fallback;
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

/**
 * The sheets of an .xlsx workbook (entries by name, from the zip). Reads workbook.xml for the sheet names, the
 * relationships for their files, sharedStrings.xml, and each sheet's cells: shared, inline and plain values. A
 * formula cell contributes its cached value only; nothing is evaluated. Rows and cells are capped like CSV.
 */
export function parseXlsx(entries: ReadonlyMap<string, string>): ExportTable[] {
  const workbook = entries.get("xl/workbook.xml");
  if (!workbook) throw new Error("Not an Excel workbook (no xl/workbook.xml).");
  const rels = entries.get("xl/_rels/workbook.xml.rels") ?? "";
  if (workbook.length > WORKBOOK_XML_MAX || rels.length > WORKBOOK_XML_MAX) throw new Error("The workbook's sheet list is larger than 1 MB; refused.");
  const target = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\s[^<>]*>/g)) {
    const id = attr(m[0], "Id");
    const t = attr(m[0], "Target");
    if (id && t) target.set(id, t.replace(/^\/?xl\//, "").replace(/^\//, ""));
  }
  const sst = entries.get("xl/sharedStrings.xml") ?? "";
  const shared: string[] = [];
  for (let at = sst.indexOf("<si"); at >= 0 && shared.length <= ROWS_MAX * COLS_MAX; ) {
    const end = sst.indexOf("</si>", at);
    if (end < 0) break;
    shared.push(texts(sst.slice(at, end)).slice(0, CELL_MAX * 2));
    at = sst.indexOf("<si", end);
  }
  const out: ExportTable[] = [];
  // Each worksheet file is parsed once, and at most TABLES_MAX of them: thousands of <sheet> tags pointing at
  // one worksheet must not parse it thousands of times.
  const parsedFiles = new Set<string>();
  for (const m of workbook.matchAll(/<sheet\s[^<>]*>/g)) {
    if (out.length >= TABLES_MAX) break;
    const name = cleanCell(unescapeXml(attr(m[0], "name") ?? ""), 100);
    const rid = attr(m[0], "r:id");
    const file = rid ? target.get(rid) : undefined;
    const xml = file && !parsedFiles.has(file) ? entries.get(`xl/${file}`) : undefined;
    if (!xml || !file) continue;
    parsedFiles.add(file);
    const rows: string[][] = [];
    let truncated = false;
    let elements = 0;
    // indexOf scanning, not regex over the whole sheet: linear even on a hostile file.
    for (let at = xml.indexOf("<row"); at >= 0; ) {
      const open = xml.indexOf(">", at);
      if (open < 0) break;
      const selfClosing = xml[open - 1] === "/";
      const close = selfClosing ? open : xml.indexOf("</row>", open);
      if (close < 0) break;
      if (rows.length > ROWS_MAX || ++elements > ROW_ELEMENTS_MAX) {
        truncated = true;
        break;
      }
      const body = selfClosing ? "" : xml.slice(open + 1, close);
      at = xml.indexOf("<row", close);
      const row: string[] = [];
      let i = 0;
      for (let c = body.indexOf("<c"); c >= 0; ) {
        const tagEnd = body.indexOf(">", c);
        if (tagEnd < 0) break;
        const tag = body.slice(c + 2, tagEnd);
        if (tag && !/^[\s/]/.test(tag)) {
          // another element starting with "c" (none in SpreadsheetML rows, but don't misread one)
          c = body.indexOf("<c", tagEnd);
          continue;
        }
        const empty = body[tagEnd - 1] === "/";
        const cEnd = empty ? tagEnd : body.indexOf("</c>", tagEnd);
        if (cEnd < 0) break;
        const inner = empty ? "" : body.slice(tagEnd + 1, cEnd);
        c = body.indexOf("<c", cEnd);
        const col = colIndex(attr(tag, "r"), i);
        i = col + 1;
        if (col >= COLS_MAX) continue;
        const type = attr(tag, "t");
        const v = /<v>([^<]*)<\/v>/.exec(inner)?.[1];
        let value = "";
        if (type === "s") value = shared[Number(v)] ?? "";
        else if (type === "inlineStr") value = texts(inner);
        else if (v !== undefined) value = unescapeXml(v);
        while (row.length < col) row.push("");
        row[col] = value.slice(0, CELL_MAX * 2);
      }
      if (row.some((x) => x.trim() !== "")) rows.push(row);
    }
    out.push({ name, rows, truncated });
  }
  return out;
}

// ------------------------------------------------------------------ interpretation

export interface ParsedPagesExport {
  kind: "summary" | "drilldown";
  /** YYYY-MM-DD, from the file name, else the metadata, else the chart's last day; null when none says. */
  exportedOn: string | null;
  exportedOnFrom: "file name" | "metadata" | "chart" | null;
  /** A host named by the file name or the metadata, to check the export belongs to the client. */
  hostHint: string | null;
  /** The chart's last day: pages indexed and not indexed. */
  totals: { date: string; indexed: number | null; notIndexed: number | null } | null;
  reasons: { reason: string; group: ReasonGroup; source: string | null; validation: string | null; pages: number }[];
  /** rows: unique URLs kept (in scope); outside: URLs left out by `inScope`. */
  drilldown: { reason: string; group: ReasonGroup; urls: { url: string; lastCrawled: string | null }[]; rows: number; outside: number } | null;
  notes: string[];
}

const norm = (h: string) => cleanCell(h, 100).toLowerCase().replace(/[^a-z0-9]+/g, "");
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const iso = (y: number, m: number, d: number) => {
  const t = Date.UTC(y, m - 1, d);
  const dt = new Date(t);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d && y >= 2000 && y <= 2100 ? dt.toISOString().slice(0, 10) : null;
};

/** A date cell: ISO (2026-10-01), "1 Oct 2026", "Oct 1, 2026", or an Excel serial number; else null. */
export function parseDay(raw: string): string | null {
  const s = cleanCell(raw, 60);
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (m) return iso(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})\s+([A-Za-z]{3})[A-Za-z]*\.?,?\s+(\d{4})$/.exec(s);
  if (m) return MONTHS.indexOf(m[2]!.toLowerCase()) >= 0 ? iso(+m[3]!, MONTHS.indexOf(m[2]!.toLowerCase()) + 1, +m[1]!) : null;
  m = /^([A-Za-z]{3})[A-Za-z]*\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s);
  if (m) return MONTHS.indexOf(m[1]!.toLowerCase()) >= 0 ? iso(+m[3]!, MONTHS.indexOf(m[1]!.toLowerCase()) + 1, +m[2]!) : null;
  // Excel's 1900 date system (serial 25569 is 1970-01-01); a plausible range only.
  if (/^\d{5}(\.\d+)?$/.test(s)) {
    const n = Math.floor(Number(s));
    if (n > 36_000 && n < 75_000) return new Date((n - 25_569) * 86_400_000).toISOString().slice(0, 10);
  }
  return null;
}

/** A count cell: "1,234" → 1234; "~" and "-" (Search Console's "not available") → 0; else null. */
export function parseCount(raw: string | undefined): number | null {
  const s = cleanCell(raw, 40).replace(/[,\s\u00a0]/g, "");
  if (s === "~" || s === "-" || s === "") return s === "" ? null : 0;
  return /^\d{1,12}$/.test(s) ? Number(s) : null;
}

/** A host named in a file name such as "www.example.com-Coverage-2026-10-14.zip" or "https___example.com_ Index Coverage Drilldown 2019-09-17.csv". */
export function hostFromFileName(name: string): string | null {
  // Only the part before "Coverage", and only a host at its start: "Critical issues.csv" names no host.
  const base = name.replace(/^.*[\\/]/, "").replace(/\.(zip|csv|tsv|txt|xlsx?)$/i, "");
  const head = (base.split(/[-\s_]*(?:Index\s+)?Coverage\b/i)[0] ?? base).replace(/^https?___/i, "").replace(/^sc-domain[_:]/i, "");
  const m = /^((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?:[_\s-]*)$/i.exec(head);
  return m ? m[1]!.toLowerCase() : null;
}

/** The export date in a file name ("…-2026-10-14.zip"): the last valid YYYY-MM-DD, or null. */
export function dayFromFileName(name: string): string | null {
  const all = [...name.replace(/^.*[\\/]/, "").matchAll(/(\d{4})-(\d{2})-(\d{2})/g)];
  for (const m of all.reverse()) {
    const d = iso(+m[1]!, +m[2]!, +m[3]!);
    if (d) return d;
  }
  return null;
}

function findCol(header: string[], ...names: string[]): number {
  const h = header.map(norm);
  for (const n of names) {
    const i = h.indexOf(n);
    if (i >= 0) return i;
  }
  return -1;
}

type Kind = "issues" | "urls" | "chart" | "metadata" | "unknown";
function tableKind(t: ExportTable): Kind {
  const header = t.rows[0] ?? [];
  if (findCol(header, "reason", "issue", "whypagesarentindexed") >= 0 && findCol(header, "pages", "affectedpages") >= 0) return "issues";
  if (findCol(header, "url", "pageurl", "page") >= 0) return "urls";
  if (findCol(header, "date") >= 0 && findCol(header, "indexed", "notindexed", "affectedpages", "pages") >= 0) return "chart";
  if (/metadata/i.test(t.name) || header.filter((c) => c.trim()).length === 2) return "metadata";
  return "unknown";
}

/**
 * Read the tables of one export. `fileName` is the file the user gave (the zip, workbook or CSV), for the date and
 * host; `reason` names a drilldown's reason when its metadata doesn't. Throws when it isn't a Pages export.
 */
export function interpretExport(tables: ExportTable[], fileName: string, opts: { reason?: string | undefined; examplesMax?: number; inScope?: (url: string) => boolean } = {}): ParsedPagesExport {
  const notes: string[] = [];
  const examplesMax = opts.examplesMax ?? 200;
  const kinds = tables.map((t) => ({ t, kind: tableKind(t) }));
  const meta: { key: string; value: string }[] = kinds.filter((k) => k.kind === "metadata").flatMap((k) => k.t.rows.flatMap((r) => (r.length >= 2 ? [{ key: cleanCell(r[0], 100), value: cleanCell(r.slice(1).filter(Boolean).join(" "), 300) }] : [])));
  if (kinds.some((k) => k.t.truncated)) notes.push(`A table had more than ${ROWS_MAX.toLocaleString("en-US")} rows; the rest were not read.`);

  // Totals: the chart's last row.
  let totals: ParsedPagesExport["totals"] = null;
  const chart = kinds.find((k) => k.kind === "chart")?.t;
  if (chart) {
    const h = chart.rows[0]!;
    const di = findCol(h, "date");
    const ii = findCol(h, "indexed");
    const ni = findCol(h, "notindexed");
    const last = chart.rows
      .slice(1)
      .map((r) => ({ date: parseDay(r[di] ?? ""), indexed: ii >= 0 ? parseCount(r[ii]) : null, notIndexed: ni >= 0 ? parseCount(r[ni]) : null }))
      .filter((r): r is { date: string; indexed: number | null; notIndexed: number | null } => r.date !== null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
    if (last && (ii >= 0 || ni >= 0)) totals = last;
  }

  // Reasons: Critical issues ("Why pages aren't indexed") and Non-critical issues ("Improve page experience").
  const reasons: ParsedPagesExport["reasons"] = [];
  const seen = new Set<string>();
  let extraReasons = 0;
  for (const { t } of kinds.filter((k) => k.kind === "issues")) {
    const h = t.rows[0]!;
    const ri = findCol(h, "reason", "issue", "whypagesarentindexed");
    const pi = findCol(h, "pages", "affectedpages");
    const si = findCol(h, "source");
    const vi = findCol(h, "validation");
    const byName: ReasonGroup | null = /non-?critical|improve/i.test(t.name) ? "improve" : /critical|not indexed/i.test(t.name) ? "not_indexed" : null;
    for (const r of t.rows.slice(1)) {
      const label = cleanLabel(r[ri]);
      const pages = parseCount(r[pi]);
      if (!label || pages === null) continue;
      const known = knownReason(label);
      const reason = known?.label ?? label;
      const group = known?.group ?? byName ?? "not_indexed";
      const key = `${group}\n${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (reasons.length >= REASONS_MAX) {
        extraReasons++;
        continue;
      }
      reasons.push({ reason, group, source: cleanLabel(r[si]) || null, validation: cleanLabel(r[vi]) || null, pages });
    }
  }

  if (extraReasons) notes.push(`Only the first ${REASONS_MAX} reasons were read; ${extraReasons} more were left out.`);

  // A drilldown: example URLs for one reason.
  let drilldown: ParsedPagesExport["drilldown"] = null;
  const urlTable = kinds.find((k) => k.kind === "urls")?.t;
  if (urlTable && !reasons.length) {
    const h = urlTable.rows[0]!;
    const ui = findCol(h, "url", "pageurl", "page");
    const li = findCol(h, "lastcrawled", "lastcrawl", "crawled");
    const urls: { url: string; lastCrawled: string | null }[] = [];
    const seenUrl = new Set<string>();
    let bad = 0;
    let outside = 0;
    for (const r of urlTable.rows.slice(1)) {
      const raw = cleanCell(r[ui], CELL_MAX);
      if (!/^https?:\/\/[^\s]+$/i.test(raw)) {
        bad++;
        continue;
      }
      let u: string;
      try {
        u = normalizeUrl(new URL(raw).href);
      } catch {
        bad++;
        continue;
      }
      if (seenUrl.has(u)) continue;
      if (opts.inScope && !opts.inScope(u)) {
        outside++;
        continue;
      }
      seenUrl.add(u);
      if (urls.length < examplesMax) urls.push({ url: u, lastCrawled: li >= 0 ? (parseDay(r[li] ?? "") ?? (cleanCell(r[li], 40) || null)) : null });
    }
    if (bad) notes.push(`${bad} row${bad === 1 ? "" : "s"} without an http(s) URL ${bad === 1 ? "was" : "were"} skipped.`);
    // Which reason: a metadata value naming a known reason (or the indexed pages), else the caller's `reason`.
    let reason: { label: string; group: ReasonGroup } | null = null;
    for (const { value } of meta) {
      reason = knownReason(value) ?? (/^(all )?indexed( pages)?$/i.test(value) ? { label: "Indexed", group: "indexed" } : null);
      if (reason) break;
    }
    if (!reason && opts.reason) {
      const given = cleanLabel(opts.reason);
      reason = knownReason(given) ?? (given ? { label: given, group: /^indexed$/i.test(given) ? "indexed" : "not_indexed" } : null);
    }
    if (!reason) throw new Error("This looks like a drilldown export (URL and Last crawled) but it doesn't say which reason it lists; pass the reason (for example \"Crawled - currently not indexed\").");
    drilldown = { reason: reason.label, group: reason.group, urls, rows: seenUrl.size, outside };
  }

  if (!reasons.length && !drilldown && !totals) throw new Error("This doesn't look like Search Console's Pages report export (no Reason/Pages table, no URL table and no indexed chart). Export it from Search Console → Indexing → Pages → Export.");

  // The export date: the file name (Search Console names exports with the day), the metadata, else the chart.
  let exportedOn = dayFromFileName(fileName);
  let exportedOnFrom: ParsedPagesExport["exportedOnFrom"] = exportedOn ? "file name" : null;
  if (!exportedOn) {
    for (const { key, value } of meta) {
      if (!/date|export/i.test(key)) continue;
      exportedOn = parseDay(value);
      if (exportedOn) {
        exportedOnFrom = "metadata";
        break;
      }
    }
  }
  if (!exportedOn && totals) {
    exportedOn = totals.date;
    exportedOnFrom = "chart";
  }

  let hostHint = hostFromFileName(fileName);
  if (!hostHint) {
    for (const { key, value } of meta) {
      if (!/property|site|domain/i.test(key)) continue;
      const m = /^(?:sc-domain:)?(?:https?:\/\/)?((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63})(?:[/:]|$)/i.exec(value);
      if (m) {
        hostHint = m[1]!.toLowerCase();
        break;
      }
    }
  }

  return { kind: reasons.length || !drilldown ? "summary" : "drilldown", exportedOn, exportedOnFrom, hostHint, totals, reasons, drilldown, notes };
}
