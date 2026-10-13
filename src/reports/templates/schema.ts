/**
 * Report template files (Phase 12 A, 12.A.2): the zod schema, the section type
 * catalogue and `validateTemplateText`, which parses YAML and reports problems
 * with YAML paths ("templates.monthly.sections[3].limit"). Pure apart from the
 * injected `fileExists` (used only for the logo warning).
 */
import { parseDocument } from "yaml";
import { z } from "zod";

export const FORMATS = ["md", "html", "pdf", "docx"] as const;
export type Format = (typeof FORMATS)[number];

/** Template and section ids: lowercase letters, digits and hyphens, starting with a letter or digit. */
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
/** Template files are small; anything bigger is refused before parsing. */
export const MAX_TEMPLATE_BYTES = 256 * 1024;
/** A YAML alias bomb expands a few lines into millions of nodes; real templates need none or a few. */
export const MAX_ALIAS_COUNT = 10;
/** Search Console data lags about two days, so a custom period must end at least this many days ago. */
export const GSC_LAG_DAYS = 2;
export const MAX_SPAN_DAYS = 480;

const id = z.string().regex(ID_RE, "must be 1-40 characters: lowercase letters, digits and hyphens, starting with a letter or digit");
/** YYYY-MM-DD and a real calendar day (2026-02-31 is not). */
export function isRealDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return !Number.isNaN(t) && new Date(t).toISOString().startsWith(s);
}
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD").refine(isRealDate, "is not a real date");
const color = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb colour");

export const BrandingSchema = z.strictObject({
  agencyName: z.string().min(1).max(80).optional(),
  logo: z.string().min(1).max(500).optional(),
  primaryColor: color.optional(),
  accentColor: color.optional(),
  footer: z.string().max(200).optional(),
  paper: z.enum(["Letter", "A4"]).optional(),
});
export type Branding = z.infer<typeof BrandingSchema>;

export const PeriodSchema = z.discriminatedUnion("range", [
  z.strictObject({ range: z.literal("last_month") }),
  z.strictObject({ range: z.literal("last_quarter") }),
  z.strictObject({ range: z.literal("last_n_days"), days: z.number().int().min(7).max(MAX_SPAN_DAYS) }),
  z.strictObject({ range: z.literal("custom"), start: date, end: date }),
]);
export type Period = z.infer<typeof PeriodSchema>;

export const COMPARISONS = ["previous_period", "previous_year"] as const;
export type Comparison = (typeof COMPARISONS)[number];

const common = {
  id,
  title: z.string().min(1).max(120).optional(),
  optional: z.boolean().optional(),
  paid: z.boolean().optional(),
};
const limit = (max: number) => z.number().int().min(1).max(max).optional();

const sectionSchemas = [
  z.strictObject({ ...common, type: z.literal("search_overview"), metrics: z.array(z.enum(["clicks", "impressions", "ctr", "position"])).min(1).optional() }),
  z.strictObject({ ...common, type: z.literal("branded_split") }),
  z.strictObject({ ...common, type: z.literal("organic_traffic"), metrics: z.array(z.enum(["sessions", "users", "engagementRate", "keyEvents"])).min(1).optional() }),
  z.strictObject({ ...common, type: z.literal("top_queries"), limit: limit(100), includeBranded: z.boolean().optional() }),
  z.strictObject({ ...common, type: z.literal("query_movers"), limit: limit(50) }),
  z.strictObject({ ...common, type: z.literal("page_movers"), limit: limit(50) }),
  z.strictObject({ ...common, type: z.literal("top_pages"), limit: limit(100) }),
  z.strictObject({ ...common, type: z.literal("landing_pages"), limit: limit(100) }),
  z.strictObject({ ...common, type: z.literal("tracked_keywords"), liveRanks: z.boolean().optional() }),
  z.strictObject({ ...common, type: z.literal("opportunities"), limit: limit(25) }),
  z.strictObject({ ...common, type: z.literal("audit_changes"), limit: limit(50) }),
  z.strictObject({
    ...common,
    type: z.literal("core_web_vitals_history"),
    formFactor: z.enum(["PHONE", "DESKTOP", "TABLET", "ALL"]).optional(),
    weeks: z.number().int().min(1).max(40).optional(),
    scope: z.enum(["origin", "url"]).optional(),
    url: z.string().url().max(2000).optional(),
  }),
  z.strictObject({ ...common, type: z.literal("tag_manager"), limit: limit(100) }),
  z.strictObject({ ...common, type: z.literal("data_spend") }),
  // Phase 12 B: stored rank history (free, local) and the competitor keyword gap (paid).
  z.strictObject({ ...common, type: z.literal("rank_trend"), since: z.enum(["90d", "180d", "365d"]).optional(), source: z.enum(["gsc", "serp", "both"]).optional() }),
  z.strictObject({
    ...common,
    type: z.literal("keyword_gap"),
    limit: limit(500),
    competitors: z.array(z.string().min(1).max(253)).min(1).max(5).optional(),
  }),
  // Phase 12 C1: the newest saved local crawl (free, local; never starts a crawl).
  z.strictObject({ ...common, type: z.literal("site_crawl"), limit: limit(50) }),
  // Phase 12 C3: Bing Webmaster Tools for the report period (free with the user's own Bing key).
  z.strictObject({ ...common, type: z.literal("bing_overview"), limit: limit(25) }),
  z.strictObject({ ...common, type: z.literal("text"), text: z.string().min(1).max(2000) }),
] as const;

export const SECTION_TYPES = sectionSchemas.map((s) => s.shape.type.value);
export type SectionType = (typeof sectionSchemas)[number]["shape"]["type"]["value"];

export const SectionSchema = z.discriminatedUnion("type", sectionSchemas);
export type SectionSpec = z.infer<typeof SectionSchema>;

/** Default section titles (a section's own `title` wins). */
export const SECTION_TITLES: Record<SectionType, string> = {
  search_overview: "Search performance",
  branded_split: "Branded vs non-branded",
  organic_traffic: "Organic traffic (GA4)",
  top_queries: "Top queries",
  query_movers: "Query movers",
  page_movers: "Page movers",
  top_pages: "Top pages",
  landing_pages: "Top organic landing pages",
  tracked_keywords: "Tracked keywords",
  opportunities: "Opportunities",
  audit_changes: "Changes since the last audit",
  core_web_vitals_history: "Core Web Vitals history (real users)",
  tag_manager: "Tag Manager findings",
  data_spend: "Paid data spend this month",
  rank_trend: "Tracked keyword rank trends",
  keyword_gap: "Competitor keyword gap",
  site_crawl: "Site crawl",
  bing_overview: "Bing search performance",
  text: "Note",
};

/**
 * Section types that always cost money (Stage B: keyword_gap; Stage C adds local_profile and ai_visibility).
 * `tracked_keywords` is paid only with `liveRanks: true`.
 */
export const PAID_SECTION_TYPES: ReadonlySet<string> = new Set<string>(["keyword_gap"]);

/** True when a section spends money (and so needs `paid: true` in the template and allowPaid at run time). */
export function isPaidSection(s: SectionSpec): boolean {
  return PAID_SECTION_TYPES.has(s.type) || (s.type === "tracked_keywords" && s.liveRanks === true);
}

export const TemplateSchema = z.strictObject({
  title: z.string().min(1).max(120),
  description: z.string().max(300).optional(),
  period: PeriodSchema.optional(),
  compare: z.array(z.enum(COMPARISONS)).max(2).optional(),
  sections: z.array(SectionSchema).min(1).max(40),
});
export type TemplateSpec = z.infer<typeof TemplateSchema>;

export const TemplateFileSchema = z.strictObject({
  version: z.literal(1),
  branding: BrandingSchema.optional(),
  defaults: z.strictObject({ template: id.optional(), formats: z.array(z.enum(FORMATS)).min(1).max(4).optional() }).optional(),
  templates: z.record(id, TemplateSchema).refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 50, "must have 1 to 50 templates"),
});
export type TemplateFile = z.infer<typeof TemplateFileSchema>;

/** A template with its defaults filled in (period last_month, compare both). */
export interface ResolvedTemplateSpec extends TemplateSpec {
  period: Period;
  compare: Comparison[];
}

export function withTemplateDefaults(t: TemplateSpec): ResolvedTemplateSpec {
  return { ...t, period: t.period ?? { range: "last_month" }, compare: t.compare ?? ["previous_period", "previous_year"] };
}

export interface ValidationIssue {
  /** YAML path, e.g. `templates.monthly.sections[3].limit`; empty for the whole file. */
  path: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  /** The parsed file, only when valid. */
  value?: TemplateFile;
}

/** `["templates","monthly","sections",3,"limit"]` → `templates.monthly.sections[3].limit`. */
export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const p of path) {
    if (typeof p === "number") out += `[${p}]`;
    else out += out ? `.${String(p)}` : String(p);
  }
  return out;
}

const DAY_MS = 86_400_000;
const dayOf = (s: string) => Date.parse(`${s}T00:00:00Z`);
const todayUtc = (today: Date) => Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());

/** Checks a custom range (template or run override). Returns problems as messages. */
export function customRangeProblems(start: string, end: string, today: Date): string[] {
  const problems: string[] = [];
  const s = dayOf(start);
  const e = dayOf(end);
  if (s > e) problems.push(`start (${start}) is after end (${end})`);
  else if ((e - s) / DAY_MS + 1 > MAX_SPAN_DAYS) problems.push(`the period spans more than ${MAX_SPAN_DAYS} days`);
  const latest = todayUtc(today) - GSC_LAG_DAYS * DAY_MS;
  if (e > latest) problems.push(`end (${end}) is less than ${GSC_LAG_DAYS} days ago; Search Console data isn't complete yet, so end on ${new Date(latest).toISOString().slice(0, 10)} or earlier`);
  return problems;
}

/** Rules beyond the shape (12.A.2). Pure. */
export function semanticIssues(file: TemplateFile, today: Date): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const push = (path: PropertyKey[], message: string) => issues.push({ path: formatPath(path), message });
  if (file.defaults?.template && !Object.hasOwn(file.templates, file.defaults.template) && file.defaults.template !== "monthly") {
    push(["defaults", "template"], `no template "${file.defaults.template}" in this file (and it isn't the builtin "monthly")`);
  }
  for (const [tid, t] of Object.entries(file.templates)) {
    const base = ["templates", tid];
    if (t.compare && new Set(t.compare).size !== t.compare.length) push([...base, "compare"], "entries must be unique");
    if (t.period?.range === "custom") {
      for (const p of customRangeProblems(t.period.start, t.period.end, today)) push([...base, "period"], p);
    }
    const seen = new Map<string, number>();
    t.sections.forEach((s, i) => {
      const at = [...base, "sections", i];
      const first = seen.get(s.id);
      if (first !== undefined) push([...at, "id"], `duplicate section id "${s.id}" (also sections[${first}])`);
      else seen.set(s.id, i);
      if (s.type === "tag_manager" && s.optional !== true) push([...at, "optional"], "a tag_manager section must set optional: true (Tag Manager findings are opt-in)");
      if (isPaidSection(s) && s.paid !== true) {
        push([...at, "paid"], s.type === "tracked_keywords" ? "liveRanks: true is a paid live SERP check, so the section must set paid: true" : `${s.type} is paid, so the section must set paid: true`);
      }
      if (s.type === "core_web_vitals_history") {
        if (s.scope === "url" && !s.url) push([...at, "url"], "scope: url needs a url");
        if (s.url && s.scope !== "url") push([...at, "url"], "url is only used with scope: url");
      }
    });
  }
  return issues;
}

function zodIssues(error: z.ZodError): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  for (const issue of error.issues) {
    if (issue.code === "unrecognized_keys") {
      for (const k of issue.keys) out.push({ path: formatPath([...issue.path, k]), message: `unknown field "${k}"` });
      continue;
    }
    // A section with an unknown type: name the valid ones.
    if (issue.code === "invalid_union" && "discriminator" in issue && issue.discriminator === "type") {
      out.push({ path: formatPath(issue.path), message: `unknown section type; use one of ${SECTION_TYPES.join(", ")}` });
      continue;
    }
    if (issue.code === "invalid_union" && "discriminator" in issue && issue.discriminator === "range") {
      out.push({ path: formatPath(issue.path), message: "range must be last_month, last_quarter, last_n_days or custom" });
      continue;
    }
    out.push({ path: formatPath(issue.path), message: issue.message });
  }
  return out;
}

export interface ValidateOptions {
  today?: Date;
  /** Resolves a branding.logo path and says whether it exists (warning only). */
  logoExists?: (logo: string) => boolean;
}

/**
 * Parse and validate a template file's text. YAML syntax errors carry line and
 * column; files over 256 KB and alias bombs are refused before any further work.
 */
export function validateTemplateText(text: string, opts: ValidateOptions = {}): ValidationResult {
  const today = opts.today ?? new Date();
  if (Buffer.byteLength(text, "utf8") > MAX_TEMPLATE_BYTES) {
    return { valid: false, errors: [{ path: "", message: `the file is larger than ${MAX_TEMPLATE_BYTES / 1024} KB` }], warnings: [] };
  }
  const doc = parseDocument(text, { prettyErrors: true, uniqueKeys: true });
  if (doc.errors.length) {
    return {
      valid: false,
      errors: doc.errors.map((e) => {
        const pos = e.linePos?.[0];
        return { path: "", message: `YAML ${pos ? `line ${pos.line}, column ${pos.col}` : "error"}: ${e.message.split("\n")[0]!.replace(/ at line \d+, column \d+:?$/, "")}` };
      }),
      warnings: [],
    };
  }
  let raw: unknown;
  try {
    raw = doc.toJS({ maxAliasCount: MAX_ALIAS_COUNT });
  } catch (err) {
    return { valid: false, errors: [{ path: "", message: `YAML: ${(err as Error).message.split("\n")[0]} (at most ${MAX_ALIAS_COUNT} aliases)` }], warnings: [] };
  }
  const parsed = TemplateFileSchema.safeParse(raw);
  if (!parsed.success) return { valid: false, errors: zodIssues(parsed.error), warnings: [] };
  const errors = semanticIssues(parsed.data, today);
  const warnings: ValidationIssue[] = [];
  const logo = parsed.data.branding?.logo;
  if (logo && opts.logoExists && !opts.logoExists(logo)) {
    warnings.push({ path: "branding.logo", message: `${logo} doesn't exist; reports are rendered without a logo until it does` });
  }
  return errors.length ? { valid: false, errors, warnings } : { valid: true, errors: [], warnings, value: parsed.data };
}
