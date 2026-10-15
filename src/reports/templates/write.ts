/**
 * Template file writes (Phase 13 C, D19): add or change one template in the global file
 * (`<home>/config/report-templates.yaml`) or a client's file (`<home>/config/report-templates/<client>.yaml`).
 * Files are edited with the `yaml` Document API, so comments, key order and formatting the user wrote
 * survive; the whole new text is validated before anything is written. Only those two paths can be written,
 * never through a symlink, atomically with mode 0600, and the previous version is kept as `<file>.bak`.
 * Branding, defaults.template, clients.yaml, secrets and project settings are never written here.
 *
 * `planTemplateWrite` only reads; `applyTemplateWrite` writes after checking the file is unchanged.
 */
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { Document, isMap, isScalar, isSeq, parseDocument, YAMLMap, YAMLSeq, type Node } from "yaml";
import { RegularFileError, readRegularFileCapped } from "../../lib/read-regular-file.js";
import { writeFileAtomic } from "../../lib/atomic-file.js";
import { clientTemplatesFile, globalTemplatesFile } from "../paths.js";
import { BUILTIN_TEMPLATES } from "./builtin.js";
import { readTemplateFile, resolveLogo } from "./load.js";
import {
  ID_RE,
  isPaidSection,
  MAX_TEMPLATE_BYTES,
  SectionSchema,
  validateTemplateText,
  type Format,
  type SectionSpec,
  type TemplateSpec,
  type ValidationIssue,
} from "./schema.js";

export type TemplateFileKind = "global" | "client";

/** update_report_template's `patch`: add or remove sections, or change the template's top-level fields. */
export interface TemplatePatch {
  addSections?: unknown[] | undefined;
  removeSectionIds?: string[] | undefined;
  set?: { title?: unknown; description?: unknown; period?: unknown; compare?: unknown; layout?: unknown } | undefined;
}

export interface TemplateWriteRequest {
  homeDir: string;
  file: TemplateFileKind;
  clientSlug?: string | undefined;
  id: string;
  /** "create" adds a template (an existing id needs `replace`); "update" changes one that is already in the file. */
  mode: "create" | "update";
  /** The whole template (create; or update replacing it). Validated with the template schema. */
  template?: unknown;
  /** update only, instead of `template`. */
  patch?: TemplatePatch | undefined;
  /** create: overwrite a template with this id in the file, or shadow a builtin with the same id. */
  replace?: boolean | undefined;
  /** The CLI builder only: set `defaults.formats` when the file has none (never changes an existing value). */
  defaultFormats?: Format[] | undefined;
  today?: Date;
}

export interface TemplateWritePlan {
  path: string;
  file: TemplateFileKind;
  clientSlug: string | null;
  id: string;
  mode: "create" | "update";
  /** The file's text now (null when it doesn't exist yet). */
  before: string | null;
  after: string;
  /** Unified diff of the whole file (at most MAX_DIFF_CHARS). */
  diff: string;
  /** The template's own YAML block, as it will be saved. */
  yaml: string;
  beforeHash: string | null;
  afterHash: string;
  /** The file existed before this write. */
  exists: boolean;
  /** The id was already a template in this file (create with replace, or update). */
  replaces: boolean;
  /** The id is a builtin template that this file's template will hide. */
  shadowsBuiltin: boolean;
  /** A client-file template whose id is also a template in the global file: it hides that one for this client (SEC-1b). */
  shadowsGlobal: boolean;
  /** A client-file save while the global file exists but is invalid and its template ids couldn't be read: whether this id hides a global template is unknown. */
  globalFileInvalid: boolean;
  template: TemplateSpec;
  paidSections: { id: string; type: string }[];
  warnings: ValidationIssue[];
}

/** The proposal is invalid: nothing can be written. `errors` carry YAML paths in the target file. */
export class TemplateWriteError extends Error {
  override name = "TemplateWriteError";
  constructor(
    message: string,
    readonly errors: ValidationIssue[],
  ) {
    super(message);
  }
}

/** The file changed (or appeared, or went) since the plan was made. */
export class TemplateFileChangedError extends Error {
  override name = "TemplateFileChangedError";
}

export const MAX_DIFF_CHARS = 20_000;

export const sha256 = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");

/** lineWidth 0: never fold long strings across lines (as clients-file.ts). */
const serialize = (doc: Document) => doc.toString({ lineWidth: 0 });

/** The file a template write targets: only these two shapes of path, inside `<home>/config`. */
export function templateTargetPath(homeDir: string, file: TemplateFileKind, clientSlug?: string | null): string {
  if (file === "client" && !clientSlug) throw new TemplateWriteError('file: "client" needs a client.', [{ path: "", message: 'file: "client" needs a client' }]);
  const path = file === "client" ? clientTemplatesFile(homeDir, clientSlug!) : globalTemplatesFile(homeDir);
  assertSafeTarget(homeDir, path);
  return path;
}

/**
 * Refuse a target outside `<home>/config`, or one where the file, its folder or `config` itself is a symlink
 * (a link could point a write at any file the user can write).
 */
export function assertSafeTarget(homeDir: string, path: string): void {
  const configDir = resolve(homeDir, "config");
  const abs = resolve(path);
  const rel = relative(configDir, abs);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`Refusing to write ${abs}: template files live under ${configDir}.`);
  const allowed = rel === "report-templates.yaml" || (rel.startsWith(`report-templates${sep}`) && rel.split(sep).length === 2 && rel.endsWith(".yaml"));
  if (!allowed) throw new Error(`Refusing to write ${abs}: only ${join(configDir, "report-templates.yaml")} and ${join(configDir, "report-templates", "<client>.yaml")} can be written.`);
  for (let p = abs; ; p = dirname(p)) {
    const st = lstatSync(p, { throwIfNoEntry: false });
    if (st?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${p}`);
    if (p === configDir) break;
  }
}

/** The current text of a template file, or null when it doesn't exist. Exported for tests. */
export function readCurrent(path: string): string | null {
  if (!existsSync(path)) return null;
  // One handle (no symlink followed, regular file, size capped on the bytes read), so a path swapped after the
  // existsSync can't put another file's text into a proposal diff.
  try {
    return readRegularFileCapped(path, MAX_TEMPLATE_BYTES).toString("utf8");
  } catch (err) {
    if (err instanceof RegularFileError && err.reason === "too-large") {
      throw new TemplateWriteError(`${path} is larger than ${MAX_TEMPLATE_BYTES / 1024} KB.`, [{ path: "", message: `the file is larger than ${MAX_TEMPLATE_BYTES / 1024} KB` }]);
    }
    if (err instanceof RegularFileError || (err as NodeJS.ErrnoException).code === "ELOOP") throw new Error(`${path} isn't a regular file.`);
    throw err;
  }
}

/** Section maps and periods in flow style (`- { id: search, type: search_overview }`), like the starter file. */
function styleTemplateNode(node: unknown): void {
  if (!isMap(node)) return;
  const sections = node.get("sections", true);
  if (isSeq(sections)) {
    sections.flow = false;
    for (const item of sections.items) styleSection(item);
  }
  const period = node.get("period", true);
  if (isMap(period)) period.flow = true;
  const compare = node.get("compare", true);
  if (isSeq(compare)) compare.flow = true;
}

function styleSection(item: unknown): void {
  if (!isMap(item)) return;
  item.flow = true;
  for (const pair of item.items) if (isSeq(pair.value) || isMap(pair.value)) (pair.value as YAMLSeq | YAMLMap).flow = true;
}

/** `{ templates: {} }` map of the document, created when missing. */
function templatesMap(doc: Document): YAMLMap {
  const node = doc.get("templates", true);
  if (isMap(node)) {
    node.flow = false;
    return node;
  }
  if (node !== undefined && !(isScalar(node) && (node.value === null || node.value === ""))) {
    throw new TemplateWriteError("templates: is not a map in this file; fix it by hand first.", [{ path: "templates", message: "must be a map of template ids" }]);
  }
  const map = new YAMLMap();
  doc.set("templates", map);
  return map;
}

const SET_FIELDS = ["title", "description", "period", "compare", "layout"] as const;

function asObject(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new TemplateWriteError(`${what} must be an object.`, [{ path: "", message: `${what} must be an object` }]);
  return v as Record<string, unknown>;
}

/** Plan the write: read the file, apply the change to its YAML document, validate the result. Writes nothing. */
export function planTemplateWrite(req: TemplateWriteRequest): TemplateWritePlan {
  if (!ID_RE.test(req.id)) {
    throw new TemplateWriteError(`"${req.id}" isn't a valid template id.`, [{ path: "id", message: "must be 1-40 characters: lowercase letters, digits and hyphens, starting with a letter or digit" }]);
  }
  if ((req.template === undefined) === (req.patch === undefined)) {
    throw new TemplateWriteError("Give exactly one of template or patch.", [{ path: "", message: "give exactly one of template or patch" }]);
  }
  if (req.mode === "create" && req.patch !== undefined) throw new TemplateWriteError("A new template needs the whole template, not a patch.", [{ path: "patch", message: "only update_report_template takes a patch" }]);
  const clientSlug = req.file === "client" ? (req.clientSlug ?? null) : null;
  const path = templateTargetPath(req.homeDir, req.file, clientSlug);
  const before = readCurrent(path);
  const doc = before === null || before.trim() === "" ? new Document({ version: 1 }) : parseDocument(before, { uniqueKeys: true });
  if (doc.errors.length) {
    throw new TemplateWriteError(`${path} isn't valid YAML; fix it first (report templates validate).`, [{ path: "", message: `YAML: ${doc.errors[0]!.message.split("\n")[0]}` }]);
  }
  if (!isMap(doc.contents)) throw new TemplateWriteError(`${path} isn't a YAML map; fix it first.`, [{ path: "", message: "the file must be a YAML map" }]);
  if (!doc.has("version")) doc.set("version", 1);
  const templates = templatesMap(doc);
  const existing = templates.get(req.id, true);
  const inFile = existing !== undefined;
  const isBuiltin = Object.hasOwn(BUILTIN_TEMPLATES, req.id);
  // A client template with the same id fully replaces the global one for that client (load.ts), so say so.
  const globalIds = req.file === "client" ? globalTemplateIds(req.homeDir, req.today) : { ids: [] as string[] };
  const shadowsGlobal = globalIds.ids.includes(req.id);
  const globalFileInvalid = req.file === "client" && globalIds.unreadable === true;
  const where = req.file === "client" ? `${clientSlug}'s template file` : "the global template file";

  if (req.mode === "create") {
    if (inFile && !req.replace) throw new TemplateWriteError(`A template "${req.id}" is already in ${where}. Pass replace: true to overwrite it, or use update_report_template.`, [{ path: `templates.${req.id}`, message: "already exists" }]);
    if (!inFile && isBuiltin && !req.replace) {
      throw new TemplateWriteError(`"${req.id}" is a builtin template. Pass replace: true to save your own "${req.id}" in ${where} (it then hides the builtin one), or pick another id.`, [{ path: "id", message: "is a builtin template id" }]);
    }
  } else if (!inFile) {
    throw new TemplateWriteError(`There is no template "${req.id}" in ${where}${isBuiltin ? ` (it's a builtin; save your own copy with create_report_template and replace: true)` : ""}.`, [{ path: `templates.${req.id}`, message: "doesn't exist in this file" }]);
  }

  if (req.template !== undefined) {
    const node = doc.createNode(asObject(req.template, "template")) as Node;
    styleTemplateNode(node);
    templates.set(req.id, node);
  } else {
    applyPatch(doc, templates, req.id, req.patch!);
  }
  if (req.defaultFormats?.length && doc.getIn(["defaults", "formats"]) === undefined) {
    const defaults = doc.get("defaults", true);
    if (defaults !== undefined && !isMap(defaults)) throw new TemplateWriteError("defaults: is not a map in this file.", [{ path: "defaults", message: "must be a map" }]);
    const seq = doc.createNode([...req.defaultFormats]) as YAMLSeq;
    seq.flow = true;
    doc.setIn(["defaults", "formats"], seq);
  }

  // Edit the text in place (only the changed lines differ); if that isn't possible for this file's layout,
  // or the edited text doesn't parse to the same data, fall back to re-serializing the document (comments kept).
  let after: string;
  try {
    after = serialize(doc);
  } catch (err) {
    // Replacing a template whose anchor is used elsewhere leaves an alias with nothing to point at.
    if (/alias/i.test((err as Error).message)) {
      throw new TemplateWriteError(`templates.${req.id} is used through an alias elsewhere in this file; fix it by hand first.`, [{ path: `templates.${req.id}`, message: "is used through a YAML alias elsewhere in this file; fix it by hand first" }]);
    }
    throw err;
  }
  let reformatted = false;
  if (before !== null && before.trim() !== "") {
    const spliced = spliceEdit(before, req);
    if (spliced !== null && sameData(spliced, doc)) after = spliced;
    else reformatted = after !== before;
  }
  const result = validateTemplateText(after, { ...(req.today ? { today: req.today } : {}), logoExists: (l) => existsSync(resolveLogo(req.homeDir, l)) });
  if (!result.valid) throw new TemplateWriteError(`The template isn't valid: ${result.errors.map((e) => `${e.path || "(file)"}: ${e.message}`).join("; ")}`, result.errors);
  const template = result.value!.templates![req.id]!;
  const block = new Document({ [req.id]: template });
  styleTemplateNode((block.contents as YAMLMap).get(req.id, true));
  return {
    path,
    file: req.file,
    clientSlug,
    id: req.id,
    mode: req.mode,
    before,
    after,
    diff: unifiedDiff(before ?? "", after, { from: before === null ? "/dev/null" : `a/${basenameOf(path)}`, to: `b/${basenameOf(path)}` }),
    yaml: serialize(block),
    beforeHash: before === null ? null : sha256(before),
    afterHash: sha256(after),
    exists: before !== null,
    replaces: inFile,
    shadowsBuiltin: isBuiltin,
    shadowsGlobal,
    globalFileInvalid,
    template,
    paidSections: template.sections.filter((s) => isPaidSection(s) || s.paid === true).map((s) => ({ id: s.id, type: s.type })),
    warnings: [
      ...result.warnings,
      ...(isBuiltin ? [{ path: `templates.${req.id}`, message: `hides the builtin "${req.id}" template${req.file === "client" ? " for this client" : ""}` }] : []),
      ...(shadowsGlobal ? [{ path: `templates.${req.id}`, message: `hides the global "${req.id}" template for this client` }] : []),
      ...(globalFileInvalid ? [{ path: `templates.${req.id}`, message: `the global template file is invalid, so it can't be checked whether this hides a global "${req.id}" template; fix the global file (report templates validate)` }] : []),
      ...(reformatted ? [{ path: "", message: "this file's layout couldn't be edited line by line, so it is rewritten in a standard layout (comments kept); check the diff" }] : []),
    ],
  };
}

/**
 * The template ids in the global file. A valid file gives its templates; an invalid one (which loads as no templates
 * at all) is read raw so a client template can still be seen to hide one of its ids once the file is fixed (L-1).
 * `unreadable` when the file exists, is invalid and its `templates` keys can't be read either.
 */
function globalTemplateIds(homeDir: string, today: Date | undefined): { ids: string[]; unreadable?: boolean } {
  const path = globalTemplatesFile(homeDir);
  const read = readTemplateFile(path, homeDir, today);
  if (read.value) return { ids: Object.keys(read.value.templates ?? {}) };
  if (!read.status.exists) return { ids: [] };
  try {
    // Too large, not a regular file (or a symlink): not trusted, same as unparseable.
    const doc = parseDocument(readRegularFileCapped(path, MAX_TEMPLATE_BYTES).toString("utf8"), { uniqueKeys: true });
    // A duplicate key still parses to a map; any other YAML error may have dropped content, so it isn't trusted.
    if (doc.errors.some((e) => e.code !== "DUPLICATE_KEY")) return { ids: [], unreadable: true };
    const root = doc.toJS() as unknown;
    if (root === null || typeof root !== "object" || Array.isArray(root)) return { ids: [], unreadable: true };
    const templates = (root as { templates?: unknown }).templates;
    if (templates === undefined || templates === null) return { ids: [] };
    if (typeof templates !== "object" || Array.isArray(templates)) return { ids: [], unreadable: true };
    return { ids: Object.keys(templates) };
  } catch {
    return { ids: [], unreadable: true };
  }
}

const basenameOf = (p: string) => p.split(/[\\/]/).pop()!;

// ------------------------------------------------------------------ in-place text edits

interface Edit {
  start: number;
  end: number;
  text: string;
}

const lineStart = (t: string, off: number) => t.lastIndexOf("\n", off - 1) + 1;
/** The offset just after the newline that ends the line holding `end - 1`; -1 when there is none. */
function nextLineStart(t: string, end: number): number {
  if (end > 0 && t[end - 1] === "\n") return end;
  const i = t.indexOf("\n", end);
  return i < 0 ? -1 : i + 1;
}
const columnOf = (t: string, off: number) => off - lineStart(t, off);
const indent = (block: string, n: number) =>
  block
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");
const keyText = (k: unknown) => (isScalar(k) ? String(k.value) : undefined);
const rangeOf = (n: unknown): [number, number, number] | undefined => (n as { range?: [number, number, number] } | null | undefined)?.range ?? undefined;

/** A value on one line (`{ range: last_quarter }`, `[ previous_period ]`, `Title`); null when it can't be. */
function inlineValue(v: unknown): string | null {
  const d = new Document(v);
  if (isMap(d.contents) || isSeq(d.contents)) (d.contents as YAMLMap | YAMLSeq).flow = true;
  const out = serialize(d).trimEnd();
  return out.includes("\n") ? null : out;
}

/** A section as one flow-style line (`{ id: search, type: search_overview }`); null when it can't be. */
function sectionLine(sec: unknown): string | null {
  const d = new Document(sec);
  styleSection(d.contents);
  const out = serialize(d).trimEnd();
  return out.includes("\n") ? null : out;
}

/** The template as a block (`<id>:` then its fields), as it is inserted into a file. */
function templateBlock(id: string, spec: unknown): string {
  const d = new Document({ [id]: spec });
  styleTemplateNode((d.contents as YAMLMap).get(id, true));
  return serialize(d);
}

/**
 * The same change as the document edit, made on the text: the new or replaced template block, sections added
 * at the end of the list or removed line by line, fields replaced on their own line, defaults.formats added.
 * Returns null for layouts it doesn't handle (flow-style maps or lists, several items on one line, no final
 * newline); the caller then re-serializes.
 */
function spliceEdit(before: string, req: TemplateWriteRequest): string | null {
  if (!before.endsWith("\n")) return null;
  const orig = parseDocument(before, { uniqueKeys: true });
  const root = orig.contents;
  if (orig.errors.length || !isMap(root) || root.flow) return null;
  const edits: Edit[] = [];
  // A file with no version: line gets one at the top, as the document edit adds it.
  if (!root.has("version")) edits.push({ start: 0, end: 0, text: "version: 1\n" });
  const tpl = root.get("templates", true);
  if (req.template !== undefined) {
    const block = templateBlock(req.id, req.template);
    if (tpl === undefined) {
      edits.push({ start: before.length, end: before.length, text: `templates:\n${indent(block, 2)}` });
    } else if (isMap(tpl) && !tpl.flow && tpl.items.length) {
      const first = rangeOf(tpl.items[0]!.key);
      if (!first) return null;
      const ind = columnOf(before, first[0]);
      const pair = tpl.items.find((p) => keyText(p.key) === req.id);
      if (pair) {
        const k = rangeOf(pair.key);
        const v = rangeOf(pair.value);
        if (!k || !v) return null;
        const e = nextLineStart(before, v[1]);
        if (e < 0) return null;
        edits.push({ start: lineStart(before, k[0]), end: e, text: indent(block, ind) });
      } else {
        const r = rangeOf(tpl);
        const e = r ? nextLineStart(before, r[1]) : -1;
        if (e < 0) return null;
        edits.push({ start: e, end: e, text: indent(block, ind) });
      }
    } else return null;
  } else {
    if (!isMap(tpl) || tpl.flow) return null;
    const tmap = tpl.get(req.id, true);
    if (!isMap(tmap) || tmap.flow || !tmap.items.length) return null;
    const firstKey = rangeOf(tmap.items[0]!.key);
    if (!firstKey) return null;
    const fieldIndent = " ".repeat(columnOf(before, firstKey[0]));
    const patch = req.patch!;
    const sectionsPair = tmap.items.find((p) => keyText(p.key) === "sections");
    for (const [k, v] of Object.entries(patch.set ?? {})) {
      if (v === undefined) continue;
      const pair = tmap.items.find((p) => keyText(p.key) === k);
      const line = v === null ? "" : inlineValue(v);
      if (line === null) return null;
      if (pair) {
        const kr = rangeOf(pair.key);
        const end = rangeOf(pair.value)?.[1] ?? kr?.[1];
        if (!kr || end === undefined) return null;
        const e = nextLineStart(before, end);
        if (e < 0) return null;
        // A trailing comment on a one-line field stays on the new line.
        // Linear scan (SEC-5): the first whitespace-then-# after the value, with the whitespace run before it.
        const rest = before.slice(end, e).replace(/\r?\n$/, "");
        let at = rest.search(/\s#/);
        while (at > 0 && /\s/.test(rest[at - 1]!)) at--;
        const sameLine = !before.slice(kr[0], end).includes("\n");
        const comment = sameLine && at >= 0 ? rest.slice(at) : "";
        edits.push({ start: lineStart(before, kr[0]), end: e, text: v === null ? "" : `${fieldIndent}${k}: ${line}${comment}\n` });
      } else if (v !== null) {
        const sr = rangeOf(sectionsPair?.key);
        if (!sr) return null;
        const s = lineStart(before, sr[0]);
        edits.push({ start: s, end: s, text: `${fieldIndent}${k}: ${line}\n` });
      }
    }
    if (patch.removeSectionIds?.length || patch.addSections?.length) {
      const seq = sectionsPair?.value;
      if (!isSeq(seq) || seq.flow || !seq.items.length) return null;
      const dash = (item: unknown): { start: number; prefix: string } | null => {
        const r = rangeOf(item);
        if (!r) return null;
        const s = lineStart(before, r[0]);
        const m = /^(\s*)-\s+$/.exec(before.slice(s, r[0]));
        return m ? { start: s, prefix: m[1]! } : null;
      };
      for (const rid of patch.removeSectionIds ?? []) {
        const item = seq.items.find((x) => isMap(x) && x.get("id") === rid);
        const d = dash(item);
        const r = rangeOf(item);
        if (!d || !r) return null;
        const e = nextLineStart(before, r[1]);
        if (e < 0) return null;
        edits.push({ start: d.start, end: e, text: "" });
      }
      if (patch.addSections?.length) {
        const d = dash(seq.items[0]);
        const r = rangeOf(seq);
        const e = r ? nextLineStart(before, r[1]) : -1;
        if (!d || e < 0) return null;
        const lines: string[] = [];
        for (const sec of patch.addSections) {
          const l = sectionLine(sec);
          if (l === null) return null;
          lines.push(`${d.prefix}- ${l}\n`);
        }
        edits.push({ start: e, end: e, text: lines.join("") });
      }
    }
  }
  if (req.defaultFormats?.length && orig.getIn(["defaults", "formats"]) === undefined) {
    const line = inlineValue([...req.defaultFormats]);
    const defaults = root.get("defaults", true);
    if (line === null) return null;
    if (defaults === undefined) edits.push({ start: before.length, end: before.length, text: `defaults:\n  formats: ${line}\n` });
    else if (isMap(defaults) && !defaults.flow && defaults.items.length) {
      const k = rangeOf(defaults.items[0]!.key);
      const r = rangeOf(defaults);
      const e = r ? nextLineStart(before, r[1]) : -1;
      if (!k || e < 0) return null;
      edits.push({ start: e, end: e, text: `${" ".repeat(columnOf(before, k[0]))}formats: ${line}\n` });
    } else return null;
  }
  // Apply from the end so earlier offsets stay valid; edits at the same offset keep the order they were made in.
  let out = before;
  const ordered = edits.map((e, i) => ({ ...e, i })).sort((a, b) => b.start - a.start || b.i - a.i);
  for (let n = 1; n < ordered.length; n++) if (ordered[n]!.end > ordered[n - 1]!.start) return null; // overlapping edits
  // Inserted lines use the file's own line endings (CRLF files stay CRLF).
  const eol = before.includes("\r\n") ? "\r\n" : "\n";
  for (const e of ordered) out = out.slice(0, e.start) + (eol === "\n" ? e.text : e.text.replace(/\r?\n/g, eol)) + out.slice(e.end);
  return out;
}

/** The edited text parses to exactly the data of the edited document. */
function sameData(text: string, doc: Document): boolean {
  try {
    const d = parseDocument(text, { uniqueKeys: true });
    return d.errors.length === 0 && isDeepStrictEqual(d.toJS({ maxAliasCount: 10 }), doc.toJS({ maxAliasCount: 10 }));
  } catch {
    return false;
  }
}

function applyPatch(doc: Document, templates: YAMLMap, id: string, patch: TemplatePatch): void {
  const node = templates.get(id, true);
  if (!isMap(node)) throw new TemplateWriteError(`templates.${id} isn't a map; fix it by hand first.`, [{ path: `templates.${id}`, message: "must be a map" }]);
  const add = patch.addSections ?? [];
  const remove = patch.removeSectionIds ?? [];
  const set = patch.set ? asObject(patch.set, "patch.set") : {};
  if (!add.length && !remove.length && !Object.keys(set).length) throw new TemplateWriteError("The patch changes nothing.", [{ path: "patch", message: "give addSections, removeSectionIds or set" }]);
  for (const k of Object.keys(set)) {
    if (!(SET_FIELDS as readonly string[]).includes(k)) throw new TemplateWriteError(`patch.set can't change "${k}".`, [{ path: `patch.set.${k}`, message: `unknown field; use ${SET_FIELDS.join(", ")}` }]);
  }
  for (const k of SET_FIELDS) {
    if (!(k in set)) continue;
    const v = set[k];
    if (v === null) node.delete(k);
    else {
      const n = doc.createNode(v) as Node;
      if (isMap(n) || isSeq(n)) n.flow = true;
      node.set(k, n);
    }
  }
  const sections = node.get("sections", true);
  if (!isSeq(sections)) throw new TemplateWriteError(`templates.${id}.sections isn't a list; fix it by hand first.`, [{ path: `templates.${id}.sections`, message: "must be a list" }]);
  for (const rid of remove) {
    const i = sections.items.findIndex((item) => isMap(item) && item.get("id") === rid);
    if (i < 0) throw new TemplateWriteError(`Template "${id}" has no section "${rid}".`, [{ path: `patch.removeSectionIds`, message: `no section "${rid}"` }]);
    sections.items.splice(i, 1);
  }
  add.forEach((s, i) => {
    // Checked here too so the error names the patch entry, not a position in the merged list.
    const parsed = SectionSchema.safeParse(s);
    if (!parsed.success) {
      throw new TemplateWriteError(`patch.addSections[${i}] isn't a valid section: ${parsed.error.issues.map((x) => x.message).join("; ")}`, parsed.error.issues.map((x) => ({ path: `patch.addSections[${i}]${x.path.length ? `.${x.path.join(".")}` : ""}`, message: x.message })));
    }
    const n = doc.createNode(s) as Node;
    styleSection(n);
    sections.items.push(n);
  });
}

// ------------------------------------------------------------------ diff

/** Line-based unified diff (3 lines of context), capped at `max` characters. Pure; no dependency. */
export function unifiedDiff(a: string, b: string, opts: { from?: string; to?: string; context?: number; max?: number } = {}): string {
  if (a === b) return "";
  const ctx = opts.context ?? 3;
  const max = opts.max ?? MAX_DIFF_CHARS;
  const A = splitLines(a);
  const B = splitLines(b);
  const ops = diffOps(A, B);
  // Group the ops into hunks with `ctx` lines of context.
  const out: string[] = [`--- ${opts.from ?? "a"}`, `+++ ${opts.to ?? "b"}`];
  let i = 0;
  while (i < ops.length) {
    while (i < ops.length && ops[i]!.t === " ") i++;
    if (i >= ops.length) break;
    const start = Math.max(0, i - ctx);
    // Extend the hunk while changes are within 2*ctx lines of each other.
    let end = i;
    for (;;) {
      while (end < ops.length && ops[end]!.t !== " ") end++;
      let next = end;
      while (next < ops.length && ops[next]!.t === " ") next++;
      if (next < ops.length && next - end <= 2 * ctx) end = next;
      else break;
    }
    const stop = Math.min(ops.length, end + ctx);
    const slice = ops.slice(start, stop);
    const aStart = slice[0]!.a;
    const bStart = slice[0]!.b;
    const aLen = slice.filter((o) => o.t !== "+").length;
    const bLen = slice.filter((o) => o.t !== "-").length;
    out.push(`@@ -${aLen ? aStart + 1 : aStart},${aLen} +${bLen ? bStart + 1 : bStart},${bLen} @@`);
    for (const o of slice) out.push(`${o.t}${o.line}`);
    i = stop;
  }
  let text = out.join("\n") + "\n";
  if (text.length > max) {
    const cut = text.lastIndexOf("\n", max - 40);
    text = `${text.slice(0, cut > 0 ? cut : max - 40)}\n... (diff truncated)\n`;
  }
  return text;
}

function splitLines(s: string): string[] {
  if (s === "") return [];
  const lines = s.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

interface Op {
  t: " " | "-" | "+";
  line: string;
  /** Index in A of this line, or of the next A line for an insert. */
  a: number;
  b: number;
}

/** Common prefix and suffix, then an LCS table on the middle (a full replace when the middle is huge). */
function diffOps(A: string[], B: string[]): Op[] {
  let p = 0;
  while (p < A.length && p < B.length && A[p] === B[p]) p++;
  let s = 0;
  while (s < A.length - p && s < B.length - p && A[A.length - 1 - s] === B[B.length - 1 - s]) s++;
  const a = A.slice(p, A.length - s);
  const b = B.slice(p, B.length - s);
  const ops: Op[] = [];
  for (let k = 0; k < p; k++) ops.push({ t: " ", line: A[k]!, a: k, b: k });
  const n = a.length;
  const m = b.length;
  if (n * m > 4_000_000) {
    for (let k = 0; k < n; k++) ops.push({ t: "-", line: a[k]!, a: p + k, b: p });
    for (let k = 0; k < m; k++) ops.push({ t: "+", line: b[k]!, a: p + n, b: p + k });
  } else {
    const L: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let x = n - 1; x >= 0; x--) for (let y = m - 1; y >= 0; y--) L[x]![y] = a[x] === b[y] ? L[x + 1]![y + 1]! + 1 : Math.max(L[x + 1]![y]!, L[x]![y + 1]!);
    let x = 0;
    let y = 0;
    while (x < n || y < m) {
      if (x < n && y < m && a[x] === b[y]) {
        ops.push({ t: " ", line: a[x]!, a: p + x, b: p + y });
        x++;
        y++;
      } else if (x < n && (y >= m || L[x + 1]![y]! >= L[x]![y + 1]!)) {
        ops.push({ t: "-", line: a[x]!, a: p + x, b: p + y });
        x++;
      } else {
        ops.push({ t: "+", line: b[y]!, a: p + x, b: p + y });
        y++;
      }
    }
  }
  for (let k = 0; k < s; k++) ops.push({ t: " ", line: A[A.length - s + k]!, a: A.length - s + k, b: B.length - s + k });
  return ops;
}

// ------------------------------------------------------------------ apply

/**
 * Write a planned change: the target must still be safe and its bytes must still hash to `beforeHash`
 * (TemplateFileChangedError otherwise). The text is validated again, the old file kept as `<file>.bak`
 * (one copy, 0600), and the new one written atomically with mode 0600.
 */
export function applyTemplateWrite(plan: Pick<TemplateWritePlan, "path" | "before" | "after" | "beforeHash" | "afterHash">, homeDir: string, today?: Date): { path: string; backup: string | null } {
  assertSafeTarget(homeDir, plan.path);
  if (sha256(plan.after) !== plan.afterHash) throw new Error("The planned text doesn't match its hash.");
  const check = validateTemplateText(plan.after, today ? { today } : {});
  if (!check.valid) throw new TemplateWriteError("The template isn't valid any more.", check.errors);
  const now = readCurrent(plan.path);
  const nowHash = now === null ? null : sha256(now);
  if (nowHash !== plan.beforeHash) {
    throw new TemplateFileChangedError(`${plan.path} changed since the proposal${now === null ? " (it was removed)" : plan.beforeHash === null ? " (it was created)" : ""}; nothing was written. Propose the change again.`);
  }
  const dir = dirname(plan.path);
  const configDir = resolve(homeDir, "config");
  for (const d of dir === configDir ? [configDir] : [configDir, dir]) {
    if (!existsSync(d)) {
      mkdirSync(d, { recursive: true, mode: 0o700 });
      chmodSync(d, 0o700);
    }
  }
  assertSafeTarget(homeDir, plan.path);
  let backup: string | null = null;
  if (now !== null) {
    backup = `${plan.path}.bak`;
    if (lstatSync(backup, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`Refusing to write through a symlink: ${backup}`);
    writeFileAtomic(backup, now, 0o600);
  }
  writeFileAtomic(plan.path, plan.after, 0o600);
  return { path: plan.path, backup };
}

/** Section specs as the builder and the tools pass them, typed. */
export type { SectionSpec, TemplateSpec };
