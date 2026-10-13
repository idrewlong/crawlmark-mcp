/**
 * export_report and `crawlmark-cli report` (D7): render a TemplateReport to
 * Markdown, HTML, PDF and DOCX files under REPORTS_DIR, and/or return an inline
 * docs-friendly copy for the Google Docs handoff. Files are client data: 0600
 * files in 0700 directories, written atomically, never through a symlinked
 * client or month directory, never outside REPORTS_DIR. Re-running the same
 * template and period overwrites (`overwritten: true`).
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { stripControl } from "../lib/terminal-text.js";
import { reportRelPath } from "./paths.js";
import type { TemplateReport } from "./report-types.js";
import { buildReportDoc, type DocBranding } from "./render/doc.js";
import { toDocx } from "./render/docx.js";
import { toHtml } from "./render/html.js";
import { MAX_LOGO_BYTES, sniffImage } from "./render/image.js";
import { toMarkdown } from "./render/markdown.js";
import { validateNarrative, type Narrative } from "./render/narrative.js";
import { PDF_CHROME_HINT, type PdfPrinter } from "./render/pdf.js";
import type { ResolvedBranding } from "./templates/load.js";
import type { Format } from "./templates/schema.js";

export { safeSegment, reportRelPath } from "./paths.js";

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
  /** Warnings to pass through to the result first (for example an invalid template file). */
  warnings?: string[] | undefined;
}

export interface ExportedFile {
  format: Format;
  path: string;
  bytes: number;
  overwritten: boolean;
}

export interface ExportResult {
  client: string;
  template: string;
  period: { label: string; folderMonth: string };
  dataOnly: boolean;
  files: ExportedFile[];
  inline?: { mimeType: "text/html" | "text/markdown"; title: string; content: string };
  sectionErrors: { id: string; error: string }[];
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
export function reportFilePath(reportsDir: string, report: Pick<TemplateReport, "client" | "template" | "period">, format: Format): string {
  const rel = reportRelPath(report.client.slug, report.period.folderMonth, report.template.id, report.period.current, format);
  return join(resolve(reportsDir), rel.clientDir, rel.monthDir, rel.file);
}

/** Write one report file (0600) under REPORTS_DIR/<client>/<YYYY-MM>/ with the D7 checks. */
export function writeReportFile(reportsDir: string, report: Pick<TemplateReport, "client" | "template" | "period">, format: Format, data: string | Buffer): ExportedFile {
  const root = resolve(reportsDir);
  const rel = reportRelPath(report.client.slug, report.period.folderMonth, report.template.id, report.period.current, format);
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
    return { format, path, bytes: statSync(path).size, overwritten };
  } catch (err) {
    if (err instanceof ReportWriteError) throw err;
    throw new ReportWriteError(`Couldn't write ${path}: ${(err as Error).message}`);
  }
}

/** The branding logo as checked bytes (PNG or JPEG, at most 512 KB), or a warning. */
export function loadLogo(branding: ResolvedBranding): { logo?: DocBranding["logo"]; warning?: string } {
  const l = branding.logo;
  if (!l) return {};
  try {
    if (!existsSync(l.resolved)) return { warning: `Logo ${l.path} doesn't exist; rendered without it.` };
    const st = statSync(l.resolved);
    if (!st.isFile()) return { warning: `Logo ${l.path} isn't a file; rendered without it.` };
    if (st.size > MAX_LOGO_BYTES) return { warning: `Logo ${l.path} is larger than 512 KB; rendered without it.` };
    const data = readFileSync(l.resolved);
    const mime = sniffImage(data);
    if (!mime) return { warning: `Logo ${l.path} isn't a PNG or JPEG; rendered without it.` };
    return { logo: { mime, data } };
  } catch (err) {
    return { warning: `Logo ${l.path} couldn't be read (${(err as Error).message}); rendered without it.` };
  }
}

const message = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err));

export async function exportReport(report: TemplateReport, opts: ExportOptions): Promise<ExportResult> {
  validateNarrative(opts.narrative, report.sections.map((s) => s.id));
  if (!opts.formats.length && !opts.inline) throw new Error("Nothing to do: give at least one format, or inline.");
  const warnings: string[] = [...new Set([...(opts.warnings ?? []), ...(report.warnings ?? [])])];
  const { logo, warning } = loadLogo(opts.branding);
  if (warning) warnings.push(warning);
  const doc = buildReportDoc(report, { narrative: opts.narrative, branding: opts.branding, logo, version: opts.version });

  const files: ExportedFile[] = [];
  const failed: string[] = [];
  for (const format of [...new Set(opts.formats)]) {
    let data: string | Buffer;
    try {
      if (format === "md") data = toMarkdown(doc);
      else if (format === "html") data = toHtml(doc);
      else if (format === "docx") data = await toDocx(doc);
      else data = await opts.printer(toHtml(doc), { paper: doc.branding.paper, footer: doc.footer, signal: opts.signal });
    } catch (err) {
      failed.push(format);
      warnings.push(`${format.toUpperCase()} not written: ${message(err)}${format === "pdf" ? ` ${PDF_CHROME_HINT}` : ""}`);
      continue;
    }
    files.push(writeReportFile(opts.reportsDir, report, format, data));
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
    ...(inline ? { inline } : {}),
    sectionErrors: report.sections.flatMap((s) => (s.status === "error" ? [{ id: s.id, error: s.error }] : [])),
    warnings,
  };
}
