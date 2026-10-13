/**
 * The template read operations behind list_report_templates, get_report_template,
 * validate_report_template and `crawlmark-cli report templates ...`. Local only:
 * no network, nothing written except by `initStarterFile` (never overwrites).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { clientTemplatesFile, globalTemplatesFile } from "../paths.js";
import { STARTER_YAML } from "./builtin.js";
import { loadTemplates, readTemplateFile, resolveLogo, resolveTemplate, type LoadedTemplates } from "./load.js";
import { isPaidSection, validateTemplateText, withTemplateDefaults, type ValidationResult } from "./schema.js";

export function listReportTemplates(homeDir: string, clientSlug?: string, today?: Date) {
  const loaded = loadTemplates({ homeDir, clientSlug, ...(today ? { today } : {}) });
  return {
    templates: [...loaded.templates.entries()].map(([id, t]) => {
      const spec = withTemplateDefaults(t.spec);
      return {
        id,
        title: spec.title,
        ...(spec.description ? { description: spec.description } : {}),
        source: t.source,
        period: spec.period,
        sections: spec.sections.length,
        optionalSections: spec.sections.filter((s) => s.optional).map((s) => s.id),
        paidSections: spec.sections.filter((s) => s.paid || isPaidSection(s)).map((s) => s.id),
      };
    }),
    files: loaded.files,
    defaults: loaded.defaults,
  };
}

export function getReportTemplate(homeDir: string, templateId: string, clientSlug?: string, today?: Date) {
  const loaded: LoadedTemplates = loadTemplates({ homeDir, clientSlug, ...(today ? { today } : {}) });
  const t = resolveTemplate(loaded, templateId);
  return { id: t.id, source: t.source, ...(t.file ? { file: t.file } : {}), template: t.spec, branding: loaded.branding };
}

/** Validate YAML text, or the global / client file. No network. */
export function validateReportTemplate(
  homeDir: string,
  input: { yaml?: string | undefined; file?: "global" | "client" | undefined; clientSlug?: string | undefined },
  today?: Date,
): ValidationResult & { file?: string } {
  if ((input.yaml === undefined) === (input.file === undefined)) throw new Error("Give exactly one of yaml or file.");
  if (input.yaml !== undefined) {
    const r = validateTemplateText(input.yaml, { ...(today ? { today } : {}), logoExists: (l) => existsSync(resolveLogo(homeDir, l)) });
    const { value: _value, ...rest } = r;
    return rest;
  }
  if (input.file === "client" && !input.clientSlug) throw new Error("file: \"client\" needs a client.");
  const path = input.file === "client" ? clientTemplatesFile(homeDir, input.clientSlug!) : globalTemplatesFile(homeDir);
  if (!existsSync(path)) return { valid: false, errors: [{ path: "", message: `${path} doesn't exist` }], warnings: [], file: path };
  const { status } = readTemplateFile(path, homeDir, today);
  return { valid: status.valid, errors: status.errors ?? [], warnings: status.warnings ?? [], file: path };
}

/** Validate a file at any path (the CLI's `templates validate <file>`). */
export function validateTemplateFileAt(path: string, homeDir: string, today?: Date): ValidationResult & { file: string } {
  if (!existsSync(path)) return { valid: false, errors: [{ path: "", message: `${path} doesn't exist` }], warnings: [], file: path };
  const { status } = readTemplateFile(path, homeDir, today);
  return { valid: status.valid, errors: status.errors ?? [], warnings: status.warnings ?? [], file: path };
}

/** Write the starter global file when it is absent (0600 file, 0700 directory). Never overwrites. */
export function initStarterFile(homeDir: string): { path: string; created: boolean } {
  const path = globalTemplatesFile(homeDir);
  if (existsSync(path)) return { path, created: false };
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try {
    // `wx`: if another process created the file in the meantime, leave theirs alone.
    writeFileSync(path, STARTER_YAML, { mode: 0o600, flag: "wx" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") return { path, created: false };
    throw err;
  }
  chmodSync(path, 0o600);
  return { path, created: true };
}

