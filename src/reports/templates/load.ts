/**
 * Template lookup (D8): files are read on every call (edits apply without a
 * restart). Lookup order for an id: the client's file, the global file, the
 * builtin. Branding merges field by field (client over global); `defaults`
 * likewise. An invalid file never hides the builtin `monthly`; its errors are
 * reported instead.
 */
import { existsSync } from "node:fs";
import { basename, isAbsolute, resolve } from "node:path";
import { RegularFileError, readRegularFileCapped } from "../../lib/read-regular-file.js";
import { clientTemplatesFile, globalTemplatesFile } from "../paths.js";
import { BUILTIN_DEFAULTS, BUILTIN_TEMPLATES } from "./builtin.js";
import {
  MAX_TEMPLATE_BYTES,
  validateTemplateText,
  withTemplateDefaults,
  type Branding,
  type Format,
  type ResolvedTemplateSpec,
  type TemplateFile,
  type TemplateSpec,
  type ValidationIssue,
  type ValidationResult,
} from "./schema.js";

export type TemplateSource = "builtin" | "global" | "client";

export interface TemplateFileStatus {
  path: string;
  exists: boolean;
  valid: boolean;
  errors?: ValidationIssue[];
  warnings?: ValidationIssue[];
}

export interface ResolvedBranding extends Omit<Branding, "logo"> {
  logo?: { path: string; resolved: string; exists: boolean };
}

export interface LoadedTemplates {
  files: { global: TemplateFileStatus; client?: TemplateFileStatus };
  templates: Map<string, { spec: TemplateSpec; source: TemplateSource; file?: string }>;
  branding: ResolvedBranding;
  defaults: { template: string; formats: Format[] };
}

export interface LoadOptions {
  homeDir: string;
  clientSlug?: string | undefined;
  today?: Date;
}

/** A logo path: relative ones resolve against the config home. */
export const resolveLogo = (homeDir: string, logo: string) => (isAbsolute(logo) ? logo : resolve(homeDir, logo));

/** Read and validate one template file. A missing file is valid and empty. */
export function readTemplateFile(path: string, homeDir: string, today?: Date): { status: TemplateFileStatus; value?: TemplateFile } {
  if (!existsSync(path)) return { status: { path, exists: false, valid: true } };
  let result: ValidationResult;
  try {
    let text: string | undefined;
    try {
      text = readRegularFileCapped(path, MAX_TEMPLATE_BYTES).toString("utf8");
    } catch (err) {
      if (!(err instanceof RegularFileError) || err.reason !== "too-large") throw err;
    }
    if (text === undefined) {
      result = { valid: false, errors: [{ path: "", message: `the file is larger than ${MAX_TEMPLATE_BYTES / 1024} KB` }], warnings: [] };
    } else {
      result = validateTemplateText(text, { ...(today ? { today } : {}), logoExists: (l) => existsSync(resolveLogo(homeDir, l)) });
    }
  } catch (err) {
    result = { valid: false, errors: [{ path: "", message: `couldn't read the file: ${(err as Error).message}` }], warnings: [] };
  }
  const status: TemplateFileStatus = {
    path,
    exists: true,
    valid: result.valid,
    ...(result.errors.length ? { errors: result.errors } : {}),
    ...(result.warnings.length ? { warnings: result.warnings } : {}),
  };
  return result.value ? { status, value: result.value } : { status };
}

export function loadTemplates(opts: LoadOptions): LoadedTemplates {
  const global = readTemplateFile(globalTemplatesFile(opts.homeDir), opts.homeDir, opts.today);
  const client = opts.clientSlug ? readTemplateFile(clientTemplatesFile(opts.homeDir, opts.clientSlug), opts.homeDir, opts.today) : undefined;

  const templates: LoadedTemplates["templates"] = new Map();
  for (const [id, spec] of Object.entries(BUILTIN_TEMPLATES)) templates.set(id, { spec, source: "builtin" });
  for (const [id, spec] of Object.entries(global.value?.templates ?? {})) templates.set(id, { spec, source: "global", file: global.status.path });
  // A client template with the same id replaces the global one entirely (no section-level merge).
  for (const [id, spec] of Object.entries(client?.value?.templates ?? {})) templates.set(id, { spec, source: "client", file: client!.status.path });

  const merged: Branding = { ...(global.value?.branding ?? {}), ...(client?.value?.branding ?? {}) };
  const { logo, ...rest } = merged;
  const branding: ResolvedBranding = { ...rest };
  if (logo) {
    const resolved = resolveLogo(opts.homeDir, logo);
    branding.logo = { path: logo, resolved, exists: existsSync(resolved) };
  }
  const defaults = {
    template: client?.value?.defaults?.template ?? global.value?.defaults?.template ?? BUILTIN_DEFAULTS.template,
    formats: client?.value?.defaults?.formats ?? global.value?.defaults?.formats ?? BUILTIN_DEFAULTS.formats,
  };
  return { files: { global: global.status, ...(client ? { client: client.status } : {}) }, templates, branding, defaults };
}

export interface ResolvedTemplate {
  id: string;
  source: TemplateSource;
  file?: string;
  spec: ResolvedTemplateSpec;
}

/** Look up a template id (default: the merged `defaults.template`). Unknown ids list the available ones. */
export function resolveTemplate(loaded: LoadedTemplates, id?: string): ResolvedTemplate {
  const want = id ?? loaded.defaults.template;
  const hit = loaded.templates.get(want);
  if (!hit) {
    const invalid = [loaded.files.global, loaded.files.client].filter((f) => f && f.exists && !f.valid).map((f) => f!.path);
    throw new Error(
      `No report template "${want}". Available: ${[...loaded.templates.keys()].join(", ")}.` +
        (invalid.length ? ` These template files have errors and were ignored (check them with validate_report_template): ${invalid.join(", ")}.` : ""),
    );
  }
  return { id: want, source: hit.source, ...(hit.file ? { file: hit.file } : {}), spec: withTemplateDefaults(hit.spec) };
}

/**
 * One line per template file that exists but is invalid (and so was ignored): the file name only, never
 * the full path, since these lines can end up in a client-facing report.
 */
export function templateFileWarnings(loaded: Pick<LoadedTemplates, "files">): string[] {
  return [loaded.files.global, loaded.files.client]
    .filter((f): f is TemplateFileStatus => Boolean(f && f.exists && !f.valid))
    .map((f) => `Template file ${basename(f.path)} has errors and was ignored, so the builtin or global template and branding were used. Run validate_report_template to see them.`);
}
