/**
 * `crawlmark-cli report ...` (Phase 12 A). Output goes through the injected
 * writers so the commands run in tests without a process. Exit codes for the
 * scheduled `report` run follow D10: 0 ok, 2 attention needed, 1 error.
 */
import { resolve } from "node:path";
import type { Client } from "./config.js";
import { formatTable } from "./lib/clients.js";
import { stripControl } from "./lib/terminal-text.js";
import { exportReport, reportFilePath, ReportRenderError, ReportWriteError, type ExportedFile } from "./reports/export.js";
import type { DateRange } from "./lib/dates.js";
import type { PdfPrinter } from "./reports/render/pdf.js";
import { loadTemplates } from "./reports/templates/load.js";
import { estimateTemplate, planRun, runTemplate, type RunDeps, type RunEstimate } from "./reports/templates/run.js";
import { FORMATS, type Format } from "./reports/templates/schema.js";
import { initStarterFile, listReportTemplates, validateTemplateFileAt } from "./reports/templates/service.js";
import { globalTemplatesFile } from "./reports/paths.js";
import { PromptAbortedError } from "./setup/prompter.js";
import type { PreviewResult } from "./reports/branding-preview.js";
import type { ResolvedBranding } from "./reports/templates/load.js";

export interface CliIo {
  out(line?: string): void;
  warn(line: string): void;
  homeDir: string;
  cwd: string;
  today?: Date;
}

export interface PreviewBrandingDeps {
  /** Render the one-page preview (sample data only) with this branding. */
  render(branding: ResolvedBranding): Promise<PreviewResult>;
  /** Offer to open it (the real CLI sets this in fancy mode on a terminal only). */
  open?(path: string): Promise<void>;
  /** `--client` to the client's slug (clients.yaml, offline); throws for an unknown client. */
  resolveClient(idOrDomain: string): { slug: string };
}

/**
 * `report preview-branding [--client <domain>]`: render the saved branding (the client's override merged over the
 * global file) on a one-page sample report, print where it went, and offer to open it. Sample data only; no
 * client data, no network, no paid call. Writes nothing but `<home>/branding/preview.pdf` (or .html).
 */
export async function previewBrandingCommand(args: string[], flags: { client?: string | undefined }, io: CliIo, deps: PreviewBrandingDeps): Promise<number> {
  if (args.length) return usage(io, `report preview-branding takes only --client, got: ${args.join(" ")}`);
  let slug: string | undefined;
  try {
    slug = flags.client !== undefined ? deps.resolveClient(flags.client).slug : undefined;
  } catch (err) {
    io.warn(`Error: ${msg(err)}`);
    return 1;
  }
  const loaded = loadTemplates({ homeDir: io.homeDir, clientSlug: slug, ...(io.today ? { today: io.today } : {}) });
  const bad = [loaded.files.global, loaded.files.client].filter((f) => f && f.exists && !f.valid);
  if (bad.length) {
    for (const f of bad) io.warn(`Error: ${f!.path} is not valid; fix it first (crawlmark-cli report templates validate).`);
    return 1;
  }
  const r = await deps.render(loaded.branding);
  if (r.warning) io.warn(r.warning);
  if (r.logoWarning) io.warn(r.logoWarning);
  io.out(`Preview (sample data, not a client report): ${r.path}`);
  if (deps.open) {
    try {
      await deps.open(r.path);
    } catch (err) {
      // Ctrl-C at "Press Enter to open": the preview file is there; nothing else was written.
      if (err instanceof PromptAbortedError) {
        io.warn("Cancelled; nothing else written.");
        return 130;
      }
      throw err;
    }
  }
  return 0;
}

/** `report templates list|validate [file]|init`. Usage problems return 1 (this group is used from cron). */
export function templatesCommand(command: string | undefined, args: string[], io: CliIo): number {
  if (command === "list") {
    if (args.length) return usage(io, "report templates list takes no arguments.");
    const r = listReportTemplates(io.homeDir, undefined, io.today);
    io.out(formatTable(["ID", "TITLE", "SOURCE", "SECTIONS", "OPTIONAL"], r.templates.map((t) => [t.id, t.title, t.source, String(t.sections), t.optionalSections.join(",") || "-"])));
    const g = r.files.global;
    io.out();
    io.out(g.exists ? `Global file: ${g.path}${g.valid ? "" : " (invalid; its templates are ignored)"}` : `Global file: ${g.path} (not created; run \`report templates init\`)`);
    for (const e of g.errors ?? []) io.out(`  error ${e.path || "(file)"}: ${e.message}`);
    for (const w of g.warnings ?? []) io.out(`  warning ${w.path || "(file)"}: ${w.message}`);
    io.out(`Defaults: template ${r.defaults.template}, formats ${r.defaults.formats.join(",")}`);
    return g.exists && !g.valid ? 1 : 0;
  }
  if (command === "validate") {
    if (args.length > 1) return usage(io, "report templates validate takes at most one file.");
    const path = args[0] ? resolve(io.cwd, args[0]) : globalTemplatesFile(io.homeDir);
    const r = validateTemplateFileAt(path, io.homeDir, io.today);
    for (const e of r.errors) io.out(`error ${e.path || "(file)"}: ${e.message}`);
    for (const w of r.warnings) io.out(`warning ${w.path || "(file)"}: ${w.message}`);
    io.out(r.valid ? `${path} is valid.` : `${path} is not valid (${r.errors.length} error${r.errors.length === 1 ? "" : "s"}).`);
    return r.valid ? 0 : 1;
  }
  if (command === "init") {
    if (args.length) return usage(io, "report templates init takes no arguments.");
    const r = initStarterFile(io.homeDir);
    io.out(r.created ? `Created ${r.path} with the starter templates (monthly, quarterly).` : `${r.path} already exists; left it unchanged.`);
    return 0;
  }
  return usage(io, `Unknown command: report templates ${command ?? ""}`.trim());
}

function usage(io: CliIo, problem: string): number {
  io.warn(problem);
  return 1;
}

// ---------------------------------------------------------------- report (scheduled)

export interface ReportFlags {
  client?: string | undefined;
  all: boolean;
  template?: string | undefined;
  month?: string | undefined;
  quarter?: string | undefined;
  start?: string | undefined;
  end?: string | undefined;
  format?: string | undefined;
  include?: string | undefined;
  paid: boolean;
  "dry-run": boolean;
  /** --yes: never prompt (use the saved default formats). */
  yes?: boolean | undefined;
}

/** The formats offered by the interactive picker, in order (PDF first). */
export const FORMAT_CHOICES: readonly { value: Format; label: string }[] = [
  { value: "pdf", label: "PDF" },
  { value: "docx", label: "Word (.docx)" },
  { value: "html", label: "HTML" },
  { value: "md", label: "Markdown" },
];

export interface ReportCliDeps {
  /** One client (`--client`), or every client after discovery (`--all`; ignored ones in `skipped`). Throws for an unknown client. */
  loadClients(sel: { client?: string | undefined; all: boolean; dryRun: boolean }): Promise<{ clients: Client[]; skipped: { client: string; reason: string }[]; discovery?: unknown; discoveryError?: string | undefined }>;
  runDeps(): Promise<RunDeps>;
  printer: PdfPrinter;
  reportsDir: string;
  version: string;
  today?: Date;
  /**
   * Ask which formats to write (the real CLI sets it only on an interactive terminal in fancy mode). Not called
   * with --format, --all, --dry-run or --yes; an empty answer keeps the saved default.
   */
  chooseFormats?(defaults: Format[]): Promise<Format[]>;
}

export interface ReportClientResult {
  client: string;
  template: string;
  period: { label: string; current: DateRange; folderMonth: string };
  dataOnly: true;
  files: ExportedFile[];
  sections: { ok: number; error: number; unavailable: number; skipped: number };
  sectionErrors?: { id: string; error: string }[];
  /** Paid data the run used (operator-only; the files never show it). */
  spend?: { usd: number; units: { ahrefs: number; semrush: number } };
  warnings?: string[];
}

export interface ReportDryRunResult {
  client: string;
  template: string;
  period: { label: string; current: DateRange; folderMonth: string };
  sections: string[];
  wouldWrite: string[];
  /** Phase 13 (D17): the paid sections' estimate, when the run has any (no request is made). */
  estimate?: RunEstimate;
}

export interface ReportRunOutput {
  command: "report";
  ranAt: string;
  dryRun: boolean;
  results: (ReportClientResult | ReportDryRunResult)[];
  skipped: { client: string; reason: string }[];
  errors: string[];
  discovery?: unknown;
  exitCode: 0 | 1 | 2;
}

const list = (v: string | undefined) => (v === undefined ? undefined : v.split(",").map((x) => x.trim()).filter(Boolean));
const msg = (err: unknown) => stripControl(err instanceof Error ? err.message : String(err));
/** Sections that carry no data from a source (text and spend are always "ok"). */
const DATA_FREE_TYPES = new Set(["text", "data_spend"]);
/** An "ok" audit section with nothing to compare isn't data either. */
const isEmpty = (s: { type: string; status: string; data?: unknown }) => s.status === "ok" && s.type === "audit_changes" && (s.data as { comparison: unknown } | undefined)?.comparison === null;

/**
 * `crawlmark-cli report` (D10). Exit 0: every requested report written, no section error.
 * 2: a report was written but a section had status error, a requested format failed, or another client failed.
 * 1: usage error, invalid template, unknown client, every client failed, a failure with no report written,
 * or a file couldn't be written.
 */
export async function reportCommand(args: string[], flags: ReportFlags, io: CliIo, deps: ReportCliDeps): Promise<number> {
  if (args.length) return usage(io, `report takes only flags, got: ${args.join(" ")}`);
  if (flags.all === (flags.client !== undefined)) return usage(io, "report takes --client <domain|slug> or --all.");
  const formats = list(flags.format);
  if (formats && (!formats.length || formats.some((f) => !(FORMATS as readonly string[]).includes(f)))) return usage(io, `--format takes a comma list of ${FORMATS.join(", ")}.`);
  const include = list(flags.include) ?? [];
  if ((flags.start === undefined) !== (flags.end === undefined)) return usage(io, "--start and --end go together.");
  if ([flags.month, flags.quarter, flags.start].filter((v) => v !== undefined).length > 1) return usage(io, "Give only one of --month, --quarter, or --start and --end.");

  const global = loadTemplates({ homeDir: io.homeDir, ...(io.today ? { today: io.today } : {}) }).files.global;
  if (global.exists && !global.valid) {
    io.warn(`Error: ${global.path} is not valid; fix it first (crawlmark-cli report templates validate):`);
    for (const e of global.errors ?? []) io.warn(`  ${e.path || "(file)"}: ${e.message}`);
    return 1;
  }

  let sel: Awaited<ReturnType<ReportCliDeps["loadClients"]>>;
  try {
    sel = await deps.loadClients({ client: flags.client, all: flags.all, dryRun: flags["dry-run"] });
  } catch (err) {
    io.warn(`Error: ${msg(err)}`);
    return 1;
  }

  const results: ReportRunOutput["results"] = [];
  const skipped = [...sel.skipped];
  const errors: string[] = [];
  let fatal = false;
  let attention = false;
  let attempted = 0;
  let failed = 0;
  let written = 0;
  const runOpts = {
    homeDir: io.homeDir,
    template: flags.template,
    month: flags.month,
    quarter: flags.quarter,
    startDate: flags.start,
    endDate: flags.end,
    include,
    allowPaid: flags.paid,
    store: false,
    ...(io.today ? { today: io.today } : {}),
  };
  if (sel.discoveryError) errors.push(`Discovery failed (ran with clients.yaml entries only): ${sel.discoveryError}`);
  // One client, no --format, interactive: pick the formats once, with the saved default ticked.
  const ask = !formats && !flags.all && !flags["dry-run"] && !flags.yes && deps.chooseFormats ? deps.chooseFormats.bind(deps) : undefined;
  let picked: Format[] | undefined;
  let runDeps: RunDeps | undefined;

  for (const client of sel.clients) {
    let plan: ReturnType<typeof planRun>;
    try {
      plan = planRun(client, runOpts);
    } catch (err) {
      // A bad template id, include or period is a usage problem for every client: stop.
      errors.push(`${client.slug}: ${msg(err)}`);
      fatal = true;
      break;
    }
    const clientFile = plan.loaded.files.client;
    if (clientFile?.exists && !clientFile.valid) {
      errors.push(`${client.slug}: ${clientFile.path} is not valid: ${(clientFile.errors ?? []).map((e) => `${e.path || "(file)"}: ${e.message}`).join("; ")}`);
      fatal = true;
      continue;
    }
    if (ask && picked === undefined) {
      let chosen: Format[];
      try {
        chosen = await ask(plan.loaded.defaults.formats);
      } catch (err) {
        // Ctrl-C in the picker: nothing has run or been written yet.
        if (err instanceof PromptAbortedError) {
          io.warn("Cancelled; nothing written.");
          return 130;
        }
        throw err;
      }
      picked = chosen.length ? chosen : plan.loaded.defaults.formats;
    }
    const wanted = (formats ?? picked ?? plan.loaded.defaults.formats) as Format[];
    const period = { label: plan.period.label, current: plan.period.current, folderMonth: plan.period.folderMonth };
    if (flags["dry-run"]) {
      const target = { client: { slug: client.slug, name: client.name, domain: client.domain }, template: { id: plan.template.id, title: plan.template.spec.title, source: plan.template.source }, period: { ...period, comparisons: plan.period.comparisons } };
      let estimate: RunEstimate | undefined;
      if (plan.paidSections.length) {
        try {
          runDeps ??= await deps.runDeps();
          estimate = await estimateTemplate(client, runOpts, runDeps);
        } catch (err) {
          errors.push(`${client.slug}: the paid sections couldn't be estimated: ${msg(err)}`);
        }
      }
      results.push({ client: client.slug, template: plan.template.id, period, sections: plan.sections.map((s) => s.id), wouldWrite: wanted.map((f) => reportFilePath(deps.reportsDir, target, f)), ...(estimate ? { estimate } : {}) });
      continue;
    }
    attempted++;
    try {
      runDeps ??= await deps.runDeps();
      const report = await runTemplate(client, runOpts, runDeps);
      const counts = { ok: 0, error: 0, unavailable: 0, skipped: 0 };
      for (const s of report.sections) counts[s.status]++;
      const dataSections = report.sections.filter((s) => !DATA_FREE_TYPES.has(s.type));
      if (dataSections.length && dataSections.every((s) => s.status === "error" || s.status === "unavailable" || isEmpty(s))) {
        const reasons = [...new Set(dataSections.flatMap((s) => (s.status === "error" ? [`error: ${s.error}`] : s.status === "unavailable" ? [s.reason] : [])))];
        skipped.push({ client: client.slug, reason: `no data, so no file: ${reasons.slice(0, 3).join("; ")}` });
        // Sections that failed (for example an expired Google token) mean this client failed; sources that
        // aren't set up (unavailable) are a normal state, not a failure.
        if (counts.error) failed++;
        continue;
      }
      const out = await exportReport(report, { formats: wanted, reportsDir: deps.reportsDir, branding: plan.loaded.branding, version: deps.version, printer: deps.printer });
      // A requested format that wasn't written (a PDF without Chrome, even with the HTML fallback) needs attention.
      if (wanted.some((f) => !out.files.some((x) => x.format === f)) || counts.error) attention = true;
      written++;
      results.push({
        client: client.slug,
        template: report.template.id,
        period,
        dataOnly: true,
        files: out.files,
        sections: counts,
        ...(out.sectionErrors.length ? { sectionErrors: out.sectionErrors } : {}),
        ...(out.spend ? { spend: out.spend } : {}),
        ...(out.warnings.length ? { warnings: out.warnings } : {}),
      });
    } catch (err) {
      failed++;
      if (err instanceof ReportWriteError) {
        fatal = true;
        errors.push(`${client.slug}: ${msg(err)}`);
      } else if (err instanceof ReportRenderError) {
        errors.push(`${client.slug}: ${msg(err)}`);
      } else {
        skipped.push({ client: client.slug, reason: `error: ${msg(err)}` });
      }
    }
  }
  if (attempted > 0 && failed === attempted) {
    errors.push(`All ${attempted} client(s) failed; see skipped and errors.`);
    fatal = true;
  } else if (failed > 0 && written === 0) {
    // 2 means "at least one report written"; a failure with nothing written is an error.
    errors.push(`No report was written and ${failed} client(s) failed; see skipped and errors.`);
    fatal = true;
  }
  // As for audit and check-traffic (finish() in scheduled.ts): fatal only when it left nothing to run, never on a dry run.
  if (sel.discoveryError && sel.clients.length === 0 && !flags["dry-run"]) fatal = true;

  const output: ReportRunOutput = {
    command: "report",
    ranAt: new Date().toISOString(),
    dryRun: flags["dry-run"],
    results,
    skipped,
    errors,
    ...(sel.discovery !== undefined ? { discovery: sel.discovery } : {}),
    // A client that failed while others were written needs attention too.
    exitCode: fatal ? 1 : attention || failed > 0 ? 2 : 0,
  };
  io.out(JSON.stringify(output, null, 2));
  for (const e of errors) io.warn(`Error: ${e}`);
  return output.exitCode;
}
