/**
 * The template read operations behind list_report_templates, get_report_template,
 * validate_report_template and `crawlmark-cli report templates ...`. Local only:
 * no network, nothing written except by `initStarterFile` (never overwrites).
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { clientTemplatesFile, globalTemplatesFile } from "../paths.js";
import { STARTER_YAML } from "./builtin.js";
import { globalBlockIds, loadTemplates, readTemplateFile, resolveLogo, resolveTemplate, type LoadedTemplates } from "./load.js";
import { lintClientText, type LintField, type LintHit } from "../render/term-lint.js";
import { TOOL_NAMES } from "../../tools/names.js";
import { isPaidSection, validateTemplateText, withTemplateDefaults, type Branding, type TemplateFile, type TemplateSpec, type ValidationIssue, type ValidationResult } from "./schema.js";

/** A hit as a validation warning. */
const hitMessage = (h: LintHit) => `names the internal term "${h.term}" (…${h.snippet}…); client files would show it. Reword it, or allow the term with branding.allowTerms.`;

/** The client-facing texts of a template file: block texts, `text` sections, cover texts and the branding lines. Paths are the YAML paths. */
function templateFileFields(file: TemplateFile): LintField[] {
  const out: LintField[] = [];
  const push = (where: string, text: string | undefined) => {
    if (text) out.push({ where, text });
  };
  for (const [bid, b] of Object.entries(file.blocks ?? {})) {
    push(`blocks.${bid}.title`, b.title);
    push(`blocks.${bid}`, b.text);
  }
  for (const [tid, t] of Object.entries(file.templates ?? {})) {
    push(`templates.${tid}.title`, t.title);
    t.sections.forEach((sec, i) => {
      push(`templates.${tid}.sections[${i}].title`, sec.title);
      if (sec.type === "text") push(`templates.${tid}.sections[${i}].text`, sec.text);
    });
    push(`templates.${tid}.cover.subtitle`, t.cover?.subtitle);
    push(`templates.${tid}.cover.preparedFor`, t.cover?.preparedFor);
    push(`templates.${tid}.cover.preparedBy`, t.cover?.preparedBy);
  }
  push("branding.footer", file.branding?.footer);
  push("branding.commentaryNote", file.branding?.commentaryNote);
  return out;
}

/** Term-check warnings for a valid template file. The file's own branding allowTerms and blockTerms apply. */
export function templateTextWarnings(file: TemplateFile): ValidationIssue[] {
  const hits = lintClientText(templateFileFields(file), { toolNames: TOOL_NAMES, allowTerms: file.branding?.allowTerms, blockTerms: file.branding?.blockTerms });
  return hits.map((h) => ({ path: h.where, message: hitMessage(h) }));
}

/**
 * The texts a run of this template would put in client files before any commentary: the template title, the titles
 * and texts of the `text` and `block` sections it includes (a block section without its own title shows the block's),
 * the other section titles, the cover texts and the branding lines. For the CLI, which checks before it spends anything.
 */
export function templatePlanFields(spec: TemplateSpec, sections: TemplateSpec["sections"], blocks: ReadonlyMap<string, { text: string; title?: string | undefined }>, branding: Pick<Branding, "footer" | "commentaryNote">): LintField[] {
  const out: LintField[] = [];
  const push = (where: string, text: string | undefined) => {
    if (text) out.push({ where, text });
  };
  push("template.title", spec.title);
  for (const sec of sections) {
    push(`sections.${sec.id}.title`, sec.title ?? (sec.type === "block" ? blocks.get(sec.block)?.title : undefined));
    if (sec.type === "text") push(`sections.${sec.id}.text`, sec.text);
    else if (sec.type === "block") push(`blocks.${sec.block}`, blocks.get(sec.block)?.text);
  }
  push("cover.subtitle", spec.cover?.subtitle);
  push("cover.preparedFor", spec.cover?.preparedFor);
  push("cover.preparedBy", spec.cover?.preparedBy);
  push("branding.footer", branding.footer);
  push("branding.commentaryNote", branding.commentaryNote);
  return out;
}

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
    // With a client, the text is a client file: it may use the global file's blocks.
    const known = input.clientSlug ? globalBlockIds(homeDir, today) : undefined;
    const r = validateTemplateText(input.yaml, { ...(today ? { today } : {}), ...(known ? { knownBlocks: known } : {}), logoExists: (l) => existsSync(resolveLogo(homeDir, l)) });
    const { value, ...rest } = r;
    return value ? { ...rest, warnings: [...rest.warnings, ...templateTextWarnings(value)] } : rest;
  }
  if (input.file === "client" && !input.clientSlug) throw new Error("file: \"client\" needs a client.");
  const path = input.file === "client" ? clientTemplatesFile(homeDir, input.clientSlug!) : globalTemplatesFile(homeDir);
  if (!existsSync(path)) return { valid: false, errors: [{ path: "", message: `${path} doesn't exist` }], warnings: [], file: path };
  const { status, value } = readTemplateFile(path, homeDir, today, input.file === "client" ? globalBlockIds(homeDir, today) : undefined);
  return { valid: status.valid, errors: status.errors ?? [], warnings: [...(status.warnings ?? []), ...(value ? templateTextWarnings(value) : [])], file: path };
}

/** Validate a file at any path (the CLI's `templates validate <file>`). */
export function validateTemplateFileAt(path: string, homeDir: string, today?: Date): ValidationResult & { file: string } {
  if (!existsSync(path)) return { valid: false, errors: [{ path: "", message: `${path} doesn't exist` }], warnings: [], file: path };
  // Any file other than the global one may use the global file's blocks.
  const isGlobal = resolve(path) === resolve(globalTemplatesFile(homeDir));
  const { status, value } = readTemplateFile(path, homeDir, today, isGlobal ? undefined : globalBlockIds(homeDir, today));
  return { valid: status.valid, errors: status.errors ?? [], warnings: [...(status.warnings ?? []), ...(value ? templateTextWarnings(value) : [])], file: path };
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

