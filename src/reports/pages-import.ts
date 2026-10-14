/**
 * Import Search Console's Pages report export (import_index_report, `crawlmark-cli index-coverage import`), and
 * the merged view index_coverage and the indexing_issues section show. Local only: the file is read from disk
 * and parsed here; nothing is sent anywhere.
 *
 * The file is untrusted. It's opened once through openLogFile (a regular file, the same file that was resolved,
 * no symlink swapped in for MCP paths), refused above IMPORT_MAX_BYTES, unzipped in memory within caps, parsed
 * with cell, row and column caps, and only cleaned values are stored (analysis/gsc-pages-export.ts).
 */
import { basename } from "node:path";
import type { Client } from "../config.js";
import { cleanCell, exportReasonSeverity, interpretExport, knownReason, parseCsv, parseXlsx, REASONS_MAX, TABLES_MAX, type ExportTable, type ParsedPagesExport } from "../analysis/gsc-pages-export.js";
import { inProperty } from "../analysis/indexing.js";
import { openLogFile, type ResolvedLogFile } from "../lib/log-files.js";
import { latestDrilldowns, latestSummary, saveDrilldown, saveSummary } from "../lib/pages-exports.js";
import type { StoredInspection } from "../lib/inspections.js";
import { looksLikeZip, readZip } from "../lib/zip-read.js";
import type { PagesReportData } from "./report-types.js";

/** Larger files are refused (Search Console's export is a few hundred KB at most). */
export const IMPORT_MAX_BYTES = 25 * 1024 * 1024;
/** Example URLs stored per drilldown. */
export const EXAMPLES_MAX = 200;
/** Example URLs shown per reason. */
export const EXAMPLES_SHOWN = 10;
const DAY_MS = 86_400_000;

export class ImportError extends Error {
  override name = "ImportError";
}

export interface ImportResult {
  client: string;
  property: string;
  kind: "summary" | "drilldown";
  file: string;
  exportedOn: string;
  exportedOnFrom: "file name" | "metadata" | "chart" | "import day";
  /** Summary: Google's totals on the chart's last day. */
  indexed?: number | null;
  notIndexed?: number | null;
  /** Summary: reasons stored (not indexed and "improve"). */
  reasons?: { reason: string; group: string; pages: number }[];
  /** Drilldown: the reason, URLs stored and URLs in the property. */
  reason?: string;
  examplesStored?: number;
  urlsInProperty?: number;
  notes: string[];
}

/** The host a property covers: the domain of `sc-domain:`, else the URL prefix's host. */
function propertyHost(property: string): string | null {
  if (property.startsWith("sc-domain:")) return property.slice("sc-domain:".length).toLowerCase().replace(/\.$/, "") || null;
  try {
    return new URL(property).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** Whether a host named by the export belongs to the client's property (www. and subdomains either way). */
export function hostMatches(host: string, property: string): boolean {
  const p = propertyHost(property);
  if (!p) return false;
  const strip = (h: string) => h.replace(/^www\./, "");
  const a = strip(host.toLowerCase());
  const b = strip(p);
  return a === b || a.endsWith(`.${b}`) || (property.startsWith("sc-domain:") ? false : b.endsWith(`.${a}`));
}

const XLSX_PART = /^xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/[^/]+\.xml)$/i;

/** Read the file (once, within IMPORT_MAX_BYTES) and turn it into tables: a zip of CSVs, an .xlsx workbook or one CSV. */
export async function readExportTables(file: ResolvedLogFile): Promise<ExportTable[]> {
  const fh = await openLogFile(file);
  let buf: Buffer;
  try {
    const size = (await fh.stat()).size;
    if (size > IMPORT_MAX_BYTES) throw new ImportError(`${file.name} is ${Math.ceil(size / 1024 / 1024)} MB; exports larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB are refused.`);
    // Read at most the cap plus one byte, whatever the size said (the file may grow after the stat).
    buf = Buffer.alloc(Math.min(size, IMPORT_MAX_BYTES) + 1);
    let read = 0;
    for (;;) {
      const { bytesRead } = await fh.read(buf, read, buf.length - read, read);
      if (bytesRead === 0) break;
      read += bytesRead;
      if (read >= buf.length) break;
    }
    if (read > IMPORT_MAX_BYTES) throw new ImportError(`${file.name} is larger than ${IMPORT_MAX_BYTES / 1024 / 1024} MB; refused.`);
    buf = buf.subarray(0, read);
  } finally {
    await fh.close();
  }
  if (!buf.length) throw new ImportError(`${file.name} is empty.`);
  const name = basename(file.name);

  if (looksLikeZip(buf)) {
    let entries: { name: string; data: Buffer }[];
    try {
      entries = readZip(buf, (n) => !n.startsWith("__MACOSX/") && (/\.csv$/i.test(n) || XLSX_PART.test(n)));
    } catch (err) {
      throw new ImportError(`${name}: ${(err as Error).message}`);
    }
    if (entries.some((e) => e.name.toLowerCase() === "xl/workbook.xml")) {
      try {
        return parseXlsx(new Map(entries.map((e) => [e.name, e.data.toString("utf8")]))).slice(0, TABLES_MAX);
      } catch (err) {
        throw new ImportError(`${name}: ${(err as Error).message}`);
      }
    }
    const csvs = entries.filter((e) => /\.csv$/i.test(e.name));
    if (!csvs.length) throw new ImportError(`${name} has no CSV files. Export Search Console's Pages report as CSV (a zip of CSV files) or Excel.`);
    return csvs.slice(0, TABLES_MAX).map((e) => ({ name: cleanCell(basename(e.name).replace(/\.csv$/i, ""), 100), ...parseCsv(decodeText(e.data)) }));
  }
  if (/\.xlsx?$/i.test(name)) throw new ImportError(`${name} isn't a readable .xlsx workbook (an old .xls can't be read). Export the report as CSV or Excel (.xlsx) from Search Console.`);
  const text = decodeText(buf);
  if (text.includes("\u0000")) throw new ImportError(`${name} isn't a CSV file (it contains binary data).`);
  return [{ name: cleanCell(name.replace(/\.(csv|txt|tsv)$/i, ""), 100), ...parseCsv(text) }];
}

/** UTF-16 (with a byte-order mark) or UTF-8. */
function decodeText(b: Buffer): string {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return b.subarray(2).toString("utf16le");
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) {
    const swapped = Buffer.from(b.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  return b.toString("utf8");
}

/**
 * Parse and store one export for a client: checks it's for the client's Search Console property (the host in the
 * file name or metadata, and every drilldown URL), then stores the per-reason counts (summary) or the example URLs
 * (drilldown) with the export date. Importing the same export again replaces it.
 */
export async function importPagesExport(client: Client, file: ResolvedLogFile, opts: { reason?: string | undefined; confirmProperty?: boolean | undefined; now: number }): Promise<ImportResult> {
  const property = client.gscProperty;
  if (!property) throw new ImportError(`No Search Console property for ${client.domain}, so an export can't be matched to it. Add gscProperty in clients.yaml (or let discovery find it).`);
  const tables = await readExportTables(file);
  let parsed: ParsedPagesExport;
  try {
    parsed = interpretExport(tables, file.name, { reason: opts.reason, examplesMax: EXAMPLES_MAX, inScope: (u) => inProperty(u, property) });
  } catch (err) {
    throw new ImportError((err as Error).message);
  }
  if (parsed.hostHint && !hostMatches(parsed.hostHint, property)) {
    throw new ImportError(`This export is for ${parsed.hostHint}, not ${client.domain} (Search Console property ${property}). Import it for the right client.`);
  }
  // A summary has no URLs to check, so without a host in its name or metadata it could be any site's (SEC-3).
  if (parsed.kind === "summary" && !parsed.hostHint && !opts.confirmProperty) {
    throw new ImportError(
      `This export doesn't name its site (no host in the file name or its metadata), so it can't be checked against ${client.domain} (Search Console property ${property}). ` +
        `Keep Search Console's file name (it starts with the site, e.g. ${client.domain}-Coverage-2026-10-14.zip), or, only after the user confirms it's ${client.domain}'s export, use --confirm-property (confirmProperty: true). Ask the user first; don't set it on your own.`,
    );
  }
  const notes = [...parsed.notes];
  if (parsed.kind === "summary" && !parsed.hostHint) notes.push(`The export doesn't name its site; stored for ${client.domain} as the user confirmed.`);
  const today = new Date(opts.now).toISOString().slice(0, 10);
  let exportedOn = parsed.exportedOn;
  let exportedOnFrom: ImportResult["exportedOnFrom"] = parsed.exportedOnFrom ?? "import day";
  if (exportedOn && exportedOn > new Date(opts.now + DAY_MS).toISOString().slice(0, 10)) {
    notes.push(`The export date ${exportedOn} is in the future; today's date was used.`);
    exportedOn = null;
  }
  if (!exportedOn) {
    exportedOn = today;
    exportedOnFrom = "import day";
    notes.push("The export date wasn't in the file name or the file, so today's date was used. Keep Search Console's file name (it ends with the export date).");
  }
  const sourceName = cleanCell(basename(file.name), 200);
  const base = { client: client.slug, property, file: sourceName, exportedOn, exportedOnFrom };

  if (parsed.kind === "drilldown" && parsed.drilldown) {
    const dd = parsed.drilldown;
    if (!dd.rows && dd.outside) throw new ImportError(`None of the ${dd.outside} URLs in this export are in ${property}; it looks like another site's export.`);
    if (dd.outside) notes.push(`${dd.outside} URL${dd.outside === 1 ? "" : "s"} outside ${property} ${dd.outside === 1 ? "was" : "were"} left out.`);
    if (dd.rows > dd.urls.length) notes.push(`The first ${dd.urls.length} of ${dd.rows} URLs were stored as examples.`);
    saveDrilldown({ client: client.slug, property, reason: dd.reason, exportedOn, importedAt: opts.now, sourceName, data: { group: dd.group, rows: dd.rows, urls: dd.urls } });
    return { ...base, kind: "drilldown", reason: dd.reason, examplesStored: dd.urls.length, urlsInProperty: dd.rows, notes };
  }
  saveSummary({ client: client.slug, property, exportedOn, importedAt: opts.now, sourceName, data: { totals: parsed.totals, reasons: parsed.reasons } });
  if (!parsed.reasons.length) notes.push("No reasons table was found (only the chart); export from the Pages report's main page to get the reasons.");
  return {
    ...base,
    kind: "summary",
    indexed: parsed.totals?.indexed ?? null,
    notIndexed: parsed.totals?.notIndexed ?? null,
    reasons: parsed.reasons.map((r) => ({ reason: r.reason, group: r.group, pages: r.pages })),
    notes,
  };
}

const sameReason = (a: string, b: string) => (knownReason(a)?.label ?? a).toLowerCase() === (knownReason(b)?.label ?? b).toLowerCase();
const SEVERITIES = ["critical", "high", "medium", "low"] as const;

/**
 * The imported Pages report for index_coverage and the section, merged with URL Inspection: the newest summary's
 * counts per reason (complete per reason, as of its export date), each reason's newest drilldown examples, and for
 * each example inspected after that drilldown's export date whether Google indexes it now. Undefined when nothing
 * was imported.
 */
export function pagesReportFor(client: string, property: string, latest: readonly StoredInspection[]): PagesReportData | undefined {
  const summary = latestSummary(client, property);
  const drills = latestDrilldowns(client, property).filter((d) => d.data.group !== "indexed");
  if (!summary && !drills.length) return undefined;
  const byUrl = new Map(latest.map((i) => [i.url, i]));
  const reasons: PagesReportData["reasons"] = (summary?.data.reasons ?? [])
    .filter((r) => r.group !== "indexed")
    .map((r) => ({ reason: r.reason, group: r.group as "not_indexed" | "improve", severity: exportReasonSeverity(r.reason, r.group), pages: r.pages, source: r.source, validation: r.validation, examples: [], examplesTotal: null, examplesExportedOn: null, indexedSince: 0 }));
  for (const d of drills) {
    let row = reasons.find((r) => sameReason(r.reason, d.reason));
    // A reason the newest summary doesn't list was fixed or dropped since an older drilldown: don't bring it back.
    // Only a drilldown exported after the summary (or with no summary at all) adds a reason of its own.
    if (!row && summary && d.exportedOn <= summary.exportedOn) continue;
    if (!row) {
      const group = d.data.group === "improve" ? "improve" : "not_indexed";
      row = { reason: d.reason, group, severity: exportReasonSeverity(d.reason, group), pages: null, source: null, validation: null, examples: [], examplesTotal: null, examplesExportedOn: null, indexedSince: 0 };
      reasons.push(row);
    }
    // Inspected after the export day: fresher than the export for that URL.
    const after = Date.parse(`${d.exportedOn}T00:00:00Z`) + DAY_MS;
    const merged = d.data.urls.map((u) => {
      const i = byUrl.get(u.url);
      const fresh = i && i.inspectedAt >= after ? i : undefined;
      return { url: u.url, lastCrawled: u.lastCrawled, inspectedAt: fresh ? new Date(fresh.inspectedAt).toISOString() : null, indexedNow: fresh ? fresh.verdict === "PASS" : null };
    });
    row.indexedSince = merged.filter((m) => m.indexedNow === true).length;
    // Still-unindexed (or unchecked) examples first; ones Google indexes now last.
    row.examples = [...merged].sort((a, b) => Number(a.indexedNow === true) - Number(b.indexedNow === true)).slice(0, EXAMPLES_SHOWN);
    row.examplesTotal = d.data.rows;
    row.examplesExportedOn = d.exportedOn;
  }
  reasons.sort((a, b) => (a.group === b.group ? 0 : a.group === "not_indexed" ? -1 : 1) || SEVERITIES.indexOf(a.severity) - SEVERITIES.indexOf(b.severity) || (b.pages ?? -1) - (a.pages ?? -1) || a.reason.localeCompare(b.reason));
  // Drilldowns imported over time can each add a reason: keep the merged list as short as one export's.
  reasons.splice(REASONS_MAX);
  return {
    exportedOn: summary?.exportedOn ?? null,
    importedAt: new Date(Math.max(summary?.importedAt ?? 0, ...drills.map((d) => d.importedAt))).toISOString(),
    indexed: summary?.data.totals?.indexed ?? null,
    notIndexed: summary?.data.totals?.notIndexed ?? (summary ? summary.data.reasons.filter((r) => r.group === "not_indexed").reduce((a, r) => a + r.pages, 0) : null),
    reasons,
  };
}

/** One line for index_coverage: "From Search Console's Pages report exported on 2026-10-14: 1,234 not indexed, by reason: …". */
export function pagesReportText(p: PagesReportData, now: number): string {
  const n = (x: number) => x.toLocaleString("en-US");
  const top = p.reasons.filter((r) => r.group === "not_indexed" && r.pages !== null).slice(0, 6);
  const parts = [
    p.exportedOn ? `From Search Console's Pages report exported on ${p.exportedOn}` : "From imported Search Console Pages report drilldowns",
    p.notIndexed !== null ? `: ${n(p.notIndexed)} not indexed${p.indexed !== null ? ` and ${n(p.indexed)} indexed` : ""}` : "",
    top.length ? `, by reason: ${top.map((r) => `${r.reason} ${n(r.pages!)}`).join("; ")}` : "",
    ".",
  ];
  const age = p.exportedOn ? Math.floor((now - Date.parse(`${p.exportedOn}T00:00:00Z`)) / DAY_MS) : 0;
  const since = p.reasons.reduce((a, r) => a + r.indexedSince, 0);
  return parts.join("") + (since ? ` ${n(since)} example URL${since === 1 ? "" : "s"} were indexed when URL Inspection checked them after the export.` : "") + (age > 45 ? ` The export is ${n(age)} days old; export it again for current counts.` : "");
}
