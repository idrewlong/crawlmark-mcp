/**
 * export_report and `crawlmark-cli report` (D7): render a TemplateReport to
 * Markdown, HTML, PDF and DOCX files under REPORTS_DIR, and/or return an inline
 * docs-friendly copy for the Google Docs handoff. Files are client data: 0600
 * files in 0700 directories, written atomically, never through a symlinked
 * client or month directory, never outside REPORTS_DIR. Re-running the same
 * template and period overwrites (`overwritten: true`).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, statSync, unlinkSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { RegularFileError, readRegularFileCapped } from "../lib/read-regular-file.js";
import { stripControl } from "../lib/terminal-text.js";
import { reportRelPath } from "./paths.js";
import type { TemplateReport } from "./report-types.js";
import { buildReportDoc, type DocBranding } from "./render/doc.js";
import { toDocx } from "./render/docx.js";
import { toHtml } from "./render/html.js";
import { MAX_LOGO_BYTES, sniffImage } from "./render/image.js";
import { internalNotesMarkdown } from "./render/internal-notes.js";
import { toMarkdown } from "./render/markdown.js";
import { clientText, validateNarrative, type Narrative } from "./render/narrative.js";
import { ClientTextLintError, isFixedTerm, lintClientText, type LintContext, type LintField } from "./render/term-lint.js";
import { TOOL_NAMES } from "../tools/names.js";
import { footerFont, PDF_CHROME_HINT, type PdfPrinter } from "./render/pdf.js";
import type { ResolvedBranding } from "./templates/load.js";
import type { Format } from "./templates/schema.js";

export { safeSegment, reportRelPath } from "./paths.js";

export { ClientTextLintError } from "./render/term-lint.js";

export const MAX_INLINE_CHARS = 1_000_000;

export interface ExportOptions {
  formats: Format[];
  narrative?: Narrative | undefined;
  inline?: "html" | "md" | undefined;
  reportsDir: string;
  branding: ResolvedBranding;
  version: string;
  printer: PdfPrinter;
  signal?: AbortSignal | undefined;
  /**
   * Terms allowed in client text for this export (added to branding.allowTerms). With white label on
   * (hideCrawlmark or hideProviders) they allow tool names and blockTerms only, never the built-in terms.
   */
  allowTerms?: string[] | undefined;
  /** How a term-check refusal is worded: `commentary` (default, export_report) or `template` (the `report` CLI, no narrative). */
  lintContext?: LintContext | undefined;
  /** Warnings to pass through to the result first (for example an invalid template file). */
  warnings?: string[] | undefined;
}

export interface ExportedFile {
  format: Format;
  path: string;
  bytes: number;
  overwritten: boolean;
  /** "internal" is the notes file that is never for the client; every other file is "client". */
  audience: "client" | "internal";
}

export interface ExportResult {
  client: string;
  template: string;
  period: { label: string; folderMonth: string };
  dataOnly: boolean;
  files: ExportedFile[];
  /** The internal notes as Markdown, when there are some and no file was asked for (`formats: []`). Never for the client. */
  internalNotes?: string;
  inline?: { mimeType: "text/html" | "text/markdown"; title: string; content: string };
  sectionErrors: { id: string; error: string }[];
  /** Paid data this report's run used (operator-only: never rendered into the files). Present when anything was spent. */
  spend?: TemplateReport["spend"];
  warnings: string[];
}

/** A report file couldn't be written (permissions, a symlink, a path outside REPORTS_DIR). Fatal for the CLI (exit 1). */
export class ReportWriteError extends Error {
  override name = "ReportWriteError";
}

/** Every requested format failed to render. */
export class ReportRenderError extends Error {
  override name = "ReportRenderError";
}

const inside = (root: string, p: string) => p.startsWith(root.endsWith(sep) ? root : root + sep);

/** A directory under `root` that is ours to write in: created 0700, or an existing real directory (never a symlink). */
function ensureDir(root: string, dir: string): void {
  const abs = resolve(dir);
  if (!inside(root, abs)) throw new ReportWriteError(`Refusing to write outside ${root}: ${abs}`);
  if (existsSync(abs) || isDanglingLink(abs)) {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) throw new ReportWriteError(`Refusing to write through a symlink: ${abs}`);
    if (!st.isDirectory()) throw new ReportWriteError(`${abs} exists and isn't a directory.`);
    return;
  }
  mkdirSync(abs, { mode: 0o700 });
  chmodSync(abs, 0o700);
}

function isDanglingLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Where one format of a report goes. Pure apart from nothing: the checks happen in writeReportFile. */
export function reportFilePath(reportsDir: string, report: Pick<TemplateReport, "client" | "template" | "period">, format: Format, variant?: "internal"): string {
  const rel = reportRelPath(report.client.slug, report.period.folderMonth, report.template.id, report.period.current, format, variant);
  return join(resolve(reportsDir), rel.clientDir, rel.monthDir, rel.file);
}

/** Write one report file (0600) under REPORTS_DIR/<client>/<YYYY-MM>/ with the D7 checks. */
export function writeReportFile(reportsDir: string, report: Pick<TemplateReport, "client" | "template" | "period">, format: Format, data: string | Buffer, variant?: "internal"): ExportedFile {
  const root = resolve(reportsDir);
  const rel = reportRelPath(report.client.slug, report.period.folderMonth, report.template.id, report.period.current, format, variant);
  const clientDir = join(root, rel.clientDir);
  const monthDir = join(clientDir, rel.monthDir);
  const path = join(monthDir, rel.file);
  if (!inside(root, resolve(path))) throw new ReportWriteError(`Refusing to write outside ${root}: ${path}`);
  try {
    if (!existsSync(root)) {
      mkdirSync(root, { recursive: true, mode: 0o700 });
      chmodSync(root, 0o700);
    }
    ensureDir(root, clientDir);
    ensureDir(root, monthDir);
    let overwritten = false;
    if (existsSync(path) || isDanglingLink(path)) {
      const st = lstatSync(path);
      if (!st.isFile()) throw new ReportWriteError(`Refusing to replace ${path}: it isn't a regular file.`);
      overwritten = true;
    }
    writeFileAtomic(path, data, 0o600);
    return { format, path, bytes: statSync(path).size, overwritten, audience: variant === "internal" ? "internal" : "client" };
  } catch (err) {
    if (err instanceof ReportWriteError) throw err;
    throw new ReportWriteError(`Couldn't write ${path}: ${(err as Error).message}`);
  }
}

/**
 * Delete the internal notes file of this report and period when it exists (a later export without notes), with the
 * same checks as a write: inside REPORTS_DIR, no symlinked client or month directory, and only a regular file.
 * Returns the removed path, or undefined when there was nothing to remove.
 */
export function removeStaleInternalNotes(reportsDir: string, report: Pick<TemplateReport, "client" | "template" | "period">): string | undefined {
  const root = resolve(reportsDir);
  const rel = reportRelPath(report.client.slug, report.period.folderMonth, report.template.id, report.period.current, "md", "internal");
  const clientDir = join(root, rel.clientDir);
  const monthDir = join(clientDir, rel.monthDir);
  const path = join(monthDir, rel.file);
  if (!inside(root, resolve(path))) throw new ReportWriteError(`Refusing to touch a file outside ${root}: ${path}`);
  for (const dir of [clientDir, monthDir]) {
    const st = lstatSync(dir, { throwIfNoEntry: false });
    if (!st) return undefined;
    if (st.isSymbolicLink()) throw new ReportWriteError(`Refusing to write through a symlink: ${dir}`);
    if (!st.isDirectory()) return undefined;
  }
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st) return undefined;
  if (!st.isFile()) throw new ReportWriteError(`Refusing to remove ${path}: it isn't a regular file.`);
  try {
    unlinkSync(path);
  } catch (err) {
    throw new ReportWriteError(`Couldn't remove ${path}: ${(err as Error).message}`);
  }
  return path;
}

/** The branding logo as checked bytes (PNG or JPEG, at most 512 KB), or a warning. */
export function loadLogo(branding: ResolvedBranding): { logo?: DocBranding["logo"]; warning?: string } {
  const l = branding.logo;
  if (!l) return {};
  try {
    if (!existsSync(l.resolved)) return { warning: `Logo ${l.path} doesn't exist; rendered without it.` };
    // One handle: no symlink, regular file, size checked before and after the read.
    let data: Buffer;
    try {
      data = readRegularFileCapped(l.resolved, MAX_LOGO_BYTES);
    } catch (err) {
      if (err instanceof RegularFileError) {
        return { warning: err.reason === "not-regular" ? `Logo ${l.path} isn't a file; rendered without it.` : `Logo ${l.path} is larger than 512 KB; rendered without it.` };
      }
      throw err;
    }
    const mime = sniffImage(data);
    if (!mime) return { warning: `Logo ${l.path} isn't a PNG or JPEG; rendered without it.` };
    return { logo: { mime, data } };
  } catch (err) {
    return { warning: `Logo ${l.path} couldn't be read (${(err as Error).message}); rendered without it.` };
  }
}

/**
 * Every client-facing text of this export: the commentary, the template and section titles (a block section's title
 * is its block's title), the block and text sections shown, the cover and the branding lines.
 */
export function clientTextFields(report: TemplateReport, narrative: Narrative | undefined, branding: ResolvedBranding): LintField[] {
  const fields: LintField[] = [];
  const push = (where: string, text: string | undefined) => {
    if (text) fields.push({ where, text });
  };
  push("template.title", report.template.title);
  for (const s of report.sections) push(`sections.${s.id}.title`, s.title);
  push("summary", clientText(narrative?.summary));
  for (const s of report.sections) push(`sections.${s.id}`, clientText(narrative?.sections?.[s.id]));
  for (const s of report.sections) {
    if (s.status !== "ok") continue;
    const text = (s.data as { text?: unknown } | undefined)?.text;
    if (typeof text !== "string") continue;
    if (s.type === "block") push(`blocks.${(s.data as { blockId?: string }).blockId ?? s.id}`, text);
    else if (s.type === "text") push(`sections.${s.id}.text`, text);
  }
  const cover = report.template.cover;
  push("cover.subtitle", cover?.subtitle);
  push("cover.preparedFor", cover?.preparedFor);
  push("cover.preparedBy", cover?.preparedBy);
  push("branding.footer", branding.footer);
  push("branding.commentaryNote", branding.commentaryNote);
  return fields;
}

const message = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err));

export async function exportReport(report: TemplateReport, opts: ExportOptions): Promise<ExportResult> {
  validateNarrative(opts.narrative, report.sections.map((s) => s.id));
  if (!opts.formats.length && !opts.inline) throw new Error("Nothing to do: give at least one format, or inline.");
  // Client text must not name crawlmark, Claude, vendors, tools or credentials. Refuse before anything is rendered or written.
  // White label (SEC-2): an export's own allowTerms can't allow the built-in terms; only the branding's can.
  const whiteLabel = opts.branding.hideCrawlmark === true || opts.branding.hideProviders === true;
  const hits = lintClientText(clientTextFields(report, opts.narrative, opts.branding), {
    toolNames: TOOL_NAMES,
    allowTerms: opts.branding.allowTerms,
    exportAllowTerms: opts.allowTerms,
    whiteLabel,
    blockTerms: opts.branding.blockTerms,
  });
  if (hits.length) throw new ClientTextLintError(hits, { context: opts.lintContext, whiteLabel });
  const warnings: string[] = [...new Set([...(opts.warnings ?? []), ...(report.warnings ?? [])])];
  if (opts.allowTerms?.length) {
    const ignored = whiteLabel ? opts.allowTerms.filter(isFixedTerm) : [];
    const applied = opts.allowTerms.filter((t) => !ignored.includes(t));
    if (applied.length) warnings.push(`allowTerms for this export: ${applied.join(", ")}.`);
    if (ignored.length) warnings.push(`allowTerms not applied (white label is on, so only the branding's allowTerms can allow built-in terms): ${ignored.join(", ")}.`);
  }
  const { logo, warning } = loadLogo(opts.branding);
  if (warning) warnings.push(warning);
  const doc = buildReportDoc(report, { narrative: opts.narrative, branding: opts.branding, logo, version: opts.version });
  // Operator-only problems found while building the document (for example a chart reference with no chart).
  for (const w of doc.warnings) if (!warnings.includes(w)) warnings.push(w);

  const files: ExportedFile[] = [];
  const failed: string[] = [];
  for (const format of [...new Set(opts.formats)]) {
    let data: string | Buffer;
    try {
      if (format === "md") data = toMarkdown(doc);
      else if (format === "html") data = toHtml(doc);
      else if (format === "docx") data = await toDocx(doc);
      else data = await opts.printer(toHtml(doc), { paper: doc.branding.paper, footer: doc.footer, fontFamily: footerFont(doc.branding.fonts), signal: opts.signal });
    } catch (err) {
      failed.push(format);
      warnings.push(`${format.toUpperCase()} not written: ${message(err)}${format === "pdf" ? ` ${PDF_CHROME_HINT}` : ""}`);
      continue;
    }
    files.push(writeReportFile(opts.reportsDir, report, format, data));
  }
  // Internal notes: their own file (never rendered into a client file), or returned when no file is written.
  const notes = internalNotesMarkdown(report, opts.narrative);
  let internalNotes: string | undefined;
  if (notes) {
    if (opts.formats.length) files.push(writeReportFile(opts.reportsDir, report, "md", notes, "internal"));
    else internalNotes = notes;
  } else if (opts.formats.length) {
    // An earlier export of this period may have left internal notes that no longer belong to these files.
    const removed = removeStaleInternalNotes(opts.reportsDir, report);
    if (removed) warnings.push(`Removed the internal notes file from an earlier export of this period (this export has none): ${removed}`);
  }
  // No PDF (usually no Chrome) and no HTML asked for: write the HTML the PDF would have been printed from, so
  // there is still a file to open. The warning is in the result, never in the file.
  if (failed.includes("pdf") && !opts.formats.includes("html")) {
    files.push(writeReportFile(opts.reportsDir, report, "html", toHtml(doc)));
    failed.splice(failed.indexOf("pdf"), 1);
    warnings.push("Wrote HTML instead of the PDF; open it in a browser, or print it to PDF from there.");
  }
  if (opts.formats.length && failed.length === new Set(opts.formats).size && !opts.inline) {
    throw new ReportRenderError(`No report file was written. ${warnings.join(" ")}`);
  }

  let inline: ExportResult["inline"];
  if (opts.inline) {
    const content = opts.inline === "html" ? toHtml(doc, { variant: "docs" }) : toMarkdown(doc);
    if (content.length > MAX_INLINE_CHARS) {
      throw new Error(`The inline ${opts.inline} is ${content.length.toLocaleString("en-US")} characters (limit ${MAX_INLINE_CHARS.toLocaleString("en-US")}). Use inline: "md", or fewer sections or rows.`);
    }
    inline = { mimeType: opts.inline === "html" ? "text/html" : "text/markdown", title: doc.meta.title, content };
  }

  return {
    client: report.client.slug,
    template: report.template.id,
    period: { label: report.period.label, folderMonth: report.period.folderMonth },
    dataOnly: doc.meta.dataOnly,
    files,
    ...(internalNotes ? { internalNotes } : {}),
    ...(inline ? { inline } : {}),
    sectionErrors: report.sections.flatMap((s) => (s.status === "error" ? [{ id: s.id, error: s.error }] : [])),
    ...(report.spend.usd > 0 || report.spend.units.ahrefs > 0 || report.spend.units.semrush > 0 ? { spend: report.spend } : {}),
    warnings,
  };
}
