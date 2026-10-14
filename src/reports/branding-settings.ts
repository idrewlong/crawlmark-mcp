/**
 * Report branding settings (`setup --step branding`, `report preview-branding`): read the current
 * branding and default formats, check and import a logo, suggest a darker primary colour when white
 * text on it would fail WCAG AA, and write the `branding:` and `defaults.formats` of the global report
 * templates file (or a per-client override file) with comments kept. Local only; no network.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { isMap, isSeq, parseDocument, type Document } from "yaml";
import { writeFileAtomic } from "../lib/atomic-file.js";
import { stripControl } from "../lib/terminal-text.js";
import { contrast, inkOn } from "./render/color.js";
import { MAX_LOGO_BYTES, sniffImage } from "./render/image.js";
import { clientTemplatesFile, globalTemplatesFile, safeSegment } from "./paths.js";
import { STARTER_YAML } from "./templates/builtin.js";
import { loadTemplates, type ResolvedBranding } from "./templates/load.js";
import { FORMATS, validateTemplateText, type Branding, type Format } from "./templates/schema.js";

export const MAX_AGENCY_NAME = 80;
export const MAX_FOOTER = 200;
const HEX = /^#[0-9a-fA-F]{6}$/;

/** What the branding step asks for. Unset fields are left out of the file (the report uses its defaults). */
export interface BrandingSettings {
  agencyName?: string | undefined;
  /** Relative to the config home (`branding/logo.png`), as the templates file stores it. */
  logo?: string | undefined;
  primaryColor?: string | undefined;
  accentColor?: string | undefined;
  footer?: string | undefined;
  hideCrawlmark?: boolean | undefined;
  paper?: "Letter" | "A4" | undefined;
  formats?: Format[] | undefined;
}

export const SETTING_FIELDS = ["agencyName", "logo", "primaryColor", "accentColor", "footer", "hideCrawlmark", "paper", "formats"] as const;
export type SettingField = (typeof SETTING_FIELDS)[number];

/** The file the step writes: the global templates file, or the client's override file. */
export function brandingFile(homeDir: string, clientSlug?: string): string {
  return clientSlug ? clientTemplatesFile(homeDir, clientSlug) : globalTemplatesFile(homeDir);
}

/** The settings in effect (a client's override merged over the global file), shown as the current values. */
export function currentBranding(homeDir: string, clientSlug?: string): BrandingSettings {
  const loaded = loadTemplates({ homeDir, clientSlug });
  const b = loaded.branding;
  return {
    ...(b.agencyName ? { agencyName: b.agencyName } : {}),
    ...(b.logo ? { logo: b.logo.path } : {}),
    ...(b.primaryColor ? { primaryColor: b.primaryColor } : {}),
    ...(b.accentColor ? { accentColor: b.accentColor } : {}),
    ...(b.footer ? { footer: b.footer } : {}),
    ...(b.hideCrawlmark ? { hideCrawlmark: true } : {}),
    ...(b.paper ? { paper: b.paper } : {}),
    formats: loaded.defaults.formats,
  };
}

/** True when the global file (or the client's file) sets any branding. */
export function brandingConfigured(homeDir: string): { configured: boolean; agencyName?: string | undefined; clientOverrides: number } {
  const loaded = loadTemplates({ homeDir });
  const b = loaded.branding;
  const configured = Boolean(b.agencyName || b.logo || b.primaryColor || b.accentColor || b.footer || b.hideCrawlmark);
  let clientOverrides = 0;
  try {
    const dir = join(homeDir, "config", "report-templates");
    if (existsSync(dir) && statSync(dir).isDirectory()) clientOverrides = readdirSync(dir).filter((f) => f.endsWith(".yaml")).length;
  } catch {
    clientOverrides = 0;
  }
  return { configured, ...(b.agencyName ? { agencyName: b.agencyName } : {}), clientOverrides };
}


/** Text for the file: control characters stripped, trimmed, capped. */
export const cleanText = (s: string, max: number) => stripControl(s).replace(/\s+/g, " ").trim().slice(0, max);

/** "#1F5EA8" → "#1f5ea8"; a missing `#` is added. Undefined when it isn't a #rrggbb colour. */
export function parseColor(input: string): string | undefined {
  const v = input.trim().replace(/^([0-9a-fA-F]{6})$/, "#$1");
  return HEX.test(v) ? v.toLowerCase() : undefined;
}

/** White text on the primary colour: its contrast and, below AA (4.5:1), the nearest darker shade that passes. */
export function primaryContrast(primary: string): { ratio: number; ok: boolean; suggestion?: string } {
  const ratio = contrast("#ffffff", primary);
  if (ratio >= 4.5) return { ratio, ok: true };
  return { ratio, ok: false, suggestion: inkOn(primary, "#ffffff", 4.5) };
}

/**
 * A logo file the user gave: it must exist, be a file, be at most 512 KB, and start like a PNG or JPEG.
 * Returns the bytes' type, or the problem in plain words.
 */
export function checkLogoFile(path: string): { ok: true; mime: "image/png" | "image/jpeg"; bytes: number; data: Buffer } | { ok: false; problem: string } {
  if (!existsSync(path)) return { ok: false, problem: `${path} doesn't exist.` };
  const st = statSync(path);
  if (!st.isFile()) return { ok: false, problem: `${path} isn't a file.` };
  if (st.size > MAX_LOGO_BYTES) return { ok: false, problem: `${path} is ${Math.ceil(st.size / 1024)} KB; the limit is 512 KB.` };
  // The bytes are read once and these bytes are what gets checked and later written (never the file again).
  const data = readFileSync(path);
  if (data.length > MAX_LOGO_BYTES) return { ok: false, problem: `${path} is ${Math.ceil(data.length / 1024)} KB; the limit is 512 KB.` };
  const mime = sniffImage(data);
  if (!mime) return { ok: false, problem: `${path} isn't a PNG or JPEG file.` };
  return { ok: true, mime, bytes: data.length, data };
}

const isLink = (p: string) => lstatSync(p, { throwIfNoEntry: false })?.isSymbolicLink() === true;

/**
 * Write checked logo bytes (from checkLogoFile) into `<home>/branding/` under a safe name (logo.png, or
 * logo-<client>.png for a client override): directory 0700, the file written atomically as 0600. The branding
 * directory and the file must not be symlinks (dangling ones included). Returns the path relative to the home.
 * A dry run writes nothing.
 */
export function importLogo(homeDir: string, data: Buffer, mime: "image/png" | "image/jpeg", opts: { clientSlug?: string | undefined; dryRun?: boolean } = {}): string {
  const name = `logo${opts.clientSlug ? `-${safeSegment(opts.clientSlug)}` : ""}${mime === "image/png" ? ".png" : ".jpg"}`;
  const rel = `branding/${name}`;
  if (opts.dryRun) return rel;
  if (sniffImage(data) !== mime || data.length > MAX_LOGO_BYTES) throw new Error("The logo isn't a PNG or JPEG of at most 512 KB.");
  const dir = join(homeDir, "branding");
  if (isLink(dir)) throw new Error(`Refusing to write through a symlink: ${dir}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const dest = join(dir, name);
  if (isLink(dest)) throw new Error(`Refusing to replace a symlink: ${dest}`);
  writeFileAtomic(dest, data, 0o600);
  return rel;
}

/** A logo already under the home (`branding/logo.png`) or anywhere else: the absolute path to check. */
export function logoSourcePath(homeDir: string, input: string, cwd: string, userHome: string): string {
  const t = input.trim();
  const expanded = t === "~" ? userHome : t.startsWith("~/") ? join(userHome, t.slice(2)) : t;
  // A path the templates file already stores (`branding/logo.png`) is relative to the home, not the working directory.
  return /^branding\//.test(expanded) && existsSync(join(homeDir, expanded)) ? join(homeDir, expanded) : resolve(cwd, expanded);
}

function setOrDelete(doc: Document, path: string[], value: unknown): void {
  if (value === undefined || value === "") doc.deleteIn(path);
  else doc.setIn(path, value);
}

const BRANDING_KEYS = ["agencyName", "logo", "primaryColor", "accentColor", "footer", "paper", "hideCrawlmark"] as const;

/**
 * The templates file's text with the branding and default formats set (comments and every other setting kept).
 * The global file starts from the starter when it doesn't exist. A client file (`opts.global` given: the global
 * settings it overrides) starts as `version: 1` and holds only overrides: a field is written when it differs from
 * the global value or is already in the client file; one that matches the global value and isn't there is left
 * out, so later global changes still reach the client. Turning a global value off for one client writes the
 * "off" value where the file can hold one (`footer: ""`, `hideCrawlmark: false`).
 */
export function brandingFileText(existing: string | undefined, settings: BrandingSettings, opts: { client: boolean; global?: BrandingSettings | undefined }): string {
  const doc = parseDocument(existing ?? (opts.client ? "version: 1\n" : STARTER_YAML));
  if (!isMap(doc.contents)) throw new Error("The report templates file isn't a YAML mapping; fix it first (crawlmark-cli report templates validate).");
  if (!doc.has("branding") || !isMap(doc.get("branding"))) doc.set("branding", doc.createNode({}));
  const global = opts.client ? (opts.global ?? {}) : undefined;
  for (const key of BRANDING_KEYS) {
    const path = ["branding", key];
    const value = key === "hideCrawlmark" ? settings.hideCrawlmark || undefined : settings[key];
    if (!global) {
      setOrDelete(doc, path, value);
      continue;
    }
    const g = key === "hideCrawlmark" ? global.hideCrawlmark || undefined : global[key];
    const inFile = doc.hasIn(path);
    if (value === g && !inFile) continue;
    if (value !== undefined) doc.setIn(path, value);
    else if (g !== undefined && key === "footer") doc.setIn(path, "");
    else if (g !== undefined && key === "hideCrawlmark") doc.setIn(path, false);
    else doc.deleteIn(path);
  }
  const formatsChanged = !global || doc.hasIn(["defaults", "formats"]) || (settings.formats ?? []).join() !== (global.formats ?? []).join();
  if (settings.formats?.length && formatsChanged) {
    if (!doc.has("defaults") || !isMap(doc.get("defaults"))) doc.set("defaults", doc.createNode({}));
    const seq = doc.createNode([...settings.formats]);
    if (isSeq(seq)) seq.flow = true;
    doc.setIn(["defaults", "formats"], seq);
  }
  const branding = doc.get("branding");
  if (isMap(branding) && branding.items.length === 0) doc.delete("branding");
  return doc.toString({ lineWidth: 0 });
}

/**
 * Write the settings (validated first; nothing is written when the result wouldn't be a valid templates
 * file). Directory 0700, file 0600, written atomically. Returns the file written.
 */
export function writeBranding(homeDir: string, settings: BrandingSettings, clientSlug?: string): string {
  const file = brandingFile(homeDir, clientSlug);
  const text = brandingFileText(existsSync(file) ? readFileSync(file, "utf8") : undefined, settings, { client: Boolean(clientSlug), ...(clientSlug ? { global: currentBranding(homeDir) } : {}) });
  const check = validateTemplateText(text, { logoExists: (l) => existsSync(join(homeDir, l)) });
  if (!check.valid) throw new Error(`The branding wasn't saved: ${check.errors.map((e) => `${e.path || "(file)"}: ${e.message}`).join("; ")}`);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileAtomic(file, text, 0o600);
  return file;
}

/** The settings as the resolved branding a report render takes (the logo resolved against the home). */
export function asResolvedBranding(homeDir: string, s: BrandingSettings): ResolvedBranding {
  const b: Omit<Branding, "logo"> = {
    ...(s.agencyName ? { agencyName: s.agencyName } : {}),
    ...(s.primaryColor ? { primaryColor: s.primaryColor } : {}),
    ...(s.accentColor ? { accentColor: s.accentColor } : {}),
    ...(s.footer ? { footer: s.footer } : {}),
    ...(s.paper ? { paper: s.paper } : {}),
    ...(s.hideCrawlmark ? { hideCrawlmark: true } : {}),
  };
  if (!s.logo) return b;
  const resolved = resolve(homeDir, s.logo);
  return { ...b, logo: { path: s.logo, resolved, exists: existsSync(resolved) } };
}

export const isFormat = (v: string): v is Format => (FORMATS as readonly string[]).includes(v);
